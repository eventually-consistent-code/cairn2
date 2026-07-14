import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase, writePlanIssues } from "../src/planning/artifacts.js";
import { projectStatus } from "../src/planning/status.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-status-"));

describe("projectStatus", () => {
  it("empty project dir reports nothing", () => {
    expect(projectStatus(dir())).toEqual({
      hasProject: false, hasRoadmap: false, phases: [],
    });
  });

  it("reports phases sorted with artifact presence and issues", () => {
    const d = dir();
    scaffoldProject(d, "P");
    scaffoldPhase(d, 2, "Second Phase", { research: true });
    const { dir: p1 } = scaffoldPhase(d, 1, "First");
    writePlanIssues(d, p1, ["X-1"]);
    // junk entry must be ignored
    mkdirSync(join(d, ".cairn/plans/phases/junk"), { recursive: true });
    writeFileSync(join(d, ".cairn/plans/phases/junk/PLAN.md"), "x");

    const s = projectStatus(d);
    expect(s.hasProject).toBe(true);
    expect(s.hasRoadmap).toBe(true);
    expect(s.phases.map((p) => p.number)).toEqual([1, 2]);
    expect(s.phases[0]).toMatchObject({
      dir: "01-first", name: "first", hasPlan: true,
      hasResearch: false, hasVerification: false, issues: ["X-1"],
    });
    expect(s.phases[1].hasResearch).toBe(true);
  });
});
