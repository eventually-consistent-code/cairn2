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
