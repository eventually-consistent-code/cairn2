import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker } from "./types.js";
export declare class FakeTracker implements Tracker {
    readonly capabilities: Capability;
    private issues;
    private phases;
    private seq;
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
