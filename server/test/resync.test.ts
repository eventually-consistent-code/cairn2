import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import { readRoadmapMeta } from "../src/planning/milestones.js";
import { resyncReport } from "../src/planning/resync.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
function commit(dir: string, file: string, msg: string): string {
  writeFileSync(join(dir, file), `${msg}\n`);
  // Stage only the named file (not "-A"): a hand-written LEDGER.md line
  // written directly via appendFileSync between commits would otherwise be
  // an untracked file that "-A" sweeps into the next commit(), bundling
  // it into whichever commit the test is trying to keep isolated.
  git(dir, "add", file);
  git(dir, "commit", "-m", msg, "--no-gpg-sign");
  return git(dir, "rev-parse", "HEAD");
}

describe("resyncReport", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-rs-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
    scaffoldProject(dir, "proj");
    scaffoldPhase(dir, 1, "core");
    commit(dir, "seed.txt", "seed");
  });

  it("first run initializes the marker and reports nothing", () => {
    const r = resyncReport(dir);
    expect(r.initialized).toBe(true);
    expect(r.outOfBand).toEqual([]);
    expect(readRoadmapMeta(dir).lastResync).toBe(r.headSha);
  });

  it("flags commits not covered by any ledger range; ledgered ranges are covered", () => {
    resyncReport(dir); // initialize at seed
    const base = git(dir, "rev-parse", "HEAD");
    const covered = commit(dir, "a.txt", "ledgered work");
    // hand-write a ledger line in the real format
    appendFileSync(join(dir, ".cairn/plans/phases/01-core/LEDGER.md"),
      `# Phase 1: core — Ledger\n\n- [x] T1 — did work — commits ${base.slice(0, 7)}..${covered.slice(0, 7)} — GH-1 closed 2026-07-18\n`);
    const rogue = commit(dir, "b.txt", "out of band hotfix");
    const r = resyncReport(dir);
    expect(r.outOfBand.map((c) => c.sha)).toEqual([rogue]);
    expect(r.outOfBand[0].subject).toBe("out of band hotfix");
    expect(r.outOfBand[0].files).toEqual(["b.txt"]);
    expect(r.sinceSha).toBeTruthy();
  });

  it("advances the marker: a second run sees nothing new", () => {
    resyncReport(dir);
    commit(dir, "c.txt", "rogue");
    expect(resyncReport(dir).outOfBand.length).toBe(1);
    expect(resyncReport(dir).outOfBand.length).toBe(0);
  });
});
