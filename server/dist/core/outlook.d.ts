import { z } from "zod";
/**
 * The outlook snapshot (#55/#88): a compact, machine-readable "where this
 * project stands" written as a side effect of state-changing tool calls.
 * Everything derivable locally is re-derived fresh on every emit; the
 * `tracker` block is verb-supplied (issue counts, next verb) and merges
 * forward from the previous snapshot so a plain emit can't erase it.
 * Zero network at emit time, always.
 */
export interface OutlookPhase {
    number: number;
    name: string;
    planned: boolean;
    verified: boolean;
    issueCount: number;
}
export interface OutlookTracker {
    open?: number;
    inProgress?: number;
    blocked?: number;
    nextVerb?: string;
    asOf?: string;
}
export interface OutlookSnapshot {
    version: 1;
    ts: string;
    name: string;
    path: string;
    head?: string;
    phases: OutlookPhase[];
    sessions: {
        trace: number;
        probe: number;
        draft: number;
        thread: number;
    };
    tracker?: OutlookTracker;
}
export declare const OutlookSnapshotSchema: z.ZodType<OutlookSnapshot>;
/** The machine-wide mirror the aggregate reads (never walks repos). */
export declare function outlookMirrorPath(projectDir: string, home?: string): string;
/** The in-repo copy -- travels with the project, diffable when committed. */
export declare function outlookLocalPath(projectDir: string): string;
/**
 * Derives a fresh snapshot and dual-writes it (in-repo + machine mirror),
 * both atomic. Mirrors writeHandoff's guards: unregistered projects skip
 * silently (CONFIG_MISSING), and the previous snapshot's verb-supplied
 * `tracker` block carries forward unless this emit brings a newer one --
 * the outlook cousin of the handoff's monotonic-richness rule.
 *
 * Callers treat this as fire-and-forget; the refreshHandoff wrapper (and
 * any other call site) swallows what this throws.
 */
export declare function emitOutlook(projectDir: string, patch?: {
    tracker?: OutlookTracker;
}, home?: string): void;
/** Reads a project's mirror snapshot; corrupt or missing reads as null. */
export declare function readOutlook(projectDir: string, home?: string): OutlookSnapshot | null;
export interface OutlookCard {
    name: string;
    path: string;
    lastSeen: string;
    snapshot?: OutlookSnapshot;
    stale?: boolean;
    staleReason?: string;
    error?: string;
}
/** The written board (#91) -- machine-level on purpose: an in-repo copy of
 *  the FLEET board would leak every other project's name into whichever repo
 *  committed it. One artifact per machine, shareable by hand. */
export declare function outlookArtifactPath(home?: string): string;
/** Renders the board as manager-facing markdown -- same data as the cards. */
export declare function renderOutlookMd(cards: OutlookCard[], now: string): string;
/**
 * The portfolio aggregate (#89): registry + mirror snapshots ONLY -- never
 * walks the filesystem for repos. Staleness is the card pattern, not a
 * date: the snapshot's recorded HEAD vs the repo's live HEAD. Per-project
 * failures become `{name, error}` cards (workspace_status precedent);
 * one broken project can never take down the board.
 */
export declare function outlookAggregate(home?: string, opts?: {
    artifact?: boolean;
}): {
    projects: OutlookCard[];
    artifactPath?: string;
};
