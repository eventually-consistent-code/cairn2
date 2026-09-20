import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import {
  readRoadmapMeta, patchRoadmapMeta, milestoneComplete, milestoneCreate, milestoneList,
  applyRoadmapRows, parseRoadmapRows, patchRoadmapRows, readRoadmapRows,
} from "../src/planning/milestones.js";

const verify = (dir: string, phaseDir: string) =>
  writeFileSync(join(dir, ".cairn/plans/phases", phaseDir, "VERIFICATION.md"), "# ok\n");

const roadmap = (dir: string) =>
  readFileSync(join(dir, ".cairn/plans/roadmap.md"), "utf8");

/** Appends phase rows to the scaffolded roadmap's empty table. */
const addRows = (dir: string, ...rows: string[]) =>
  writeFileSync(join(dir, ".cairn/plans/roadmap.md"),
    roadmap(dir) + rows.join("\n") + "\n");

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

describe("roadmap rows (#185)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-ms-"));
    scaffoldProject(dir, "proj");
  });

  it("parses phase rows and skips the header, separator and prose", () => {
    addRows(dir, "| 1 | core | planned |", "| 2.5 | slice | verified |");
    const rows = parseRoadmapRows(roadmap(dir));
    expect(rows.map((r) => [r.number, r.name, r.status])).toEqual([
      [1, "core", "planned"], [2.5, "slice", "verified"],
    ]);
  });

  it("patches only the named rows, preserving the rest of the file byte for byte", () => {
    addRows(dir, "| 1 | core | planned |", "| 2 | polish | planned |");
    const before = roadmap(dir);
    const applied = patchRoadmapRows(dir, new Map([[1, "verified"]]));
    expect(applied).toEqual([{ number: 1, from: "planned", to: "verified" }]);
    expect(roadmap(dir)).toBe(before.replace("| 1 | core | planned |", "| 1 | core | verified |"));
  });

  it("is idempotent — a row already saying the right thing is not rewritten", () => {
    addRows(dir, "| 1 | core | verified |");
    const before = roadmap(dir);
    expect(patchRoadmapRows(dir, new Map([[1, "verified"]]))).toEqual([]);
    expect(roadmap(dir)).toBe(before);
  });

  it("never stamps empty frontmatter onto a roadmap that had none", () => {
    addRows(dir, "| 1 | core | planned |");
    patchRoadmapRows(dir, new Map([[1, "verified"]]));
    expect(roadmap(dir).startsWith("# proj — Roadmap")).toBe(true);
  });

  it("keeps frontmatter and body intact when the roadmap has both", () => {
    patchRoadmapMeta(dir, { milestone: 3 });
    addRows(dir, "| 4 | later | planned |");
    patchRoadmapRows(dir, new Map([[4, "verified"]]));
    expect(readRoadmapMeta(dir).milestone).toBe(3);
    expect(roadmap(dir)).toContain("| 4 | later | verified |");
  });

  it("leaves a struck-through row alone — route removed that phase on purpose", () => {
    addRows(dir, "| ~~7~~ | dropped | planned |");
    expect(readRoadmapRows(dir)).toEqual([]);
    expect(patchRoadmapRows(dir, new Map([[7, "verified"]]))).toEqual([]);
  });

  it("preserves a cell's own padding instead of reformatting the table", () => {
    const { body, applied } = applyRoadmapRows("|  1  |  core  |  planned  |\n",
      new Map([[1, "verified"]]));
    expect(body).toBe("|  1  |  core  |  verified  |\n");
    expect(applied).toHaveLength(1);
  });

  it("a project with no roadmap.md yet says nothing rather than throwing", () => {
    const bare = mkdtempSync(join(tmpdir(), "cairn-ms-"));
    expect(readRoadmapRows(bare)).toEqual([]);
    expect(patchRoadmapRows(bare, new Map([[1, "verified"]]))).toEqual([]);
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

  it("flips the shipped rows from the same event that archives the phases (#185)", async () => {
    addRows(dir, "| 1 | core | verified |", "| 2 | polish | planned |",
      "| 9 | someday | planned |");
    verify(dir, "01-core"); verify(dir, "02-polish");
    const report = await milestoneComplete(tracker, dir, "shipped v1");
    expect(report.roadmapRows).toEqual([
      { number: 1, from: "verified", to: "shipped (v1)" },
      { number: 2, from: "planned", to: "shipped (v1)" },
    ]);
    const text = roadmap(dir);
    expect(text).toContain("| 1 | core | shipped (v1) |");
    expect(text).toContain("| 2 | polish | shipped (v1) |");
    // A phase this milestone never held keeps its row.
    expect(text).toContain("| 9 | someday | planned |");
    expect(text).toContain("## Archived — v1");
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
