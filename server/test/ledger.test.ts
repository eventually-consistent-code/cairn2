import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import { appendLedger } from "../src/planning/ledger.js";
import { CairnError } from "../src/errors.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-ledger-"));

const entry = {
  taskRef: "task-3",
  summary: "wire adapter retries",
  baseCommit: "a1b2c3d4e5f6",
  headCommit: "d4e5f6a1b2c3",
  issueId: "PROJ-105",
  closedDate: "2026-07-14",
};

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
      "- [x] task-3 — wire adapter retries — commits a1b2c3d..d4e5f6a — PROJ-105 closed 2026-07-14",
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
      "- [x] task-4 — second task — commits a1b2c3d..d4e5f6a — PROJ-105 closed 2026-07-15",
    );
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
});
