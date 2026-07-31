/** The semantic bucket every cairn mechanism reasons about — drift math,
 *  ship gates, ready frontier, filters. Never compare `Issue.state` to a
 *  literal; compare `Issue.category`. */
export type StateCategory = "open" | "in_progress" | "closed";
/** Widened (CRN-26): an issue's state is its REAL workflow state name —
 *  "In Review", "Blocked", whatever the board says. The canonical three are
 *  always valid values and always writable on every backend. */
export type IssueState = string;
export interface Issue {
    id: string;
    title: string;
    body: string;
    /** Display-fidelity state name; falls back to the category string on
     *  backends with no richer name. */
    state: IssueState;
    /** Semantic bucket — the thing to branch on. */
    category: StateCategory;
    labels: string[];
    phase?: string;
    assignee?: string;
    estimate?: IssueEstimate;
    updatedAt: string;
    url: string;
}
/** Story points and/or an original time estimate — hasEstimates backends only. */
export interface IssueEstimate {
    points?: number;
    minutes?: number;
}
/** List-filter semantics after the widening: a state filter matches by
 *  semantic category OR by exact display name. */
export declare function matchesState(issue: Issue, state: string): boolean;
/** Guard for backends with NO custom-state surface — anything beyond the
 *  canonical three is a config error there, never a silent no-op. */
export declare function assertCanonicalState(state: string | undefined, backend: string): void;
export interface Phase {
    id: string;
    name: string;
    number?: number;
    state: "open" | "closed";
}
export interface Capability {
    hasInProgress: boolean;
    hasPhases: boolean;
    hasDependencies: boolean;
    hasLabels: boolean;
    hasMilestones: boolean;
    hasPhaseClose: boolean;
    hasComments: boolean;
    hasWorklog: boolean;
    hasEstimates: boolean;
    hasIssueAttachments: boolean;
}
export interface Milestone {
    id: string;
    name: string;
    state: "open" | "released";
    url?: string;
}
export interface IssueCreate {
    title: string;
    body?: string;
    labels?: string[];
    phase?: string;
    estimate?: IssueEstimate;
}
export interface IssuePatch {
    title?: string;
    body?: string;
    state?: IssueState;
    labels?: string[];
    assignee?: string;
    estimate?: IssueEstimate;
}
export interface IssueComment {
    at?: string;
    author?: string;
    text: string;
}
export interface WorklogEntry {
    at?: string;
    author?: string;
    minutes: number;
}
export type LinkType = "blocks" | "parent-of" | "relates-to" | "supersedes";
export interface IssueLink {
    from: string;
    type: LinkType;
    to: string;
}
/** Credential-preflight verdict (CRN-48) — one cheap authenticated call,
 *  mapped onto a specific, actionable bucket instead of a generic failure. */
export type ProbeVerdict = "ok" | "bad_host" | "bad_token" | "missing_scope" | "rate_limited" | "down";
export interface ProbeResult {
    verdict: ProbeVerdict;
    detail?: string;
}
export interface Tracker {
    readonly capabilities: Capability;
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
    /** Log time against an issue. Present only on adapters with hasWorklog. */
    logWork?(id: string, minutes: number): Promise<void>;
    /** Backend-native identifier for the authenticated user (assignee form).
     *  Present only on adapters that can derive it. Memoized per instance. */
    resolveSelf?(): Promise<string | undefined>;
    /** Cheap credential preflight -- one authenticated call, mapped to a
     *  specific verdict. A probe failure IS the result: this never throws. */
    probe?(): Promise<ProbeResult>;
    /** Issue links. Present only on adapters with hasDependencies. */
    linkIssues?(from: string, type: LinkType, to: string): Promise<void>;
    unlinkIssues?(from: string, type: LinkType, to: string): Promise<void>;
    /** id given → links touching that issue (either direction); omitted → all. */
    listLinks?(id?: string): Promise<IssueLink[]>;
    /** History reads — present where the backend can enumerate them
     *  (migration sources). */
    listComments?(id: string): Promise<IssueComment[]>;
    listWorklogs?(id: string): Promise<WorklogEntry[]>;
    /** Binary evidence (screenshots, renders) on an issue. Present only on
     *  adapters with hasIssueAttachments. */
    attachFile?(id: string, filename: string, data: Buffer, mediaType?: string): Promise<{
        id?: string;
        url?: string;
    }>;
}
