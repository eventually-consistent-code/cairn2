import type { Issue, IssueState, Phase, Tracker } from "../tracker/types.js";
export interface FieldChange {
    field: "title" | "body" | "labels" | "assignee";
    from?: string;
    to?: string;
}
export interface EditedItem {
    issue: Issue;
    changes: FieldChange[];
}
export interface StateChange {
    issue: Issue;
    from: IssueState;
    to: IssueState;
}
export interface TrackerDeltaReport {
    initialized: boolean;
    new: Issue[];
    newPhases: Phase[];
    edited: EditedItem[];
    stateChanged: StateChange[];
}
export declare const markerPath: (projectDir: string) => string;
/** Absorb a cairn-side mutation so it never echoes as an external change.
 *  Silent no-op before the first scan initializes the marker or if marker is corrupt. */
export declare function snapshotNote(projectDir: string, issue: Issue): void;
export declare function trackerDelta(projectDir: string, tracker: Tracker, opts?: {
    ack?: boolean;
}): Promise<TrackerDeltaReport>;
