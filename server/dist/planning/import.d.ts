import type { Tracker } from "../tracker/types.js";
export interface ImportResult {
    dir: string;
    number: number;
    name: string;
    trackerPhaseId: string;
    issues: string[];
    created: string[];
}
export declare function importPhase(tracker: Tracker, projectDir: string, phaseRef: string): Promise<ImportResult>;
