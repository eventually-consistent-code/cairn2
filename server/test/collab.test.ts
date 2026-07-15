import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldPhase, writePlanIssues } from "../src/planning/artifacts.js";
import { unplannedReport } from "../src/planning/collab.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-collab-"));

describe("unplannedReport", () => {
  it("flags open issues no plan references; planned and closed issues excluded", async () => {
    const t = new FakeTracker();
    const planned = await t.createIssue({ title: "planned work" });
    const unplanned = await t.createIssue({ title: "hotfix nobody planned" });
    const closedStray = await t.createIssue({ title: "closed stray" });
    await t.closeIssue(closedStray.id);

    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writePlanIssues(d, pd, [planned.id]);

    const report = await unplannedReport(t, d);
    expect(report.unplanned.map((i) => i.id)).toEqual([unplanned.id]);
    expect(report.referencedCount).toBe(1);
  });

  it("empty tracker and no plans -> empty report", async () => {
    const report = await unplannedReport(new FakeTracker(), dir());
    expect(report).toEqual({ unplanned: [], referencedCount: 0 });
  });
});
