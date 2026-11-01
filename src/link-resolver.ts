import {
    type CachedMetadata,
    normalizePath,
    type TAbstractFile,
    type TFile,
} from "obsidian";
import Logger from "./logger";
import type { PlanSummaryData } from "./plan-data";

const MAX_EMBED_DEPTH = 10;

const EMBED_WIKILINK_REGEX = /!\[\[([^\]]+)\]\]/g;
const WIKILINK_REGEX = /(?<!!)\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_REGEX = /(!?)\[([^\]]+)\]\(([^)]+)\)/g;
const INLINE_CODE_REGEX = /`([^`]+)`/g;
const SAFE_INLINE_TAG_REGEX = /<(sup|sub|mark)>([\s\S]*?)<\/\1>/gi;
const BOLD_REGEX = /__(\S(?:.*?\S)?)__|\*\*(\S(?:.*?\S)?)\*\*/g;
const ITALIC_REGEX = /_(\S(?:.*?\S)?)_|\*(\S(?:.*?\S)?)\*/g;
const HIGHLIGHT_REGEX = /==(\S(?:.*?\S)?)==/g;
const EXTERNAL_URI_REGEX =
    /^(?:https?:|mailto:|tel:|obsidian:|file:|zotero:|anki:|\/\/)/i;
const TRAILING_SUP_REGEX = /\s*<sup>[\s\S]*?<\/sup>\s*$/i;
const CONTAINS_LINK_SYNTAX_REGEX = /!?\[\[[^\]]+\]\]|!?\[[^\]]+\]\([^)]+\)/;

export interface LinkResolutionAdapter {
    metadataCache: {
        getFirstLinkpathDest(
            linkpath: string,
            sourcePath: string,
        ): TFile | null;
        getFileCache(file: TFile): CachedMetadata | null;
    };
    vault: {
        cachedRead(file: TFile): Promise<string>;
        getAbstractFileByPath(path: string): TAbstractFile | null;
        getMarkdownFiles?(): TFile[];
    };
}

interface ParsedWikiTarget {
    path: string;
    subpath: string;
    alias?: string;
}

interface ResolvedEmbedResult {
    text: string;
    href: string;
    resolved: boolean;
}

function isVaultFile(file: TAbstractFile | null | undefined): file is TFile {
    return (
        file !== null &&
        file !== undefined &&
        "extension" in file &&
        typeof (file as { extension?: unknown }).extension === "string"
    );
}

export function escapeHtml(input: string): string {
    return input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function dirnameOf(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    return idx === -1 ? "" : filePath.slice(0, idx);
}

function basenameOfLinkpath(linkpath: string): string {
    const trimmed = linkpath.replace(/\/+$/, "");
    const slashIdx = trimmed.lastIndexOf("/");
    const base = slashIdx === -1 ? trimmed : trimmed.slice(slashIdx + 1);
    return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function resolveRelativePath(rawPath: string, sourcePath: string): string {
    if (!rawPath.startsWith("./") && !rawPath.startsWith("../")) {
        return rawPath;
    }
    const baseParts = dirnameOf(sourcePath)
        .split("/")
        .filter((part) => part.length > 0);
    for (const segment of rawPath.split("/")) {
        if (!segment || segment === ".") {
            continue;
        }
        if (segment === "..") {
            baseParts.pop();
        } else {
            baseParts.push(segment);
        }
    }
    return normalizePath(baseParts.join("/"));
}

export function parseWikiLinkInner(inner: string): ParsedWikiTarget {
    const normalized = inner.replace(/\\\|/g, "|");
    const pipeIdx = normalized.indexOf("|");
    const rawTarget =
        pipeIdx === -1
            ? normalized.trim()
            : normalized.slice(0, pipeIdx).trim();
    const rawAlias =
        pipeIdx === -1 ? undefined : normalized.slice(pipeIdx + 1).trim();

    const hashIdx = rawTarget.indexOf("#");
    const path =
        hashIdx === -1 ? rawTarget : rawTarget.slice(0, hashIdx).trim();
    const subpath = hashIdx === -1 ? "" : rawTarget.slice(hashIdx).trim();

    return {
        path,
        subpath,
        alias: rawAlias && rawAlias.length > 0 ? rawAlias : undefined,
    };
}

function formatWikiDisplayFallback(parsed: ParsedWikiTarget): string {
    if (parsed.alias) {
        return parsed.alias;
    }
    if (parsed.subpath.startsWith("#^")) {
        return parsed.path
            ? `${basenameOfLinkpath(parsed.path)}${parsed.subpath}`
            : parsed.subpath;
    }
    if (parsed.subpath.startsWith("#")) {
        const heading = parsed.subpath.slice(1).trim();
        if (!parsed.path) {
            return heading || parsed.subpath;
        }
        return heading
            ? `${basenameOfLinkpath(parsed.path)} › ${heading}`
            : basenameOfLinkpath(parsed.path);
    }
    return parsed.path ? basenameOfLinkpath(parsed.path) : "";
}

export function cleanEmbeddedTaskLine(rawLine: string): string {
    let cleaned = rawLine
        // Strip HTML comments (e.g. <!-- archived from daily -->)
        .replace(/<!--[\s\S]*?-->/g, "")
        // Strip trailing Obsidian block anchors (including accidental duplicates)
        .replace(/(?:\s+\^[A-Za-z0-9-]+)+\s*$/, "")
        .trim();

    // Strip leading blockquote, list bullet/number, and checkbox marker
    cleaned = cleaned.replace(
        /^\s*(?:>\s*)*(?:(?:[-*+]|\d+\.)\s+)?(?:\[.\]\s+)?/,
        "",
    );

    // Strip weekly note rollover prefix (e.g. "⤵ 2026-10-30 ")
    cleaned = cleaned.replace(/^⤵\s*(?:\d{4}-\d{2}-\d{2}\s+)?/, "");

    // Strip historical Day Planner time / actual duration / status word prefix
    cleaned = cleaned.replace(
        /^(?:(?:TODO|DOING|DONE)\s+)?(?:\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?\s+)?(?:<sub>[\s\S]*?<\/sub>\s+)?(?:(?:TODO|DOING|DONE)\s+)?/i,
        "",
    );

    return cleaned.trim();
}

function isAuditMetadataLine(line: string): boolean {
    return /^\s*(?:STARTED|CLOSED):\s*\[/i.test(line);
}

function extractBlockLineFromContent(
    content: string,
    blockId: string,
    cache: CachedMetadata | null,
): string | null {
    const lines = content.split(/\r?\n/);
    const cachedBlock =
        cache?.blocks?.[blockId] ?? cache?.blocks?.[blockId.toLowerCase()];

    if (cachedBlock) {
        const startLine = Math.max(0, cachedBlock.position.start.line);
        const endLine = Math.min(
            lines.length - 1,
            cachedBlock.position.end.line,
        );
        for (let i = startLine; i <= endLine; i++) {
            const candidate = lines[i];
            if (
                candidate &&
                candidate.trim().length > 0 &&
                !isAuditMetadataLine(candidate)
            ) {
                return cleanEmbeddedTaskLine(candidate);
            }
        }
    }

    const anchorRegex = new RegExp(
        `(?:^|\\s)\\^${escapeRegExp(blockId)}(?=\\s|$)`,
        "i",
    );
    for (let i = 0; i < lines.length; i++) {
        if (!anchorRegex.test(lines[i])) {
            continue;
        }
        if (isAuditMetadataLine(lines[i])) {
            for (let up = i - 1; up >= 0; up--) {
                const parent = lines[up];
                if (!parent || parent.trim().length === 0) {
                    break;
                }
                if (!isAuditMetadataLine(parent)) {
                    return cleanEmbeddedTaskLine(parent);
                }
            }
        }
        return cleanEmbeddedTaskLine(lines[i]);
    }

    return null;
}

function extractHeadingSummaryFromContent(
    content: string,
    headingRaw: string,
    fileBasename: string,
): string {
    const headingTarget = headingRaw.trim().toLowerCase();
    const lines = content.split(/\r?\n/);
    let inSection = false;
    let sectionLevel = 0;

    for (const line of lines) {
        const headingMatch = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const title = headingMatch[2]
                .replace(/(?:\s+\^[A-Za-z0-9-]+)+\s*$/, "")
                .trim();
            if (!inSection && title.toLowerCase() === headingTarget) {
                inSection = true;
                sectionLevel = level;
                continue;
            }
            if (inSection && level <= sectionLevel) {
                break;
            }
        }
        if (inSection) {
            const trimmed = line.trim();
            if (trimmed.length === 0 || isAuditMetadataLine(trimmed)) {
                continue;
            }
            const cleaned = cleanEmbeddedTaskLine(trimmed);
            if (cleaned.length > 0) {
                return cleaned;
            }
        }
    }

    return headingRaw.trim()
        ? `${fileBasename} › ${headingRaw.trim()}`
        : fileBasename;
}

function extractWholeNoteSummary(
    content: string,
    fileBasename: string,
): string {
    const withoutFrontmatter = content.replace(
        /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
        "",
    );
    const lines = withoutFrontmatter.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || isAuditMetadataLine(trimmed)) {
            continue;
        }
        const headingMatch = /^#{1,6}\s+(.*?)\s*$/.exec(trimmed);
        if (headingMatch) {
            return headingMatch[1].trim() || fileBasename;
        }
        const cleaned = cleanEmbeddedTaskLine(trimmed);
        if (cleaned.length > 0) {
            return cleaned;
        }
    }
    return fileBasename;
}

function formatRichInlineSegment(text: string): string {
    const tokens: string[] = [];
    const pushToken = (html: string): string => {
        const id = `\uE000DPOG${tokens.length}\uE000`;
        tokens.push(html);
        return id;
    };

    // Preserve inline code spans verbatim before HTML escaping
    const withCodeTokens = text.replace(INLINE_CODE_REGEX, (_m, code: string) =>
        pushToken(`<code>${escapeHtml(code)}</code>`),
    );

    // Preserve safe inline HTML tags (<sup>, <sub>, <mark>) while escaping raw text
    const withSafeTagTokens = withCodeTokens.replace(
        SAFE_INLINE_TAG_REGEX,
        (_m, tag: string, inner: string) => {
            const lowerTag = tag.toLowerCase();
            return pushToken(`<${lowerTag}>${escapeHtml(inner)}</${lowerTag}>`);
        },
    );

    let formatted = escapeHtml(withSafeTagTokens);
    formatted = formatted
        .replace(
            BOLD_REGEX,
            (_m, g1: string, g2: string) => `<strong>${g1 || g2}</strong>`,
        )
        .replace(
            ITALIC_REGEX,
            (_m, g1: string, g2: string) => `<em>${g1 || g2}</em>`,
        )
        .replace(HIGHLIGHT_REGEX, "<mark>$1</mark>");

    return formatted.replace(/\uE000DPOG(\d+)\uE000/g, (_m, idxStr: string) => {
        const idx = Number.parseInt(idxStr, 10);
        return tokens[idx] ?? "";
    });
}

function buildInternalLinkHtml(
    href: string,
    sourcePath: string,
    labelHtml: string,
    extraClasses: string[] = [],
    title?: string,
): string {
    const classes = ["internal-link", ...extraClasses].join(" ");
    const sourceAttr = sourcePath
        ? ` data-source-path="${escapeHtml(sourcePath)}"`
        : "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a class="${classes}" data-href="${escapeHtml(href)}"${sourceAttr} href="${escapeHtml(href)}"${titleAttr}>${labelHtml}</a>`;
}

