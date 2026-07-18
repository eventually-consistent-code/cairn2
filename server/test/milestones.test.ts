import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import {
  readRoadmapMeta, patchRoadmapMeta, milestoneComplete, milestoneCreate, milestoneList,
} from "../src/planning/milestones.js";

const verify = (dir: string, phaseDir: string) =>
  writeFileSync(join(dir, ".cairn/plans/phases", phaseDir, "VERIFICATION.md"), "# ok\n");

describe("roadmap meta", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-ms-"));
    scaffoldProject(dir, "proj");
  });

  it("defaults milestone to 1 when frontmatter is absent", () => {
    expect(readRoadmapMeta(dir)).toEqual({ milestone: 1 });
  });

  it("patch round-trips and null deletes", () => {
    patchRoadmapMeta(dir, { milestone: 2, milestoneId: "10001", lastResync: "abc1234" });
    expect(readRoadmapMeta(dir)).toEqual({ milestone: 2, milestoneId: "10001", lastResync: "abc1234" });
    patchRoadmapMeta(dir, { milestoneId: null });
    expect(readRoadmapMeta(dir).milestoneId).toBeUndefined();
    // body preserved
    expect(readFileSync(join(dir, ".cairn/plans/roadmap.md"), "utf8")).toContain("| Phase | Name | Status |");
  });
});

describe("milestoneComplete", () => {
  let dir: string; let tracker: FakeTracker;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cairn-ms-"));
    scaffoldProject(dir, "proj");
    scaffoldPhase(dir, 1, "core");
    scaffoldPhase(dir, 2, "polish");
    tracker = new FakeTracker();
    await tracker.createPhase("Phase 1: core");
    await tracker.createPhase("Phase 2: polish");
  });

  it("gates on unverified phases and moves nothing", async () => {
    verify(dir, "01-core"); // 02-polish left unverified
    await expect(milestoneComplete(tracker, dir, "s"))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(existsSync(join(dir, ".cairn/plans/phases/01-core"))).toBe(true);
  });

  it("closes tracker phases, releases native milestone, archives, bumps roadmap", async () => {
    verify(dir, "01-core"); verify(dir, "02-polish");
    const m = await tracker.createMilestone("v1");
    patchRoadmapMeta(dir, { milestoneId: m.id });
    const report = await milestoneComplete(tracker, dir, "shipped v1");
    expect(report.closedPhases.length).toBe(2);
    expect(report.released?.state).toBe("released");
    expect(report.nextMilestone).toBe(2);
    expect(existsSync(join(dir, ".cairn/plans/milestones/v1/01-core/PLAN.md"))).toBe(true);
    expect(existsSync(join(dir, ".cairn/plans/phases/01-core"))).toBe(false);
    const meta = readRoadmapMeta(dir);
    expect(meta.milestone).toBe(2);
    expect(meta.milestoneId).toBeUndefined();
    expect(readFileSync(join(dir, ".cairn/plans/roadmap.md"), "utf8"))
      .toContain("shipped v1");
  });

  it("is re-runnable: already-closed tracker phases are fine", async () => {
    verify(dir, "01-core"); verify(dir, "02-polish");
    const phases = await tracker.listPhases();
    for (const p of phases) await tracker.closePhase(p.id);
    const report = await milestoneComplete(tracker, dir, "s");
    expect(report.closedPhases.length).toBe(2);
  });

  it("records skips when hasPhaseClose is false, and archives anyway", async () => {
    verify(dir, "01-core"); verify(dir, "02-polish");
    (tracker.capabilities as { hasPhaseClose: boolean }).hasPhaseClose = false;
    const report = await milestoneComplete(tracker, dir, "s");
    expect(report.skippedPhases.length).toBe(2);
    expect(report.skippedPhases[0].reason).toContain("no closed state");
    expect(existsSync(join(dir, ".cairn/plans/milestones/v1"))).toBe(true);
  });
});

describe("milestoneCreate / milestoneList", () => {
  it("create stamps milestone_id; list merges git archive with native", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-ms-"));
    scaffoldProject(dir, "proj");
    const tracker = new FakeTracker();
    const { native } = await milestoneCreate(tracker, dir, "v1");
    expect(native?.id).toBeTruthy();
    expect(readRoadmapMeta(dir).milestoneId).toBe(native!.id);
    mkdirSync(join(dir, ".cairn/plans/milestones/v1"), { recursive: true });
    const listed = await milestoneList(tracker, dir);
    expect(listed.current).toBe(1);
    expect(listed.archived).toEqual(["v1"]);
    expect(listed.native?.length).toBe(1);
  });
});
