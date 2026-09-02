export interface DocsDriftItem {
    phase: string;
    reason: string;
}
export interface DocsDriftReport {
    flagged: DocsDriftItem[];
    ok: string[];
}
/**
 * Deterministic docs-drift report -- which verified phases (live AND
 * archived) the public docs have not caught up with. Two signals per phase,
 * either miss flags it:
 *   (a) no file in CHANGELOG.md + the docs/ tree mentions the phase
 *       (by "phase N" label or by name);
 *   (b) the newest git commit touching docs/CHANGELOG.md predates the
 *       phase's last LEDGER.md commit.
 * Pure filesystem + git reads -- no tracker, no LLM judgment, no Date.now.
 */
export declare function docsDriftReport(projectDir: string): DocsDriftReport;
