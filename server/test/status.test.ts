import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

  it("does not throw when one phase's PLAN.md has malformed frontmatter", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: p1 } = scaffoldPhase(d, 1, "Core");
    const { dir: p2 } = scaffoldPhase(d, 2, "Something");
    writePlanIssues(d, p2, ["X-1"]);

    // hand-corrupt phase 1's PLAN.md with an invalid enum value for depth
    const plan1Path = join(d, ".cairn/plans/phases", p1, "PLAN.md");
    const original = readFileSync(plan1Path, "utf8");
    writeFileSync(plan1Path, original.replace("issues: []", "issues: []\ndepth: turbo"));

    let s: ReturnType<typeof projectStatus> | undefined;
    expect(() => { s = projectStatus(d); }).not.toThrow();
    expect(s).toBeDefined();

    const phase1 = s!.phases.find((p) => p.dir === p1)!;
    expect(phase1.issues).toEqual([]);
    expect(phase1.parseError).toBeDefined();
    expect(phase1.parseError).toContain("01-");
    expect(phase1.parseError).toMatch(/depth/i);

    const phase2 = s!.phases.find((p) => p.dir === p2)!;
    expect(phase2.parseError).toBeUndefined();
    expect(phase2.issues).toEqual(["X-1"]);
  });
});
