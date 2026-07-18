import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugify, phaseDirName, scaffoldProject, scaffoldPhase,
  readPlanIssues, writePlanIssues, readPlanMeta, writePlanMeta,
} from "../src/planning/artifacts.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-plans-"));

describe("slugify / phaseDirName", () => {
  it("slugifies names and pads numbers", () => {
    expect(slugify("Tracker Core!! (v2)")).toBe("tracker-core-v2");
    expect(phaseDirName(3, "tracker-core")).toBe("03-tracker-core");
  });
  it("rejects traversal-shaped and empty slugs, bad numbers", () => {
    expect(() => slugify("../..")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => phaseDirName(0, "x")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => phaseDirName(100, "x")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("scaffolding", () => {
  it("creates project files once, skips on re-run", () => {
    const d = dir();
    const first = scaffoldProject(d, "My Proj");
    expect(first.created.length).toBe(2);
    expect(existsSync(join(d, ".cairn/plans/PROJECT.md"))).toBe(true);
    const second = scaffoldProject(d, "My Proj");
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBe(2);
  });

  it("creates a phase dir with CONTEXT + PLAN (+ RESEARCH when asked)", () => {
    const d = dir();
    const r = scaffoldPhase(d, 2, "Planning Engine", { research: true });
    expect(r.dir).toBe("02-planning-engine");
    const base = join(d, ".cairn/plans/phases/02-planning-engine");
    for (const f of ["CONTEXT.md", "PLAN.md", "RESEARCH.md"]) {
      expect(existsSync(join(base, f))).toBe(true);
    }
    expect(readFileSync(join(base, "PLAN.md"), "utf8")).toContain("issues: []");
  });
});

describe("plan issue round-trip", () => {
  it("reads [] when absent, writes and re-reads issues preserving body", () => {
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    expect(readPlanIssues(d, pd)).toEqual([]);
    writePlanIssues(d, pd, ["PROJ-7", "PROJ-8"]);
    expect(readPlanIssues(d, pd)).toEqual(["PROJ-7", "PROJ-8"]);
    const raw = readFileSync(
      join(d, ".cairn/plans/phases", pd, "PLAN.md"), "utf8");
    expect(raw).toContain("# Phase 1: Core — Plan"); // template body survived
  });

  it("rejects issue ids with frontmatter-breaking characters, leaving PLAN.md untouched", () => {
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    const planPath = join(d, ".cairn/plans/phases", pd, "PLAN.md");
    const before = readFileSync(planPath, "utf8");

    expect(() => writePlanIssues(d, pd, ["A,B"])).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(readFileSync(planPath, "utf8")).toBe(before);

    expect(() => writePlanIssues(d, pd, ["A\nB"])).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(readFileSync(planPath, "utf8")).toBe(before);
  });
});

describe("plan meta (waves/tdd)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-meta-"));
    scaffoldPhase(dir, 1, "core");
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2", "GH-3"]);
  });

  it("write + read round-trips waves and tdd", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1", "GH-2"], ["GH-3"]], tdd: ["GH-2"] });
    expect(readPlanMeta(dir, "01-core")).toEqual({
      issues: ["GH-1", "GH-2", "GH-3"],
      waves: [["GH-1", "GH-2"], ["GH-3"]],
      tdd: ["GH-2"],
    });
    const raw = readFileSync(join(dir, ".cairn/plans/phases/01-core/PLAN.md"), "utf8");
    expect(raw).toContain("wave_1: [GH-1, GH-2]");
    expect(raw).toContain("wave_2: [GH-3]");
    expect(raw).toContain("tdd: [GH-2]");
  });

  it("re-writing waves replaces stale wave_N keys", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1"], ["GH-2"], ["GH-3"]] });
    writePlanMeta(dir, "01-core", { waves: [["GH-1", "GH-2", "GH-3"]] });
    const raw = readFileSync(join(dir, ".cairn/plans/phases/01-core/PLAN.md"), "utf8");
    expect(raw).toContain("wave_1: [GH-1, GH-2, GH-3]");
    expect(raw).not.toContain("wave_2");
  });

  it("rejects unknown ids, duplicates across waves, and empty waves", () => {
    expect(() => writePlanMeta(dir, "01-core", { waves: [["GH-9"]] }))
      .toThrowError(/GH-9/);
    expect(() => writePlanMeta(dir, "01-core", { waves: [["GH-1"], ["GH-1"]] }))
      .toThrowError(/more than one wave/);
    expect(() => writePlanMeta(dir, "01-core", { waves: [[]] }))
      .toThrowError(/empty/);
    expect(() => writePlanMeta(dir, "01-core", { tdd: ["GH-9"] }))
      .toThrowError(/GH-9/);
  });

  it("issues writes preserve meta keys (writePlanIssues keeps wave_*/tdd)", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1"]], tdd: ["GH-1"] });
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2", "GH-3", "GH-4"]);
    expect(readPlanMeta(dir, "01-core").waves).toEqual([["GH-1"]]);
  });
});
