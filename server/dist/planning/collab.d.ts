import type { Issue, Tracker } from "../tracker/types.js";
export declare function unplannedReport(tracker: Tracker, projectDir: string): Promise<{
    unplanned: Issue[];
    referencedCount: number;
}>;
