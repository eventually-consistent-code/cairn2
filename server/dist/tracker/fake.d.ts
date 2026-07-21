import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, Tracker } from "./types.js";
export declare class FakeTracker implements Tracker {
    readonly capabilities: Capability;
    private issues;
    private phases;
    private milestones;
    private issueComments;
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
    closePhase(id: string): Promise<Phase>;
    createMilestone(name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
    /** Test accessor: comments posted to an issue, in order. */
    comments(id: string): Array<{
        id: string;
        text: string;
    }>;
}
