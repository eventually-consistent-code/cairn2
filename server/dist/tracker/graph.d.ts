import type { Issue, IssueLink } from "./types.js";
export interface PriorityEntry {
    id: string;
    declared?: string;
    effective: string;
    inheritedFrom?: string;
}
/**
 * Open issues with no open blockers — the pick-next-work list.
 * `A blocks B` means B waits on A; only `blocks` edges gate readiness.
 */
export declare function readyFrontier(issues: Issue[], links: IssueLink[]): Issue[];
/**
 * Dependency-chain priority inheritance: an issue is effectively as urgent
 * as the most urgent OPEN work it transitively blocks. Returns only issues
 * whose effective priority beats their declared one.
 */
export declare function effectivePriorities(issues: Issue[], links: IssueLink[]): PriorityEntry[];
/**
 * Iteration lineage through `supersedes` edges, oldest → newest.
 * `A supersedes B` means A is the next iteration of B.
 */
export declare function lineage(issues: Issue[], links: IssueLink[], id: string): string[];
/** Links whose endpoints no longer exist — medic's repair list. */
export declare function danglingEdges(issues: Issue[], links: IssueLink[]): IssueLink[];
