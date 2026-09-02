import { describe, it, expect, beforeEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldPhase, scaffoldProject, writePlanIssues,
} from "../src/planning/artifacts.js";
import { distillManifest } from "../src/planning/distill-manifest.js";
import { appendLedger } from "../src/planning/ledger.js";

// Full-width fake shas -- appendLedger's writer shortens them to 7 chars,
// and the manifest must hand back exactly what the writer wrote.
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

describe("distillManifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-dm-"));
    scaffoldProject(dir, "proj");
    scaffoldPhase(dir, 1, "core");
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2"]);
    // Real writer, real grammar -- the parse must round-trip what
    // ledger.ts's formatEntry produces, tdd segment included.
    appendLedger(dir, "01-core", {
      taskRef: "T1", summary: "wired the frobnicator — carefully",
      baseCommit: SHA_A, headCommit: SHA_B,
      issueId: "GH-1", closedDate: "2026-01-01",
    });
    appendLedger(dir, "01-core", {
      taskRef: "T2", summary: "tests for the frobnicator",
      baseCommit: SHA_B, headCommit: SHA_C,
      issueId: "GH-2", closedDate: "2026-01-02",
      redCommit: SHA_C, greenCommit: SHA_D,
    });
  });

  it("live phase: issues, parsed ledger entries, union commit range", () => {
    const m = distillManifest(dir, 1);
    expect(m.phase).toEqual({
      number: 1, name: "core", dir: "01-core", archived: false,
    });
    expect(m.issues).toEqual(["GH-1", "GH-2"]);
    expect(m.ledgerEntries).toEqual([
      {
        taskRef: "T1", summary: "wired the frobnicator — carefully",
        baseCommit: SHA_A.slice(0, 7), headCommit: SHA_B.slice(0, 7),
        issueId: "GH-1", closedDate: "2026-01-01",
      },
      {
        taskRef: "T2", summary: "tests for the frobnicator",
        baseCommit: SHA_B.slice(0, 7), headCommit: SHA_C.slice(0, 7),
        issueId: "GH-2", closedDate: "2026-01-02",
      },
    ]);
    // union range: first entry's base to last entry's head -- the ledger is
    // append-only, so file order is chronological order.
    expect(m.commitRange).toEqual({
      base: SHA_A.slice(0, 7), head: SHA_C.slice(0, 7),
    });
    expect(m.skipped).toEqual([]);
  });

  it("archived phase under milestones/vN resolves with the archived id", () => {
    // archive the way milestoneComplete does -- rename under milestones/v1
    mkdirSync(join(dir, ".cairn/plans/milestones/v1"), { recursive: true });
    renameSync(join(dir, ".cairn/plans/phases/01-core"),
      join(dir, ".cairn/plans/milestones/v1/01-core"));
    const m = distillManifest(dir, 1);
    expect(m.phase).toEqual({
      number: 1, name: "core", dir: "milestones/v1/01-core", archived: true,
    });
    expect(m.issues).toEqual(["GH-1", "GH-2"]);
    expect(m.ledgerEntries.length).toBe(2);
    expect(m.commitRange).toEqual({
      base: SHA_A.slice(0, 7), head: SHA_C.slice(0, 7),
    });
  });

  it("live phase wins over an archived one with the same number", () => {
    mkdirSync(join(dir, ".cairn/plans/milestones/v1/01-old"), { recursive: true });
    const m = distillManifest(dir, 1);
    expect(m.phase.dir).toBe("01-core");
    expect(m.phase.archived).toBe(false);
  });

  it("empty ledger: no entries, null commit range, nothing skipped", () => {
    scaffoldPhase(dir, 2, "later"); // scaffolds PLAN/CONTEXT, no LEDGER.md
    const m = distillManifest(dir, 2);
    expect(m.ledgerEntries).toEqual([]);
    expect(m.commitRange).toBeNull();
    expect(m.skipped).toEqual([]);
  });

  it("malformed ledger line is skipped with a note, good lines still parse", () => {
    appendFileSync(join(dir, ".cairn/plans/phases/01-core/LEDGER.md"),
      "- [x] T3 — someone hand-edited this line and broke it\n");
    const m = distillManifest(dir, 1);
    expect(m.ledgerEntries.length).toBe(2); // the two writer-formatted lines
    expect(m.skipped.length).toBe(1);
    // header block is 4 lines, the two good entries are 5-6, the bad one is 7
    expect(m.skipped[0]).toContain("LEDGER.md line 7");
    expect(m.skipped[0]).toContain("skipped");
    // a malformed tail never poisons the union range of the good entries
    expect(m.commitRange).toEqual({
      base: SHA_A.slice(0, 7), head: SHA_C.slice(0, 7),
    });
  });

  it("unknown phase number is NOT_FOUND", () => {
    expect(() => distillManifest(dir, 9)).toThrowError(/no phase 9/);
  });

  it("malformed phase number is CONFIG_INVALID", () => {
    expect(() => distillManifest(dir, 1.55)).toThrowError(/phase number/);
  });
});
