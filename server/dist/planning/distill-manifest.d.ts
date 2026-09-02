export interface DistillLedgerEntry {
    taskRef: string;
    summary: string;
    baseCommit: string;
    headCommit: string;
    issueId: string;
    closedDate: string;
}
export interface DistillManifest {
    /** `dir` is the phase's path relative to the plans root minus the live
     *  "phases/" prefix -- "01-core" live, "milestones/v1/01-core" archived --
     *  the same id convention docs-drift reports use. */
    phase: {
        number: number;
        name: string;
        dir: string;
        archived: boolean;
    };
    issues: string[];
    ledgerEntries: DistillLedgerEntry[];
    /** Union range the ledger lines span: first entry's base to last entry's
     *  head (the ledger is append-only, so file order IS chronological order).
     *  Null when the ledger has no parsed entries. */
    commitRange: {
        base: string;
        head: string;
    } | null;
    /** One note per ledger line that LOOKED like an entry but didn't match the
     *  writer's grammar -- surfaced, not silently dropped. */
    skipped: string[];
}
/**
 * Assemble the distill manifest for one phase: its PLAN.md issues, its
 * LEDGER.md entries (each carrying the commit range the task landed as), and
 * the union commit range those entries span. Pure filesystem reads -- no git,
 * no tracker, no LLM judgment; same repo state, same manifest.
 *
 * :param projectDir: project root (the dir holding .cairn/)
 * :param phaseNumber: phase number, integer or one-decimal (1, 1.5, ...)
 * :returns DistillManifest scoped to exactly what the phase changed
 * :throws CairnError CONFIG_INVALID for a malformed phase number,
 *   NOT_FOUND when no live or archived phase dir carries that number
 */
export declare function distillManifest(projectDir: string, phaseNumber: number): DistillManifest;
