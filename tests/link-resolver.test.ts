import type { CachedMetadata, TAbstractFile, TFile } from "obsidian";
import { describe, expect, test } from "vitest";
import {
    cleanEmbeddedTaskLine,
    DayPlannerLinkResolver,
    type LinkResolutionAdapter,
    renderTaskHtmlFallback,
    renderTaskPlainTextFallback,
} from "../src/link-resolver";
import Parser from "../src/parser";
import { PlanSummaryData } from "../src/plan-data";
import { DayPlannerSettings } from "../src/settings";

function createMockVault(
    files: Record<string, string>,
    caches: Record<string, CachedMetadata> = {},
): LinkResolutionAdapter {
    const fileObjs = new Map<string, TFile>();
    for (const fullPath of Object.keys(files)) {
        const slashIdx = fullPath.lastIndexOf("/");
        const name = slashIdx === -1 ? fullPath : fullPath.slice(slashIdx + 1);
        const dotIdx = name.lastIndexOf(".");
        const basename = dotIdx === -1 ? name : name.slice(0, dotIdx);
        const extension = dotIdx === -1 ? "" : name.slice(dotIdx + 1);
        fileObjs.set(fullPath, {
            path: fullPath,
            name,
            basename,
            extension,
        } as unknown as TFile);
    }

    return {
        metadataCache: {
            getFirstLinkpathDest(linkpath: string, _sourcePath: string) {
                const clean = linkpath.endsWith(".md")
                    ? linkpath.slice(0, -3)
                    : linkpath;
                for (const file of fileObjs.values()) {
                    if (
                        file.path === linkpath ||
                        file.path === `${clean}.md` ||
                        file.basename === clean
                    ) {
                        return file;
                    }
                }
                return null;
            },
            getFileCache(file: TFile) {
                return caches[file.path] ?? null;
            },
        },
        vault: {
            async cachedRead(file: TFile) {
                return files[file.path] ?? "";
            },
            getAbstractFileByPath(targetPath: string): TAbstractFile | null {
                return (fileObjs.get(targetPath) as unknown as TAbstractFile) ?? null;
            },
            getMarkdownFiles() {
                return [...fileObjs.values()].filter(
                    (f) => f.extension === "md",
                );
            },
        },
    };
}

