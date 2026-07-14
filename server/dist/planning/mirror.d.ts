import type { Phase, Tracker } from "../tracker/types.js";
export declare const canonicalPhaseName: (number: number, name: string) => string;
export declare function ensurePhase(tracker: Tracker, number: number, name: string): Promise<Phase>;
export interface DriftItem {
    issueId: string;
    phase: number;
    reason: "missing" | "closed";
}
export declare function driftReport(tracker: Tracker, projectDir: string): Promise<{
    flagged: DriftItem[];
    ok: string[];
}>;
