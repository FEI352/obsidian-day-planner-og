# FEI352 Fork Customizations (`FEI352/obsidian-day-planner-og`)

Upstream repository: `ebullient/obsidian-day-planner-og` (synced through `a53bb5a` / `v1.0.8+`).

## Customization Matrix

| # | Version | File(s) & Function(s) | Purpose / Behavior | Merged Upstream? |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `v1.1.0` / `v1.1.1` | `src/parser.ts` (`PLAN_PARSER_REGEX`, `parseLine`), `tests/parser-todo-format.test.ts` | Support optional `TODO` / `DOING` / `DONE` status word before `HH:mm` (e.g. `- [ ] TODO 15:35 Task`) while preserving status words inside `item.text` without stripping. | No (fork-specific) |
| 2 | `v1.2.0` | `src/link-resolver.ts` (`DayPlannerLinkResolver`, `cleanEmbeddedTaskLine`, `renderTaskHtmlFallback`, `renderTaskPlainTextFallback`), `tests/link-resolver.test.ts` | Resolve Obsidian block embeds (`![[note#^block]]`, including multi-hop recursive chains with cycle detection), heading/note embeds (`![[note#Heading]]`, `![[note]]`), standard wikilinks (`[[note]]`, `[[note\|alias]]`, `[[note#^block]]`), and internal/external Markdown links (`[label](path.md)`, `[label](https://...)`). Deduplicates outer/inner `<sup>` duration tags and protects `item.text` so note writeback never mutates raw Markdown. | No (fork-specific) |
| 3 | `v1.2.0` | `src/plan-data.ts`, `src/planner-md.ts`, `src/status-bar.ts`, `src/timeline-view.ts`, `src/timeline.svelte`, `src/main.ts`, `src/styles.scss` | Render interactive `<a class="internal-link">` / `<a class="external-link">` elements in Timeline View with native click navigation (`workspace.openLinkText` with Mod/middle-click new-tab support), Obsidian Page Preview hover (`hover-link` + `registerHoverLinkSource`), high-contrast gradient link styles, and clean resolved plain text in Status Bar, Hover Card, and Desktop Notifications. | No (fork-specific) |
