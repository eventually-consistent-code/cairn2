import type { Milestone, Tracker } from "../tracker/types.js";
export interface RoadmapMeta {
    milestone: number;
    milestoneId?: string;
    lastResync?: string;
}
export declare function readRoadmapMeta(projectDir: string): RoadmapMeta;
export declare function patchRoadmapMeta(projectDir: string, patch: {
    milestone?: number;
    milestoneId?: string | null;
    lastResync?: string;
}): void;
/** One phase row of a roadmap table, with the line it came from. */
export interface RoadmapRow {
    /** The Phase cell, parsed -- decimal phases included. */
    number: number;
    /** The Name cell, trimmed. */
    name: string;
    /** The Status cell, trimmed and verbatim -- never normalised. */
    status: string;
    /** Index into the body's lines: where a patch lands. */
    line: number;
}
/** A Status cell a patch actually rewrote. */
export interface RoadmapRowPatch {
    number: number;
    from: string;
    to: string;
}
/** Every phase row of a roadmap body, in document order. */
export declare function parseRoadmapRows(body: string): RoadmapRow[];
/**
 * Rewrites the Status cell of every row `wanted` names whose current value
 * differs, preserving that cell's own padding so a patched row still lines
 * up with the hand-authored table around it. A row already saying the
 * right thing is not rewritten at all -- that is what makes the calling
 * scan idempotent, and silent in the steady state.
 *
 * :param body: roadmap body, frontmatter already stripped
 * :param wanted: phase number -> the Status that row should carry
 * :returns: the new body, and one entry per cell actually changed
 */
export declare function applyRoadmapRows(body: string, wanted: Map<number, string>): {
    body: string;
    applied: RoadmapRowPatch[];
};
/** The roadmap's phase rows, or none at all when there is no roadmap yet. */
export declare function readRoadmapRows(projectDir: string): RoadmapRow[];
/**
 * Patches Status cells in place and reports what moved. A project with no
 * roadmap.md is not an error here: the scans that call this run on every
 * status check, and a project mid-scaffold has nothing to say.
 *
 * :param projectDir: repository root
 * :param wanted: phase number -> the Status that row should carry
 * :returns: one entry per cell actually changed (empty = nothing to do)
 */
export declare function patchRoadmapRows(projectDir: string, wanted: Map<number, string>): RoadmapRowPatch[];
export interface MilestoneCompleteReport {
    closedPhases: string[];
    skippedPhases: Array<{
        dir: string;
        reason: string;
    }>;
    released?: Milestone;
    archivedTo: string;
    nextMilestone: number;
    /** Status cells this completion flipped to `shipped (vN)` (#185). */
    roadmapRows: RoadmapRowPatch[];
}
export declare function milestoneComplete(tracker: Tracker, projectDir: string, summary: string): Promise<MilestoneCompleteReport>;
export declare function milestoneCreate(tracker: Tracker, projectDir: string, name: string): Promise<{
    milestone: number;
    native?: Milestone;
}>;
export declare function milestoneList(tracker: Tracker, projectDir: string): Promise<{
    current: number;
    currentId?: string;
    archived: string[];
    native?: Milestone[];
}>;
