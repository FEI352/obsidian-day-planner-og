import { describe, expect, test } from "vitest";
import Parser from "../src/parser";
import { DayPlannerSettings } from "../src/settings";
import { PlanSummaryData } from "../src/plan-data";
import { mockDate } from "./mocks/date";

// 2026-08-01 FEI352 fork: 验证 HH:mm + TODO 状态词格式（用户日记/模板格式）
describe("parser HH:mm + TODO format", () => {
    const makeParser = () => {
        const settings = new DayPlannerSettings();
        settings.breakLabel = "☕️ COFFEE BREAK";
        settings.endLabel = "🛑 FINISH";
        settings.correctLabels = false;
        settings.markCurrent = false;
        settings.completePastItems = false;
        return new Parser({ current: () => settings });
    };

    test("TODO after time: - [ ] 15:35 TODO 散步 15 min <sup>5 min</sup>", () => {
        const parser = makeParser();
        const summary = new PlanSummaryData([], true);
        const content = [
            "# Day Planner",
            "- [ ] 15:35 TODO 散步 15 min <sup>5 min</sup>",
        ].join("\n");
        parser.parseContent(content, summary, new Date(2026, 7, 1, 12, 0));
        expect(summary.items).to.have.lengthOf(1);
        const item = summary.items[0];
        expect(item.rawTime).to.eql("15:35");
        expect(item.text).to.eql("TODO 散步 15 min <sup>5 min</sup>");
    });

    test("TODO before time: - [ ] TODO 15:35 散步 <sup>5 min</sup>", () => {
        const parser = makeParser();
        const summary = new PlanSummaryData([], true);
        const content = [
            "# Day Planner",
            "- [ ] TODO 15:35 散步 <sup>5 min</sup>",
        ].join("\n");
        parser.parseContent(content, summary, new Date(2026, 7, 1, 12, 0));
        expect(summary.items).to.have.lengthOf(1);
        const item = summary.items[0];
        expect(item.rawTime).to.eql("15:35");
        // TODO 被 statusWord 组吞掉，text 干净
        expect(item.text).to.eql("散步 <sup>5 min</sup>");
    });

    test("plain HH:mm without status word still works", () => {
        const parser = makeParser();
        const summary = new PlanSummaryData([], true);
        const content = [
            "# Day Planner",
            "- [ ] 13:10 meeting",
        ].join("\n");
        parser.parseContent(content, summary, new Date(2026, 7, 1, 12, 0));
        expect(summary.items).to.have.lengthOf(1);
        expect(summary.items[0].rawTime).to.eql("13:10");
        expect(summary.items[0].text).to.eql("meeting");
    });
});
