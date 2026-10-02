// Close receipt (#233): the bridge between the two tools that each hold half
// of a closed task's record. issue_close has the tracker facts (the estimate
// as stored, the claim and close times, the claimed minutes, the worklog
// outcome) but no commit range; ledger_append has the range but would need
// a network read to recover the tracker side. The close writes a small
// ephemeral file keyed by issue id; the append consumes it and deletes it.
//
// Two rules matter more than the mechanism, and both live here:
//   - every read and write is best-effort and NEVER throws -- instrumentation
//     that can block a close is worse than no instrumentation;
//   - a missing or unreadable receipt is reported as a named `degraded`
//     marker, never as silent nulls, so no later reader has to guess whether
//     a null means zero or unknown.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EstimateSource } from "./token-estimate.js";

/** What the worklog did with the time at close. */
export type WorklogOutcome = "logged" | "failed" | "unsupported" | "not_requested";

/** The estimate exactly as the close saw it, each number with its source. */
export interface ReceiptEstimate {
  points: number | null;
  pointsSource: EstimateSource | null;
  minutes: number | null;
  minutesSource: EstimateSource | null;
}

export interface CloseReceipt {
  version: 1;
  issueId: string;
  /** Server clock at the moment the close was issued. */
  closedAt: string;
  /** When the work was claimed, when the close could find out; null otherwise. */
  claimedAt: string | null;
  /** The agent's own number -- a claim to check, never the measurement. */
  claimedMinutes: number | null;
  estimate: ReceiptEstimate;
  worklog: WorklogOutcome;
}

/** Why the append is working without a receipt. Always named, never implied. */
export type ReceiptDegraded = "no_receipt" | "receipt_unreadable";

/** Receipts live in local state, never in git: the directory ignores itself,
 *  so this holds in any repo whether or not its .gitignore knows about it. */
export function receiptsDir(projectDir: string): string {
  return join(projectDir, ".cairn", "state", "receipts");
}

// Issue ids come from eight backends ("PROJ-12", "#233", "a1b2c"); keep the
// filename to a safe alphabet so no id can reach outside the folder. A
// leading "#" is dropped first: the close and the append name the same
// issue as "233" and "#233" often enough that the two must meet.
function idKey(issueId: string): string {
  return issueId.trim().replace(/^#/, "");
}

function receiptPath(projectDir: string, issueId: string): string {
  const safe = idKey(issueId).replace(/[^A-Za-z0-9._-]/g, "_");
  return join(receiptsDir(projectDir), `${safe}.close.json`);
}

function ensureDir(projectDir: string): void {
  const d = receiptsDir(projectDir);
  mkdirSync(d, { recursive: true });
  const ignore = join(d, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

/** Writes the receipt. Returns false instead of throwing on any failure --
 *  the close has already happened and must report success regardless. */
export function writeReceipt(projectDir: string, receipt: CloseReceipt): boolean {
  try {
    ensureDir(projectDir);
    writeFileSync(receiptPath(projectDir, receipt.issueId),
      JSON.stringify(receipt, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function isReceipt(v: unknown, issueId: string): v is CloseReceipt {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return r.version === 1
    && typeof r.issueId === "string" && idKey(r.issueId) === idKey(issueId)
    && typeof r.closedAt === "string"
    && typeof r.estimate === "object" && r.estimate !== null
    && typeof r.worklog === "string";
}

function minutes(n: number | null): string {
  return n === null ? "none" : `${n}m`;
}

function estimateField(e: ReceiptEstimate): string {
  const parts: string[] = [];
  if (e.points !== null) parts.push(`${e.points}pt:${e.pointsSource}`);
  if (e.minutes !== null) parts.push(`${e.minutes}m:${e.minutesSource}`);
  return parts.length ? parts.join(",") : "none";
}

/**
 * The ledger line's `actuals` segment, placed before `<issueId> closed` like
 * the tdd and evidence segments. Space-separated key=value pairs so a later
 * reader can split it without knowing every key; never an em dash, which is
 * the line's field separator. A receipt-less append still gets the segment,
 * carrying only its degraded marker -- absence is stated, not implied.
 */
export function actualsSegment(
  from: { receipt: CloseReceipt } | { degraded: ReceiptDegraded },
): string {
  if ("degraded" in from) return `actuals degraded=${from.degraded} — `;
  const r = from.receipt;
  return `actuals claimed=${minutes(r.claimedMinutes)} est=${estimateField(r.estimate)} `
    + `worklog=${r.worklog} — `;
}

/**
 * Reads and deletes the receipt for one issue. Exactly one of `receipt` /
 * `degraded` is set. An unreadable file is deleted too -- a corrupt receipt
 * left behind would degrade every later append for the same id the same way.
 */
export function takeReceipt(projectDir: string, issueId: string):
  { receipt: CloseReceipt; degraded?: undefined }
  | { receipt?: undefined; degraded: ReceiptDegraded } {
  const path = receiptPath(projectDir, issueId);
  let raw: string;
  try {
    if (!existsSync(path)) return { degraded: "no_receipt" };
    raw = readFileSync(path, "utf8");
  } catch {
    return { degraded: "receipt_unreadable" };
  }
  try { unlinkSync(path); } catch { /* a stale file is a smaller harm than a failed append */ }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReceipt(parsed, issueId)
      ? { receipt: parsed }
      : { degraded: "receipt_unreadable" };
  } catch {
    return { degraded: "receipt_unreadable" };
  }
}