describe("DayPlannerLinkResolver", () => {
    const TODAY_PATH = "notes/quickilynotes/dailynotes/2026-11-01.md";

    test("resolves weekly & daily block embeds without mutating raw item.text on writeback", async () => {
        const todayContent = [
            "# Day Planner",
            "- [ ] 22:35 TODO ![[2026年-44周#^1326d9]] <sup>5m</sup>",
            "- [!] 23:22 TODO ![[2026-10-31#^todo-20261031-b4e9fd]] <sup>15m</sup>",
            "- [x] 23:59 END",
        ].join("\n");

        const adapter = createMockVault({
            [TODAY_PATH]: todayContent,
            "notes/quickilynotes/weekilynotes/2026年-44周.md": [
                "# Weeklynotes",
                "- [ ] 更换呼吸机滤棉 <sup>5m</sup> ^1326d9",
            ].join("\n"),
            "notes/quickilynotes/dailynotes/2026-10-31.md": [
                "# Day Planner",
                "- [!] 23:00 TODO 拿快递-指望快递吃饭 <sup>15m</sup> ^todo-20261031-b4e9fd",
            ].join("\n"),
        });

        const settings = new DayPlannerSettings();
        settings.completePastItems = true;
        settings.preserveValues = "!";
        settings.markCurrent = false;
        const parser = new Parser({ current: () => settings });
        const summary = new PlanSummaryData([], true);

        const now = new Date();
        now.setHours(23, 30, 0, 0);
        const updatedMarkdown = parser.parseContent(
            todayContent,
            summary,
            now,
        );

        const resolver = new DayPlannerLinkResolver(adapter);
        await resolver.resolvePlanSummary(summary, TODAY_PATH);

        // 1. Raw note writeback keeps exact ![[...]] syntax untouched
        expect(updatedMarkdown.split("\n")[1]).toBe(
            "- [x] 22:35 TODO ![[2026年-44周#^1326d9]] <sup>5m</sup>",
        );
        expect(updatedMarkdown.split("\n")[2]).toBe(
            "- [!] 23:22 TODO ![[2026-10-31#^todo-20261031-b4e9fd]] <sup>15m</sup>",
        );

        // 2. Display HTML resolves block text, deduplicates <sup>, and links to source block
        const item0 = summary.items[0];
        expect(item0.displayHtml).toContain("更换呼吸机滤棉</a> <sup>5m</sup>");
        expect(item0.displayHtml).toContain(
            'data-href="notes/quickilynotes/weekilynotes/2026年-44周.md#^1326d9"',
        );
        expect(item0.displayHtml).not.toContain("!2026年-44周");
        expect(item0.displayText).toBe("TODO 更换呼吸机滤棉 5m");

        const item1 = summary.items[1];
        expect(item1.displayHtml).toContain(
            "拿快递-指望快递吃饭</a> <sup>15m</sup>",
        );
        expect(item1.displayHtml).toContain(
            'data-href="notes/quickilynotes/dailynotes/2026-10-31.md#^todo-20261031-b4e9fd"',
        );
        expect(item1.displayText).toBe("TODO 拿快递-指望快递吃饭 15m");
    });

    test("follows multi-hop nested block embeds and guards against cycles", async () => {
        const adapter = createMockVault({
            [TODAY_PATH]: "",
            "notes/quickilynotes/dailynotes/2026-10-31.md":
                "- [!] 23:25 TODO ![[2026-10-30#^hop2]] <sup>10m</sup> ^hop1",
            "notes/quickilynotes/dailynotes/2026-10-30.md":
                "- [?] 21:00 TODO 清洗空调滤网 <sup>10m</sup> ^hop2",
            "notes/cycle-a.md": "- [ ] ![[cycle-b#^cb]] ^ca",
            "notes/cycle-b.md": "- [ ] ![[cycle-a#^ca]] ^cb",
        });

        const resolver = new DayPlannerLinkResolver(adapter);
        const multiHop = await resolver.resolveTaskText(
            "TODO ![[2026-10-31#^hop1]] <sup>10m</sup>",
            TODAY_PATH,
        );
        expect(multiHop.plain).toBe("TODO 清洗空调滤网 10m");
        expect(multiHop.html).toContain(
            'data-href="notes/quickilynotes/dailynotes/2026-10-30.md#^hop2"',
        );
        expect(multiHop.html).toContain(">清洗空调滤网</a> <sup>10m</sup>");

        // Cyclic embeds terminate cleanly without throwing
        const cyclic = await resolver.resolveTaskText(
            "TODO ![[cycle-a#^ca]]",
            TODAY_PATH,
        );
        expect(cyclic.html).toContain("internal-link");
    });

    test("avoids nested <a> tags when resolved block contains markdown or wiki links", async () => {
        const adapter = createMockVault({
            "notes/quickilynotes/weekilynotes/2026年-44周.md":
                "- [ ] ⤵ 2026-10-15 接入：注册 Exa（[控制台](https://dashboard.exa.ai)） <sup>5m</sup> <!-- archived from daily --> ^a55c9c",
        });

        const resolver = new DayPlannerLinkResolver(adapter);
        const res = await resolver.resolveTaskText(
            "TODO ![[2026年-44周#^a55c9c]] <sup>5m</sup>",
            TODAY_PATH,
        );

        expect(res.html).toContain(
            '<a class="external-link" href="https://dashboard.exa.ai" target="_blank" rel="noopener noreferrer">控制台</a>',
        );
        expect(res.html).toContain("day-planner-embed-badge");
        // Ensure no nested <a ... <a
        expect(res.html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>).)*<a\b/);
        expect(res.plain).toBe("TODO 接入：注册 Exa（控制台） 5m");
    });

    test("resolves parent task line when block anchor sits on STARTED audit line", async () => {
        const adapter = createMockVault({
            "notes/quickilynotes/dailynotes/2026-10-31.md": [
                "- [/] 20:35 DOING 阅读小说 <sup>30m</sup>",
                "  STARTED: [2026-10-31 Sat 20:35:00] ^todo-started-line",
            ].join("\n"),
        });

        const resolver = new DayPlannerLinkResolver(adapter);
        const res = await resolver.resolveTaskText(
            "TODO ![[2026-10-31#^todo-started-line]] <sup>30m</sup>",
            TODAY_PATH,
        );
        expect(res.plain).toBe("TODO 阅读小说 30m");
    });

    test("renders standard wikilinks, block wikilinks without alias, and internal/external markdown links", async () => {
        const adapter = createMockVault({
            "notes/quickilynotes/zettelkasten/202601170040 脑洞合集.md":
                "# 脑洞合集\n灵感记录",
            "notes/quickilynotes/monthilynotes/2026年-第11月.md":
                "# 11月目标\n减重",
            "notes/quickilynotes/dailynotes/2026-10-31.md":
                "- [!] 23:00 TODO 记账支付宝 <sup>3m</sup> ^todo-5d6853",
        });

        const resolver = new DayPlannerLinkResolver(adapter);

        // Internal URL-encoded markdown link
        const mdInternal = await resolver.resolveTaskText(
            "TODO Dangerous Mode 写作网文 50字 [脑洞合集](202601170040%20脑洞合集.md) <sup>12m</sup>",
            TODAY_PATH,
        );
        expect(mdInternal.html).toContain(
            'class="internal-link" data-href="notes/quickilynotes/zettelkasten/202601170040 脑洞合集.md"',
        );
        expect(mdInternal.html).toContain(">脑洞合集</a>");
        expect(mdInternal.plain).toBe(
            "TODO Dangerous Mode 写作网文 50字 脑洞合集 12m",
        );

        // Relative path markdown link
        const mdRelative = await resolver.resolveTaskText(
            "完成月待办 [11月](../monthilynotes/2026年-第11月.md)",
            TODAY_PATH,
        );
        expect(mdRelative.html).toContain(
            'data-href="notes/quickilynotes/monthilynotes/2026年-第11月.md"',
        );

        // Standard wikilinks (with & without alias, and block wikilink without !)
        const wikiRes = await resolver.resolveTaskText(
            "复盘 [[notes/quickilynotes/zettelkasten/202601170040 脑洞合集|脑洞]] 与 [[2026-10-31#^todo-5d6853]] 及 [[不存在的笔记]]",
            TODAY_PATH,
        );
        expect(wikiRes.html).toContain(">脑洞</a>");
        expect(wikiRes.html).toContain(">记账支付宝 <sup>3m</sup></a>");
        expect(wikiRes.html).toContain("is-unresolved");
    });

    test("protects link href underscores from italic formatting and escapes unsafe HTML", async () => {
        const adapter = createMockVault({
            "notes/task_one.md": "# Task One",
            "notes/task_two.md": "# Task Two",
        });
        const resolver = new DayPlannerLinkResolver(adapter);
        const res = await resolver.resolveTaskText(
            "Compare [[notes/task_one|one]] and [[notes/task_two|two]] <script>alert(1)</script> ≤600 < 700 <sup>5m</sup>",
            TODAY_PATH,
        );

        expect(res.html).toContain('data-href="notes/task_one.md"');
        expect(res.html).toContain('data-href="notes/task_two.md"');
        expect(res.html).not.toContain("<script>");
        expect(res.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(res.html).toContain("&lt; 700 <sup>5m</sup>");
    });

    test("resolves heading embeds, whole-note embeds, and fallback helpers", async () => {
        const adapter = createMockVault({
            "notes/project.md": [
                "---",
                "tags: [project]",
                "---",
                "# 项目总览",
                "## 核心里程碑",
                "- [ ] 发布 v1.2.0 <sup>20m</sup>",
            ].join("\n"),
        });

        const resolver = new DayPlannerLinkResolver(adapter);
        const headingEmbed = await resolver.resolveTaskText(
            "TODO ![[project#核心里程碑]]",
            TODAY_PATH,
        );
        expect(headingEmbed.plain).toBe("TODO 发布 v1.2.0 20m");

        const wholeNoteEmbed = await resolver.resolveTaskText(
            "阅读 ![[project]]",
            TODAY_PATH,
        );
        expect(wholeNoteEmbed.plain).toBe("阅读 项目总览");

        expect(
            cleanEmbeddedTaskLine(
                "- [x] 02:31 -14:56 <sub>3m</sub> DONE Get up,Brush teeth. <sup>3m</sup> ^abc",
            ),
        ).toBe("Get up,Brush teeth. <sup>3m</sup>");

        expect(renderTaskHtmlFallback("查看 [[20201103]]")).toContain(
            'class="internal-link" data-href="20201103"',
        );
        expect(
            renderTaskPlainTextFallback(
                "TODO [[notes/foo|别名]] <sup>5m</sup>",
            ),
        ).toBe("TODO 别名 5m");
    });
});
