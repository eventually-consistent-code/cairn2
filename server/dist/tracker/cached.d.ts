import { ReadCache } from "../core/cache.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker } from "./types.js";
/**
 * Caches read operations (getIssue, listIssues, listPhases) for 60s.
 * Any write invalidates the entire cache (whole-cache write-through invalidation).
 * All cached values are deep-cloned on read to prevent caller mutation poisoning.
 */
export declare class CachedTracker implements Tracker {
    private inner;
    readonly capabilities: Capability;
    private cache;
    constructor(inner: Tracker, cache?: ReadCache);
    private clone;
    createIssue(input: IssueCreate): Promise<Issue>;
    getIssue(id: string): Promise<Issue>;
    updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
    closeIssue(id: string): Promise<Issue>;
    listIssues(filter?: {
        phase?: string;
        state?: IssueState;
    }): Promise<Issue[]>;
    createPhase(name: string): Promise<Phase>;
    listPhases(): Promise<Phase[]>;
}
