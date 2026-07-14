import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldPhase, writePlanIssues } from "../src/planning/artifacts.js";
import { canonicalPhaseName, ensurePhase, driftReport } from "../src/planning/mirror.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-mirror-"));

describe("ensurePhase", () => {
  it("creates once, then returns the same phase (idempotent)", async () => {
    const t = new FakeTracker();
    const a = await ensurePhase(t, 2, "Planning Engine");
    const b = await ensurePhase(t, 2, "Planning Engine");
    expect(a.name).toBe(canonicalPhaseName(2, "Planning Engine"));
    expect(b.id).toBe(a.id);
    expect((await t.listPhases()).length).toBe(1);
  });

  it("rejects trackers without phase support", async () => {
    const t = new FakeTracker();
    Object.defineProperty(t, "capabilities", {
      value: { ...t.capabilities, hasPhases: false },
    });
    await expect(ensurePhase(t, 1, "X"))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("driftReport", () => {
  it("flags missing and closed-in-unverified-phase, passes open", async () => {
    const t = new FakeTracker();
    const open = await t.createIssue({ title: "open one" });
    const closed = await t.createIssue({ title: "closed one" });
    await t.closeIssue(closed.id);

    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core"); // no VERIFICATION.md
    writePlanIssues(d, pd, [open.id, closed.id, "FAKE-999"]);

    const report = await driftReport(t, d);
    expect(report.ok).toEqual([open.id]);
    expect(report.flagged).toEqual(expect.arrayContaining([
      { issueId: closed.id, phase: 1, reason: "closed" },
      { issueId: "FAKE-999", phase: 1, reason: "missing" },
    ]));
  });

  it("closed issues in a VERIFIED phase are not drift", async () => {
    const t = new FakeTracker();
    const done = await t.createIssue({ title: "done" });
    await t.closeIssue(done.id);
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writePlanIssues(d, pd, [done.id]);
    writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");
    const report = await driftReport(t, d);
    expect(report.flagged).toEqual([]);
    expect(report.ok).toEqual([done.id]);
  });
});
