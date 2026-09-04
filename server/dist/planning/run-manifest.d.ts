/**
 * Purpose: the run manifest for headless batch runs (#132) — the staging
 *   interview's output and the executor's SOLE source of authority. One
 *   manifest per run, written when the user approves the staging gate:
 *   which phases run, their estimate ranges, the budget ceiling, and the
 *   push pre-authorization (REC-5 moved to run start, scope-limited to
 *   the manifest's phases — a phase outside the manifest never pushes).
 *
 *   Lives under ~/.cairn (never the repo) with the same path/injection
 *   conventions as budget-ledger.ts: per-machine project hash, filename-
 *   safe runId, raw run_id verified on load so a sanitize collision can't
 *   silently merge two runs. Versioned state file — z.literal(1) +
 *   safeParse + atomic tmp-then-rename write, continuity.ts precedent.
 *
 *   pushAuth starts FALSE and only grantPushAuth() flips it — creation can
 *   never smuggle authority in. Status walks a one-way lifecycle:
 *   staged → running → complete|stopped (staged may also go straight to
 *   stopped when a run is abandoned before it starts).
 * Author(s): John Reed
 */
import { z } from "zod";
/** ~/.cairn/runs/<project>-<hash>-<runId>.json — one manifest per run,
 * outside the repo. baseDir injectable for tests (budget-ledger convention). */
export declare function runManifestPath(projectDir: string, runId: string, baseDir?: string): string;
export type RunStatus = "staged" | "running" | "complete" | "stopped";
export interface ManifestPhase {
    number: number;
    name: string;
    estimate: {
        low: number;
        high: number;
        estUsd: {
            low: number;
            high: number;
        };
    };
    waves?: number;
}
export interface StagedAnswer {
    phase?: number | string;
    question: string;
    answer: string;
}
export interface RunManifestState {
    version: 1;
    runId: string;
    project: string;
    created: string;
    phases: ManifestPhase[];
    /** Budget ceiling the run was staged under; null = explicitly uncapped. */
    ceiling: {
        tokens?: number;
        usd?: number;
    } | null;
    /** Push pre-authorization (REC-5 at run start). granted=false means the
     * run is verify-stop: phases run headless but NOTHING pushes. Scope is
     * always the manifest's own phases — never wider. */
    pushAuth: {
        granted: boolean;
        scope: "manifest-phases";
        grantedAt?: string;
    };
    /** Staging question-round answers (scout batch form) that travel with
     * the run so the executor never has to ask mid-flight. */
    answers?: StagedAnswer[];
    status: RunStatus;
}
export declare const RunManifestSchema: z.ZodType<RunManifestState>;
/**
 * Writes a fresh manifest at staging time. One manifest per run — an
 * existing manifest for this runId throws instead of being overwritten
 * (re-staging a run means a new runId; history never gets clobbered).
 * pushAuth always starts granted:false — only grantPushAuth() can flip it.
 *
 * :param projectDir: the project the run belongs to
 * :returns the manifest state as written
 */
export declare function createRunManifest(projectDir: string, opts: {
    runId: string;
    phases: ManifestPhase[];
    ceiling?: {
        tokens?: number;
        usd?: number;
    } | null;
    answers?: StagedAnswer[];
    createdAt?: string;
    baseDir?: string;
}): RunManifestState;
/**
 * Reads a run's manifest without mutating anything — the executor's (and
 * status displays') view. Throws NOT_FOUND when the run was never staged.
 */
export declare function readRunManifest(projectDir: string, runId: string, baseDir?: string): RunManifestState;
/**
 * Records the user's explicit push pre-authorization from the staging gate.
 * Only callable while the run is still 'staged' — authority is granted at
 * the front door or not at all, never mid-run.
 */
export declare function grantPushAuth(projectDir: string, runId: string, opts?: {
    grantedAt?: string;
    baseDir?: string;
}): RunManifestState;
/**
 * Advances the run's status along the legal lifecycle
 * (staged → running → complete|stopped; staged → stopped for a run
 * abandoned before start). Any other move throws.
 */
export declare function setRunStatus(projectDir: string, runId: string, status: RunStatus, baseDir?: string): RunManifestState;
