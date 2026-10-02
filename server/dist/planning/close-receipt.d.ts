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
export declare function receiptsDir(projectDir: string): string;
/** Writes the receipt. Returns false instead of throwing on any failure --
 *  the close has already happened and must report success regardless. */
export declare function writeReceipt(projectDir: string, receipt: CloseReceipt): boolean;
/**
 * The ledger line's `actuals` segment, placed before `<issueId> closed` like
 * the tdd and evidence segments. Space-separated key=value pairs so a later
 * reader can split it without knowing every key; never an em dash, which is
 * the line's field separator. A receipt-less append still gets the segment,
 * carrying only its degraded marker -- absence is stated, not implied.
 */
export declare function actualsSegment(from: {
    receipt: CloseReceipt;
} | {
    degraded: ReceiptDegraded;
}): string;
/**
 * Reads and deletes the receipt for one issue. Exactly one of `receipt` /
 * `degraded` is set. An unreadable file is deleted too -- a corrupt receipt
 * left behind would degrade every later append for the same id the same way.
 */
export declare function takeReceipt(projectDir: string, issueId: string): {
    receipt: CloseReceipt;
    degraded?: undefined;
} | {
    receipt?: undefined;
    degraded: ReceiptDegraded;
};
