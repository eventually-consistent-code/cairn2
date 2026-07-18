import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { projectStatus } from "./status.js";

export interface LedgerEntryInput {
  taskRef: string;
  summary: string;
  baseCommit: string;
  headCommit: string;
  issueId: string;
  closedDate: string;
  redCommit?: string;
  greenCommit?: string;
}

/** Short-SHA form used in the ledger line -- matches `git log --abbrev=7` convention. */
function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

/** Collapses embedded newlines (and the whitespace around them) to a single space, so a
 *  multi-line field (e.g. a pasted commit-message summary) can never break the ledger's
 *  one-line-per-entry invariant. */
function sanitize(field: string): string {
  return field.replace(/\s*\n\s*/g, " ").trim();
}

function formatEntry(entry: LedgerEntryInput): string {
  if ((entry.redCommit === undefined) !== (entry.greenCommit === undefined)) {
    throw new CairnError("CONFIG_INVALID",
      "redCommit/greenCommit: both or neither",
      "pass the failing-test commit AND the passing commit, or omit both");
  }
  const tdd = entry.redCommit
    ? `tdd ${shortSha(sanitize(entry.redCommit))}..${shortSha(sanitize(entry.greenCommit!))} — `
    : "";
  return `- [x] ${sanitize(entry.taskRef)} — ${sanitize(entry.summary)} — commits `
    + `${shortSha(sanitize(entry.baseCommit))}..${shortSha(sanitize(entry.headCommit))} — `
    + `${tdd}${sanitize(entry.issueId)} closed ${sanitize(entry.closedDate)}\n`;
}

function ledgerHeader(phase: { number: number; name: string }): string {
  return `# Phase ${phase.number}: ${phase.name} — Ledger\n\n`
    + `<!-- append-only; one line per verified task; server appends, never rewrites -->\n\n`;
}

/**
 * Appends one formatted line to a phase's LEDGER.md, creating the file (with
 * header) on first append. Never rewrites existing content -- append-only,
 * so the ledger stays a trustworthy record even if a session crashes
 * mid-task. Ledger rides into git with the closing commit; the server just
 * writes the bytes.
 */
export function appendLedger(projectDir: string, phaseDir: string,
  entry: LedgerEntryInput): { path: string; line: string } {
  const phase = projectStatus(projectDir).phases.find((p) => p.dir === phaseDir);
  if (!phase) {
    throw new CairnError("NOT_FOUND",
      `no phase dir '${phaseDir}' found under .cairn/plans/phases`,
      "run plan_scaffold_phase (or plan_status to list known phases), then retry ledger_append");
  }

  const path = join(plansRoot(projectDir), "phases", phaseDir, "LEDGER.md");
  const line = formatEntry(entry);
  if (existsSync(path)) {
    appendFileSync(path, line);
  } else {
    writeFileSync(path, ledgerHeader(phase) + line);
  }
  return { path, line: line.trimEnd() };
}
