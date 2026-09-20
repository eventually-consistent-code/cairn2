import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import { appendLedger, declaredVerifyFor } from "../src/planning/ledger.js";
import { CairnError } from "../src/errors.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-ledger-"));

const entry = {
  taskRef: "task-3",
  summary: "wire adapter retries",
  baseCommit: "a1b2c3d4e5f6",
  headCommit: "d4e5f6a1b2c3",
  issueId: "PROJ-105",
  closedDate: "2026-07-14",
  evidence: { command: "npm test", result: "12 passed" },
};
// The exact segment the fixture's evidence renders to — every pinned line
// below carries it between the commit range and the issue id.
const EV = "evidence npm test => 12 passed — ";

function ledgerPath(d: string, phaseDir: string): string {
  return join(d, ".cairn", "plans", "phases", phaseDir, "LEDGER.md");
}

describe("appendLedger", () => {
  it("creates the file with a header on first append", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    appendLedger(d, phaseDir, entry);

    const content = readFileSync(ledgerPath(d, phaseDir), "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    // header (at least one non-entry line) precedes the single entry line
    expect(lines[lines.length - 1]).toBe(
      `- [x] task-3 — wire adapter retries — commits a1b2c3d..d4e5f6a — ${EV}PROJ-105 closed 2026-07-14`,
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(content.startsWith("#")).toBe(true);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("second append adds exactly one line, leaving the first untouched", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    appendLedger(d, phaseDir, entry);
    const before = readFileSync(ledgerPath(d, phaseDir), "utf8");
    const beforeLineCount = before.split("\n").filter((l) => l.length > 0).length;

    appendLedger(d, phaseDir, {
      ...entry, taskRef: "task-4", summary: "second task", closedDate: "2026-07-15",
    });

    const after = readFileSync(ledgerPath(d, phaseDir), "utf8");
    const afterLines = after.split("\n").filter((l) => l.length > 0);
    expect(afterLines.length).toBe(beforeLineCount + 1);
    expect(after.startsWith(before.slice(0, before.lastIndexOf("- [x]")))).toBe(true);
    expect(afterLines[afterLines.length - 1]).toBe(
      `- [x] task-4 — second task — commits a1b2c3d..d4e5f6a — ${EV}PROJ-105 closed 2026-07-15`,
    );
  });

  it("sanitizes embedded newlines in entry fields to a single line", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    const { line } = appendLedger(d, phaseDir, {
      ...entry,
      summary: "line one\nline two\n   line three",
    });

    expect(line.split("\n").length).toBe(1);
    expect(line).toBe(
      `- [x] task-3 — line one line two line three — commits a1b2c3d..d4e5f6a — ${EV}PROJ-105 closed 2026-07-14`,
    );

    const content = readFileSync(ledgerPath(d, phaseDir), "utf8");
    const entryLines = content.split("\n").filter((l) => l.startsWith("- [x]"));
    expect(entryLines.length).toBe(1);
  });

  it("throws NOT_FOUND with a nextAction for a phaseDir that doesn't exist", () => {
    const d = dir();
    scaffoldProject(d, "P");

    let caught: unknown;
    try {
      appendLedger(d, "99-nonexistent", entry);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CairnError);
    const err = caught as CairnError;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.nextAction).toBeTruthy();
  });

  it("appends a tdd evidence segment when red+green are given", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    const { line } = appendLedger(d, phaseDir, {
      taskRef: "T2", summary: "tdd task", baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40), issueId: "GH-2", closedDate: "2026-07-18",
      redCommit: "c".repeat(40), greenCommit: "d".repeat(40),
      evidence: { command: "vitest run t2.test.ts", result: "4 passed" },
    });
    // tdd first, then evidence, then the close — one grammar.
    expect(line).toContain("— tdd ccccccc..ddddddd — evidence vitest run t2.test.ts => 4 passed — GH-2 closed");
  });

  it("rejects a lone red or green commit", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    expect(() => appendLedger(d, phaseDir, {
      taskRef: "T3", summary: "s", baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40), issueId: "GH-3", closedDate: "2026-07-18",
      redCommit: "c".repeat(40), evidence: { command: "c", result: "r" },
    })).toThrowError(/both or neither/);
  });

  describe("typed close evidence (phase 23)", () => {
    const base = { taskRef: "T5", summary: "s", baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40), issueId: "GH-5", closedDate: "2026-09-17" };
    const ready = () => {
      const d = dir(); scaffoldProject(d, "P");
      return { d, phaseDir: scaffoldPhase(d, 3, "Ledger Phase").dir };
    };

    it("refuses an entry with neither evidence nor a waiver — the gate", () => {
      const { d, phaseDir } = ready();
      let caught: unknown;
      try { appendLedger(d, phaseDir, base); } catch (e) { caught = e; }
      expect((caught as CairnError).code).toBe("PRECONDITION_FAILED");
      expect((caught as CairnError).message).toMatch(/close evidence missing/);
      expect((caught as CairnError).nextAction).toMatch(/evidenceWaived/);
    });

    it("renders a waiver with its reason; an empty reason or empty evidence field is refused; both is a contradiction", () => {
      const { d, phaseDir } = ready();
      const { line } = appendLedger(d, phaseDir, { ...base, evidenceWaived: "docs only — no runnable change" });
      expect(line).toBe(`- [x] T5 — s — commits aaaaaaa..bbbbbbb — waived docs only - no runnable change — GH-5 closed 2026-09-17`);
      expect(() => appendLedger(d, phaseDir, { ...base, evidenceWaived: "  " })).toThrowError(/needs a reason/);
      expect(() => appendLedger(d, phaseDir, { ...base, evidence: { command: "npm test", result: " " } }))
        .toThrowError(/both a command .* and a result/);
      expect(() => appendLedger(d, phaseDir, { ...base, evidence: { command: "c", result: "r" }, evidenceWaived: "w" }))
        .toThrowError(/mutually exclusive/);
    });

    it("strips em dashes and newlines from evidence so the line's separators stay unambiguous", () => {
      const { d, phaseDir } = ready();
      const { line } = appendLedger(d, phaseDir, {
        ...base, evidence: { command: "npm test — full", result: "1408 passed\n0 failed" },
      });
      expect(line).toBe(`- [x] T5 — s — commits aaaaaaa..bbbbbbb — evidence npm test - full => 1408 passed 0 failed — GH-5 closed 2026-09-17`);
    });
  });
});