function buildExternalLinkHtml(href: string, labelHtml: string): string {
    return `<a class="external-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
}

function normalizePlainSpacing(text: string): string {
    return text
        .replace(/<(?:sup|sub|mark)>([\s\S]*?)<\/(?:sup|sub|mark)>/gi, " $1 ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/__(\S(?:.*?\S)?)__|\*\*(\S(?:.*?\S)?)\*\*/g, "$1$2")
        .replace(/_(\S(?:.*?\S)?)_|\*(\S(?:.*?\S)?)\*/g, "$1$2")
        .replace(/==(\S(?:.*?\S)?)==/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

function stripNestedLinksKeepSafeTags(text: string): string {
    return text
        .replace(EMBED_WIKILINK_REGEX, (_m, inner: string) =>
            formatWikiDisplayFallback(parseWikiLinkInner(inner)),
        )
        .replace(WIKILINK_REGEX, (_m, inner: string) =>
            formatWikiDisplayFallback(parseWikiLinkInner(inner)),
        )
        .replace(
            MARKDOWN_LINK_REGEX,
            (_m, _bang: string, label: string) => label,
        );
}

export function renderTaskHtmlFallback(
    rawText: string,
    sourcePath = "",
): string {
    const text = rawText ?? "";
    const anchors: string[] = [];
    const pushAnchor = (html: string): string => {
        const token = `\uE000DPOGLINK${anchors.length}\uE000`;
        anchors.push(html);
        return token;
    };

    const stepEmbeds = text.replace(
        EMBED_WIKILINK_REGEX,
        (_m, inner: string) => {
            const parsed = parseWikiLinkInner(inner);
            const href = `${parsed.path}${parsed.subpath}`;
            const label = formatWikiDisplayFallback(parsed);
            return pushAnchor(
                buildInternalLinkHtml(
                    href,
                    sourcePath,
                    formatRichInlineSegment(label),
                    ["day-planner-embed-link"],
                ),
            );
        },
    );

    const stepWiki = stepEmbeds.replace(WIKILINK_REGEX, (_m, inner: string) => {
        const parsed = parseWikiLinkInner(inner);
        const href = `${parsed.path}${parsed.subpath}`;
        const label = formatWikiDisplayFallback(parsed);
        return pushAnchor(
            buildInternalLinkHtml(
                href,
                sourcePath,
                formatRichInlineSegment(label),
            ),
        );
    });

    const stepMarkdown = stepWiki.replace(
        MARKDOWN_LINK_REGEX,
        (_m, bang: string, label: string, rawDest: string) => {
            const dest = rawDest.trim();
            const displayLabel = bang ? `🖼 ${label}` : label;
            if (EXTERNAL_URI_REGEX.test(dest)) {
                return pushAnchor(
                    buildExternalLinkHtml(
                        dest,
                        formatRichInlineSegment(displayLabel),
                    ),
                );
            }
            const decoded = resolveRelativePath(
                safeDecodeURIComponent(dest),
                sourcePath,
            );
            return pushAnchor(
                buildInternalLinkHtml(
                    decoded,
                    sourcePath,
                    formatRichInlineSegment(displayLabel),
                ),
            );
        },
    );

    const formatted = formatRichInlineSegment(stepMarkdown);
    return formatted.replace(
        /\uE000DPOGLINK(\d+)\uE000/g,
        (_m, idxStr: string) => {
            const idx = Number.parseInt(idxStr, 10);
            return anchors[idx] ?? "";
        },
    );
}

export function renderTaskPlainTextFallback(rawText: string): string {
    const text = rawText ?? "";
    const withoutLinks = text
        .replace(EMBED_WIKILINK_REGEX, (_m, inner: string) =>
            formatWikiDisplayFallback(parseWikiLinkInner(inner)),
        )
        .replace(WIKILINK_REGEX, (_m, inner: string) =>
            formatWikiDisplayFallback(parseWikiLinkInner(inner)),
        )
        .replace(
            MARKDOWN_LINK_REGEX,
            (_m, _bang: string, label: string) => label,
        );
    return normalizePlainSpacing(withoutLinks);
}

export class DayPlannerLinkResolver {
    private adapter: LinkResolutionAdapter;

    constructor(adapter: LinkResolutionAdapter) {
        this.adapter = adapter;
    }

    async resolvePlanSummary(
        summary: PlanSummaryData,
        sourcePath: string,
    ): Promise<void> {
        summary.sourcePath = sourcePath;
        if (summary.items.length === 0) {
            return;
        }

        const contentMemo = new Map<string, string>();
        for (const item of summary.items) {
            try {
                const { html, plain } = await this.resolveTaskText(
                    item.text ?? "",
                    sourcePath,
                    contentMemo,
                );
                item.displayHtml = html;
                item.displayText = plain;
            } catch (error) {
                Logger.getInstance().logError(
                    "error resolving links in plan item",
                    item.text,
                    error,
                );
                item.displayHtml = renderTaskHtmlFallback(
                    item.text ?? "",
                    sourcePath,
                );
                item.displayText = renderTaskPlainTextFallback(item.text ?? "");
            }
        }
    }

    private findTargetFile(linkpath: string, sourcePath: string): TFile | null {
        if (!linkpath) {
            const selfFile = sourcePath
                ? this.adapter.vault.getAbstractFileByPath(
                      normalizePath(sourcePath),
                  )
                : null;
            return isVaultFile(selfFile) ? selfFile : null;
        }

        const resolvedLinkpath = resolveRelativePath(linkpath, sourcePath);
        const viaCache = this.adapter.metadataCache.getFirstLinkpathDest(
            resolvedLinkpath,
            sourcePath,
        );
        if (viaCache) {
            return viaCache;
        }

        // Fallback when Vault indexing is still initializing
        const directCandidates = [
            normalizePath(resolvedLinkpath),
            normalizePath(`${resolvedLinkpath}.md`),
        ];
        for (const candidate of directCandidates) {
            const found = this.adapter.vault.getAbstractFileByPath(candidate);
            if (isVaultFile(found)) {
                return found;
            }
        }

        const markdownFiles = this.adapter.vault.getMarkdownFiles?.() ?? [];
        const wantedBasename = basenameOfLinkpath(resolvedLinkpath);
        for (const mdFile of markdownFiles) {
            if (
                mdFile.path === resolvedLinkpath ||
                mdFile.path === `${resolvedLinkpath}.md` ||
                mdFile.basename === wantedBasename
            ) {
                return mdFile;
            }
        }

        return null;
    }

    private async readCachedContent(
        file: TFile,
        contentMemo: Map<string, string>,
    ): Promise<string> {
        const existing = contentMemo.get(file.path);
        if (existing !== undefined) {
            return existing;
        }
        const content = await this.adapter.vault.cachedRead(file);
        contentMemo.set(file.path, content);
        return content;
    }

    private async resolveEmbedTarget(
        parsed: ParsedWikiTarget,
        sourcePath: string,
        contentMemo: Map<string, string>,
        visited: Set<string>,
        depth: number,
    ): Promise<ResolvedEmbedResult> {
        const fallbackHref = `${parsed.path}${parsed.subpath}`;
        const fallbackLabel = formatWikiDisplayFallback(parsed);

        if (parsed.alias) {
            const targetFile = this.findTargetFile(parsed.path, sourcePath);
            const href = targetFile
                ? `${targetFile.path}${parsed.subpath}`
                : fallbackHref;
            return {
                text: parsed.alias,
                href,
                resolved: targetFile !== null,
            };
        }

        const targetFile = this.findTargetFile(parsed.path, sourcePath);
        if (!targetFile) {
            return {
                text: fallbackLabel,
                href: fallbackHref,
                resolved: false,
            };
        }

        const canonicalHref = `${targetFile.path}${parsed.subpath}`;
        if (targetFile.extension.toLowerCase() !== "md") {
            return {
                text: `📎 ${targetFile.basename}.${targetFile.extension}`,
                href: canonicalHref,
                resolved: true,
            };
        }

        const visitKey = `${targetFile.path}::${parsed.subpath.toLowerCase()}`;
        if (visited.has(visitKey) || depth >= MAX_EMBED_DEPTH) {
            return {
                text: fallbackLabel,
                href: canonicalHref,
                resolved: true,
            };
        }

        const nextVisited = new Set(visited);
        nextVisited.add(visitKey);

        const content = await this.readCachedContent(targetFile, contentMemo);
        const cache = this.adapter.metadataCache.getFileCache(targetFile);

        let extracted: string | null = null;
        if (parsed.subpath.startsWith("#^")) {
            const blockId = parsed.subpath.slice(2).trim();
            extracted = extractBlockLineFromContent(content, blockId, cache);
            if (!extracted) {
                return {
                    text: fallbackLabel,
                    href: canonicalHref,
                    resolved: false,
                };
            }
        } else if (parsed.subpath.startsWith("#")) {
            extracted = extractHeadingSummaryFromContent(
                content,
                parsed.subpath.slice(1),
                targetFile.basename,
            );
        } else {
            extracted = extractWholeNoteSummary(content, targetFile.basename);
        }

        // Follow multi-hop nested block/note embeds (e.g. today -> yesterday -> 2 days ago)
        const embedMatches = [...extracted.matchAll(EMBED_WIKILINK_REGEX)];
        if (embedMatches.length === 0) {
            return {
                text: extracted,
                href: canonicalHref,
                resolved: true,
            };
        }

        const outerWithoutEmbeds = extracted.replace(EMBED_WIKILINK_REGEX, "");
        const outerHasSup = /<sup>[\s\S]*?<\/sup>/i.test(outerWithoutEmbeds);
        let ultimateHref = canonicalHref;
        let resolvedText = "";
        let cursor = 0;

        for (const match of embedMatches) {
            const matchIdx = match.index ?? 0;
            resolvedText += extracted.slice(cursor, matchIdx);
            const innerParsed = parseWikiLinkInner(match[1]);
            const nested = await this.resolveEmbedTarget(
                innerParsed,
                targetFile.path,
                contentMemo,
                nextVisited,
                depth + 1,
            );
            const nestedText = outerHasSup
                ? nested.text.replace(TRAILING_SUP_REGEX, "")
                : nested.text;
            resolvedText += nestedText;
            if (embedMatches.length === 1 && outerWithoutEmbeds.trim() === "") {
                ultimateHref = nested.href;
            } else if (
                embedMatches.length === 1 &&
                outerWithoutEmbeds.replace(TRAILING_SUP_REGEX, "").trim() === ""
            ) {
                ultimateHref = nested.href;
            }
            cursor = matchIdx + match[0].length;
        }
        resolvedText += extracted.slice(cursor);

        return {
            text: resolvedText.trim(),
            href: ultimateHref,
            resolved: true,
        };
    }

    async resolveTaskText(
        rawText: string,
        sourcePath: string,
        contentMemo: Map<string, string> = new Map(),
    ): Promise<{ html: string; plain: string }> {
        const anchors: string[] = [];
        const pushAnchor = (html: string): string => {
            const token = `\uE000DPOGLINK${anchors.length}\uE000`;
            anchors.push(html);
            return token;
        };

        const outerWithoutEmbeds = rawText.replace(EMBED_WIKILINK_REGEX, "");
        const outerHasSup = /<sup>[\s\S]*?<\/sup>/i.test(outerWithoutEmbeds);

        // 1. Resolve ![[...]] embeds asynchronously
        const embedMatches = [...rawText.matchAll(EMBED_WIKILINK_REGEX)];
        let afterEmbedsHtml = "";
        let afterEmbedsPlain = "";
        let cursor = 0;

        for (const match of embedMatches) {
            const matchIdx = match.index ?? 0;
            const prefix = rawText.slice(cursor, matchIdx);
            afterEmbedsHtml += prefix;
            afterEmbedsPlain += prefix;

            const parsed = parseWikiLinkInner(match[1]);
            const resolvedEmbed = await this.resolveEmbedTarget(
                parsed,
                sourcePath,
                contentMemo,
                new Set(),
                0,
            );

            let embedBody = resolvedEmbed.text;
            let trailingSupHtml = "";
            if (outerHasSup) {
                embedBody = embedBody.replace(TRAILING_SUP_REGEX, "");
            } else {
                const supMatch = TRAILING_SUP_REGEX.exec(embedBody);
                if (supMatch) {
                    trailingSupHtml = ` ${formatRichInlineSegment(supMatch[0].trim())}`;
                    embedBody = embedBody.slice(0, supMatch.index).trim();
                }
            }

            const unresolvedClasses = resolvedEmbed.resolved
                ? []
                : ["is-unresolved"];

            if (CONTAINS_LINK_SYNTAX_REGEX.test(embedBody)) {
                // Avoid invalid nested <a> tags when resolved block itself contains links
                const innerResolved = await this.resolveNonEmbedLinks(
                    embedBody,
                    sourcePath,
                    contentMemo,
                    pushAnchor,
                );
                const badgeAnchor = pushAnchor(
                    buildInternalLinkHtml(
                        resolvedEmbed.href,
                        sourcePath,
                        "↗",
                        ["day-planner-embed-badge", ...unresolvedClasses],
                        `${parsed.path}${parsed.subpath}`,
                    ),
                );
                afterEmbedsHtml += `${innerResolved.htmlTokenized} ${badgeAnchor}${trailingSupHtml}`;
                afterEmbedsPlain += innerResolved.plain;
            } else {
                const labelHtml = formatRichInlineSegment(embedBody);
                const linkToken = pushAnchor(
                    buildInternalLinkHtml(
                        resolvedEmbed.href,
                        sourcePath,
                        labelHtml,
                        ["day-planner-embed-link", ...unresolvedClasses],
                        `${parsed.path}${parsed.subpath}`,
                    ),
                );
                afterEmbedsHtml += `${linkToken}${trailingSupHtml}`;
                afterEmbedsPlain += outerHasSup
                    ? embedBody
                    : resolvedEmbed.text;
            }

            cursor = matchIdx + match[0].length;
        }
        afterEmbedsHtml += rawText.slice(cursor);
        afterEmbedsPlain += rawText.slice(cursor);

        // 2. Resolve standard [[...]] wikilinks and [label](url) markdown links
        const finalLinks = await this.resolveNonEmbedLinks(
            afterEmbedsHtml,
            sourcePath,
            contentMemo,
            pushAnchor,
        );
        const plainResolved = await this.resolveNonEmbedPlain(
            afterEmbedsPlain,
            sourcePath,
            contentMemo,
        );

        const formattedHtml = formatRichInlineSegment(
            finalLinks.htmlTokenized,
        ).replace(/\uE000DPOGLINK(\d+)\uE000/g, (_m, idxStr: string) => {
            const idx = Number.parseInt(idxStr, 10);
            return anchors[idx] ?? "";
        });

        return {
            html: formattedHtml,
            plain: normalizePlainSpacing(plainResolved),
        };
    }

    private async resolveWikiLinkLabelAndHref(
        parsed: ParsedWikiTarget,
        sourcePath: string,
        contentMemo: Map<string, string>,
        stripSup: boolean,
    ): Promise<{ label: string; href: string; resolved: boolean }> {
        const targetFile = this.findTargetFile(parsed.path, sourcePath);
        const href = targetFile
            ? `${targetFile.path}${parsed.subpath}`
            : `${parsed.path}${parsed.subpath}`;

        if (parsed.alias) {
            return {
                label: parsed.alias,
                href,
                resolved: targetFile !== null,
            };
        }

        // Resolve [[note#^block]] without alias to the referenced block's readable text
        if (
            targetFile &&
            targetFile.extension.toLowerCase() === "md" &&
            parsed.subpath.startsWith("#^")
        ) {
            const blockRes = await this.resolveEmbedTarget(
                parsed,
                sourcePath,
                contentMemo,
                new Set(),
                0,
            );
            if (blockRes.resolved) {
                const rawLabel = stripSup
                    ? blockRes.text.replace(TRAILING_SUP_REGEX, "")
                    : blockRes.text;
                return {
                    label: stripNestedLinksKeepSafeTags(rawLabel),
                    href: blockRes.href,
                    resolved: true,
                };
            }
        }

        return {
            label: formatWikiDisplayFallback(parsed),
            href,
            resolved: targetFile !== null,
        };
    }

    private async resolveNonEmbedLinks(
        input: string,
        sourcePath: string,
        contentMemo: Map<string, string>,
        pushAnchor: (html: string) => string,
    ): Promise<{ htmlTokenized: string; plain: string }> {
        const outerHasSup = /<sup>[\s\S]*?<\/sup>/i.test(
            input.replace(WIKILINK_REGEX, ""),
        );

        const wikiMatches = [...input.matchAll(WIKILINK_REGEX)];
        let afterWiki = "";
        let plainAcc = "";
        let cursor = 0;

        for (const match of wikiMatches) {
            const matchIdx = match.index ?? 0;
            const seg = input.slice(cursor, matchIdx);
            afterWiki += seg;
            plainAcc += seg;

            const parsed = parseWikiLinkInner(match[1]);
            const resolved = await this.resolveWikiLinkLabelAndHref(
                parsed,
                sourcePath,
                contentMemo,
                outerHasSup,
            );
            const extraClasses = resolved.resolved ? [] : ["is-unresolved"];
            afterWiki += pushAnchor(
                buildInternalLinkHtml(
                    resolved.href,
                    sourcePath,
                    formatRichInlineSegment(resolved.label),
                    extraClasses,
                ),
            );
            plainAcc += resolved.label;
            cursor = matchIdx + match[0].length;
        }
        const tail = input.slice(cursor);
        afterWiki += tail;
        plainAcc += tail;

        const htmlTokenized = afterWiki.replace(
            MARKDOWN_LINK_REGEX,
            (_m, bang: string, label: string, rawDest: string) => {
                const dest = rawDest.trim();
                const displayLabel = bang ? `🖼 ${label}` : label;
                if (EXTERNAL_URI_REGEX.test(dest)) {
                    return pushAnchor(
                        buildExternalLinkHtml(
                            dest,
                            formatRichInlineSegment(displayLabel),
                        ),
                    );
                }
                const decoded = safeDecodeURIComponent(dest);
                const hashIdx = decoded.indexOf("#");
                const linkPathOnly =
                    hashIdx === -1 ? decoded : decoded.slice(0, hashIdx);
                const subpath = hashIdx === -1 ? "" : decoded.slice(hashIdx);
                const targetFile = this.findTargetFile(
                    linkPathOnly,
                    sourcePath,
                );
                const resolvedHref = targetFile
                    ? `${targetFile.path}${subpath}`
                    : `${resolveRelativePath(linkPathOnly, sourcePath)}${subpath}`;
                const extraClasses = targetFile ? [] : ["is-unresolved"];
                return pushAnchor(
                    buildInternalLinkHtml(
                        resolvedHref,
                        sourcePath,
                        formatRichInlineSegment(displayLabel),
                        extraClasses,
                    ),
                );
            },
        );

        const plain = plainAcc.replace(
            MARKDOWN_LINK_REGEX,
            (_m, _bang: string, label: string) => label,
        );

        return { htmlTokenized, plain };
    }

    private async resolveNonEmbedPlain(
        input: string,
        sourcePath: string,
        contentMemo: Map<string, string>,
    ): Promise<string> {
        const outerHasSup = /<sup>[\s\S]*?<\/sup>/i.test(
            input.replace(WIKILINK_REGEX, ""),
        );
        const wikiMatches = [...input.matchAll(WIKILINK_REGEX)];
        let afterWiki = "";
        let cursor = 0;

        for (const match of wikiMatches) {
            const matchIdx = match.index ?? 0;
            afterWiki += input.slice(cursor, matchIdx);
            const parsed = parseWikiLinkInner(match[1]);
            const resolved = await this.resolveWikiLinkLabelAndHref(
                parsed,
                sourcePath,
                contentMemo,
                outerHasSup,
            );
            afterWiki += resolved.label;
            cursor = matchIdx + match[0].length;
        }
        afterWiki += input.slice(cursor);

        return afterWiki.replace(
            MARKDOWN_LINK_REGEX,
            (_m, _bang: string, label: string) => label,
        );
    }
}
