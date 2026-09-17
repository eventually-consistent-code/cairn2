import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { projectStatus } from "./status.js";

/** Typed close evidence (phase 23): what was run, and what it showed. */
export interface CloseEvidence {
  /** The proving command — a suite name or the shell line ("npm test", "vitest run x.test.ts"). */
  command: string;
  /** The observed outcome ("1408 passed", "exit 0, 3 files changed"). */
  result: string;
}

export interface LedgerEntryInput {
  taskRef: string;
  summary: string;
  baseCommit: string;
  headCommit: string;
  issueId: string;
  closedDate: string;
  redCommit?: string;
  greenCommit?: string;
  /**
   * Exactly one of `evidence` / `evidenceWaived` is required: an issue
   * closes on what was run and what it showed, or on a written reason it
   * needed no run (docs-only, planning-only). Neither → the append refuses.
   */
  evidence?: CloseEvidence;
  evidenceWaived?: string;
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

/** Evidence text additionally loses em dashes — " — " is the ledger line's
 *  field separator, so one inside a command or result would shift every
 *  field after it for the readers (distill-manifest, resync). */
function sanitizeSegment(field: string): string {
  return sanitize(field).replace(/—/g, "-");
}

/**
 * The evidence segment: `evidence <command> => <result> — ` or
 * `waived <reason> — `, placed before `<issueId> closed` exactly like the
 * tdd segment. Refuses neither (PRECONDITION_FAILED — the gate) and both
 * (CONFIG_INVALID — a contradiction).
 */
function evidenceSegment(entry: LedgerEntryInput): string {
  const has = entry.evidence !== undefined;
  const waived = entry.evidenceWaived !== undefined;
  if (has && waived) {
    throw new CairnError("CONFIG_INVALID",
      "evidence and evidenceWaived are mutually exclusive",
      "pass the evidence you have, or a waiver reason — not both");
  }
  if (has) {
    const cmd = sanitizeSegment(entry.evidence!.command ?? "");
    const res = sanitizeSegment(entry.evidence!.result ?? "");
    if (!cmd || !res) {
      throw new CairnError("PRECONDITION_FAILED",
        "close evidence needs both a command (what was run) and a result (what it showed)",
        "e.g. { command: \"npm test\", result: \"1408 passed\" }");
    }
    return `evidence ${cmd} => ${res} — `;
  }
  if (waived) {
    const reason = sanitizeSegment(entry.evidenceWaived!);
    if (!reason) {
      throw new CairnError("PRECONDITION_FAILED",
        "an evidence waiver needs a reason", "say why this close needed no run — \"docs only\", \"plan text only\"");
    }
    return `waived ${reason} — `;
  }
  throw new CairnError("PRECONDITION_FAILED",
    "close evidence missing: state what was run and what it showed, or waive with a reason",
    "ledger_append(evidence: { command, result }) from the run that justified the close, "
      + "or evidenceWaived: \"<why no run was needed>\" for docs/planning-only issues");
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
  const evidence = evidenceSegment(entry);
  return `- [x] ${sanitize(entry.taskRef)} — ${sanitize(entry.summary)} — commits `
    + `${shortSha(sanitize(entry.baseCommit))}..${shortSha(sanitize(entry.headCommit))} — `
    + `${tdd}${evidence}${sanitize(entry.issueId)} closed ${sanitize(entry.closedDate)}\n`;
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