describe("declared verification, reported at close (phase 24.5)", () => {
  /** Project with one phase whose PLAN.md carries the given task lines. */
  function projectWithTasks(tasks: string): { d: string; phaseDir: string } {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 1, "Core");
    writeFileSync(join(d, ".cairn", "plans", "phases", phaseDir, "PLAN.md"),
      `---\nissues: [PROJ-105]\n---\n# Phase 1\n\n## Tasks\n${tasks}`);
    return { d, phaseDir };
  }

  it("reads the declaration back out of PLAN.md", () => {
    const { d, phaseDir } = projectWithTasks(
      "- **#PROJ-105 — thing** `verify: npx vitest run test/adapter.test.ts`\n");
    expect(declaredVerifyFor(d, phaseDir, "PROJ-105"))
      .toBe("npx vitest run test/adapter.test.ts");
  });

  it("returns null when the plan declares nothing, and the append still succeeds", () => {
    const { d, phaseDir } = projectWithTasks("- **#PROJ-105 — thing**\n");
    expect(declaredVerifyFor(d, phaseDir, "PROJ-105")).toBeNull();
    const r = appendLedger(d, phaseDir, entry);
    expect(r.declaredVerify).toBeUndefined();
    expect(r.evidenceCitesDeclared).toBeUndefined();
    expect(r.line).toContain(EV);
  });

  it("reports whether the evidence cites the declaration — it never refuses either way", () => {
    const { d, phaseDir } = projectWithTasks(
      "- **#PROJ-105 — thing** `verify: npx vitest run test/adapter.test.ts`\n");
    const matched = appendLedger(d, phaseDir, {
      ...entry,
      evidence: { command: "npx vitest run test/adapter.test.ts", result: "12 passed" },
    });
    expect(matched.declaredVerify).toBe("npx vitest run test/adapter.test.ts");
    expect(matched.evidenceCitesDeclared).toBe(true);

    const mismatched = appendLedger(d, phaseDir, {
      ...entry,
      evidence: { command: "node scripts/check-surface.mjs", result: "clean" },
    });
    expect(mismatched.evidenceCitesDeclared).toBe(false);
    // Reported, not enforced: the line is written either way.
    expect(mismatched.line).toContain("evidence node scripts/check-surface.mjs");
  });

  it("shorthand still counts as citing the same check", () => {
    const { d, phaseDir } = projectWithTasks(
      "- **#PROJ-105 — thing** `verify: npm test`\n");
    // The declaration says "npm test"; what actually gets typed is longer.
    // Failing that honest close would only teach people to pad the field.
    const r = appendLedger(d, phaseDir, {
      ...entry,
      evidence: { command: "npx vitest run --exclude '**/*.live.test.ts'", result: "1452 passed" },
    });
    expect(r.evidenceCitesDeclared).toBe(true);
  });

  it("a waived close reports the declaration and no citation", () => {
    const { d, phaseDir } = projectWithTasks(
      "- **#PROJ-105 — thing** `verify: npm test`\n");
    const r = appendLedger(d, phaseDir, {
      ...entry, evidence: undefined, evidenceWaived: "docs only",
    });
    expect(r.declaredVerify).toBe("npm test");
    expect(r.evidenceCitesDeclared).toBe(false);
    expect(r.line).toContain("waived docs only");
  });
});
