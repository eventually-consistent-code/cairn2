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
export interface MilestoneCompleteReport {
    closedPhases: string[];
    skippedPhases: Array<{
        dir: string;
        reason: string;
    }>;
    released?: Milestone;
    archivedTo: string;
    nextMilestone: number;
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
