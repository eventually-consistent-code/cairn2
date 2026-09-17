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
/**
 * Appends one formatted line to a phase's LEDGER.md, creating the file (with
 * header) on first append. Never rewrites existing content -- append-only,
 * so the ledger stays a trustworthy record even if a session crashes
 * mid-task. Ledger rides into git with the closing commit; the server just
 * writes the bytes.
 */
export declare function appendLedger(projectDir: string, phaseDir: string, entry: LedgerEntryInput): {
    path: string;
    line: string;
};
