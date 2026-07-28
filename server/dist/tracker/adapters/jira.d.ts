import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    baseUrl: z.ZodString;
    projectKey: z.ZodString;
    issueType: z.ZodDefault<z.ZodString>;
    emailEnv: z.ZodDefault<z.ZodString>;
    tokenEnv: z.ZodDefault<z.ZodString>;
    transitions: z.ZodDefault<z.ZodObject<{
        in_progress: z.ZodString;
        closed: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        in_progress: string;
        closed: string;
    }, {
        in_progress: string;
        closed: string;
    }>>;
}, "strip", z.ZodTypeAny, {
    baseUrl: string;
    emailEnv: string;
    tokenEnv: string;
    projectKey: string;
    issueType: string;
    transitions: {
        in_progress: string;
        closed: string;
    };
}, {
    baseUrl: string;
    projectKey: string;
    emailEnv?: string | undefined;
    tokenEnv?: string | undefined;
    issueType?: string | undefined;
    transitions?: {
        in_progress: string;
        closed: string;
    } | undefined;
}>;
type JiraConfig = z.infer<typeof configSchema>;
export declare function make(config: JiraConfig, fetchImpl?: FetchLike): Tracker;
export declare function resolveJiraAuth(cfg: JiraConfig): {
    email: string;
    token: string;
};
export declare class JiraTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly authProvider;
    readonly capabilities: Capability;
    private projectId;
    constructor(cfg: JiraConfig, fetchImpl?: FetchLike, authProvider?: () => {
        email: string;
        token: string;
    });
    private headers;
    private api;
    private assertId;
    private normalize;
    /** GET transitions for `key`, find one whose `to.name` or transition `name` matches (case-insensitive), POST it. */
    private transitionByName;
    /** in_progress -> open has no fixed target name; find any transition whose target category is 'new'. */
    private transitionToOpenCategory;
    createIssue(input: IssueCreate): Promise<Issue>;
    getIssue(id: string): Promise<Issue>;
    private self;
    resolveSelf(): Promise<string | undefined>;
    /** Assignee values may arrive as an email (user.handle) — Jira wants accountId. */
    private toAccountId;
    updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
    closeIssue(id: string): Promise<Issue>;
    listIssues(filter?: {
        phase?: string;
        state?: IssueState;
    }): Promise<Issue[]>;
    createPhase(name: string): Promise<Phase>;
    listPhases(): Promise<Phase[]>;
    private resolveProjectId;
    private normalizeVersion;
    closePhase(id: string): Promise<Phase>;
    createMilestone(name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
    logWork(id: string, minutes: number): Promise<void>;
}
export {};
