import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import { docsDriftReport } from "../src/planning/docs-drift.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

// Commits with an explicit date -- signal (b) compares committer timestamps,
// and same-second commits would make ordering ambiguous.
function commitAt(dir: string, files: string[], msg: string, date: string): string {
  git(dir, "add", ...files);
  execFileSync("git", ["commit", "-m", msg, "--no-gpg-sign"], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(dir, "rev-parse", "HEAD");
}

const T1 = "2026-01-01T10:00:00Z";
const T2 = "2026-01-02T10:00:00Z";

describe("docsDriftReport", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-dd-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
    scaffoldProject(dir, "proj");
    scaffoldPhase(dir, 1, "core");
    // verified phase with a committed ledger at T1
    writeFileSync(join(dir, ".cairn/plans/phases/01-core/VERIFICATION.md"), "# ok\n");
    writeFileSync(join(dir, ".cairn/plans/phases/01-core/LEDGER.md"),
      "# Phase 1: core — Ledger\n\n- [x] T1 — did work — commits aaaaaaa..bbbbbbb — GH-1 closed 2026-01-01\n");
    commitAt(dir, [".cairn"], "phase 1 verified", T1);
  });

  it("clean: docs mention the phase and postdate the ledger commit", () => {
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n- Phase 1: core shipped\n");
    commitAt(dir, ["CHANGELOG.md"], "changelog", T2);
    const r = docsDriftReport(dir);
    expect(r.flagged).toEqual([]);
    expect(r.ok).toEqual(["01-core"]);
  });

  it("flags a verified phase no docs entry mentions", () => {
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n- unrelated note\n");
    commitAt(dir, ["CHANGELOG.md"], "changelog", T2);
    const r = docsDriftReport(dir);
    expect(r.ok).toEqual([]);
    expect(r.flagged).toEqual([
      { phase: "01-core", reason: "no CHANGELOG.md or docs/ entry mentions this phase" },
    ]);
  });

  it("flags docs whose newest commit predates the phase's ledger commit", () => {
    // docs mention the phase but were committed BEFORE the ledger landed
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs/notes.md"), "phase 1 core is coming\n");
    commitAt(dir, ["docs"], "early docs", T1);
    writeFileSync(join(dir, ".cairn/plans/phases/01-core/LEDGER.md"),
      "# Phase 1: core — Ledger\n\n- [x] T2 — more work — commits ccccccc..ddddddd — GH-2 closed 2026-01-02\n");
    commitAt(dir, [".cairn"], "more verified work", T2);
    const r = docsDriftReport(dir);
    expect(r.ok).toEqual([]);
    expect(r.flagged).toEqual([
      { phase: "01-core", reason: "newest docs/CHANGELOG.md commit predates the phase's last LEDGER.md commit" },
    ]);
  });

  it("no docs at all: both signals miss, reasons joined", () => {
    const r = docsDriftReport(dir);
    expect(r.flagged.length).toBe(1);
    expect(r.flagged[0].phase).toBe("01-core");
    expect(r.flagged[0].reason).toContain("mentions this phase");
    expect(r.flagged[0].reason).toContain("predates");
  });

  it("reads ARCHIVED phases under milestones/vN (post-summit layout)", () => {
    // archive the phase the way milestoneComplete does -- rename under milestones/v1
    mkdirSync(join(dir, ".cairn/plans/milestones/v1"), { recursive: true });
    renameSync(join(dir, ".cairn/plans/phases/01-core"),
      join(dir, ".cairn/plans/milestones/v1/01-core"));
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n- nothing relevant\n");
    commitAt(dir, [".cairn", "CHANGELOG.md"], "summit v1", T2);
    const r = docsDriftReport(dir);
    expect(r.ok).toEqual([]);
    expect(r.flagged).toEqual([
      { phase: "milestones/v1/01-core", reason: "no CHANGELOG.md or docs/ entry mentions this phase" },
    ]);
  });

  it("matches a hyphenated docs heading against a spaced phase name", () => {
    // live miss: heading said "auto-docs", parsed phase name is "auto docs"
    scaffoldPhase(dir, 9, "auto docs");
    writeFileSync(join(dir, ".cairn/plans/phases/09-auto-docs/VERIFICATION.md"), "# ok\n");
    writeFileSync(join(dir, "CHANGELOG.md"),
      "# Changelog\n\n- Phase 1: core shipped\n\n## auto-docs\n\n- shipped the pipeline\n");
    commitAt(dir, ["CHANGELOG.md"], "changelog", T2);
    const r = docsDriftReport(dir);
    expect(r.flagged).toEqual([]);
    expect(r.ok).toEqual(["01-core", "09-auto-docs"]);
  });

  it("matches 'phase N' split across a markdown line wrap", () => {
    // live miss: "phase\n9.5" -- the label straddled a soft line break
    scaffoldPhase(dir, 9.5, "elicitation");
    writeFileSync(join(dir, ".cairn/plans/phases/09.5-elicitation/VERIFICATION.md"), "# ok\n");
    writeFileSync(join(dir, "CHANGELOG.md"),
      "# Changelog\n\n- Phase 1: core shipped\n- a long entry that breaks right at phase\n  9.5 and keeps going\n");
    commitAt(dir, ["CHANGELOG.md"], "changelog", T2);
    const r = docsDriftReport(dir);
    expect(r.flagged).toEqual([]);
    expect(r.ok).toEqual(["01-core", "09.5-elicitation"]);
  });

  it("ignores unverified phases entirely", () => {
    scaffoldPhase(dir, 2, "later"); // no VERIFICATION.md
    const r = docsDriftReport(dir);
    expect(r.flagged.map((f) => f.phase)).toEqual(["01-core"]);
    expect(r.ok).toEqual([]);
  });
});
