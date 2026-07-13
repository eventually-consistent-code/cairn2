import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker } from "../types.js";
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
    tokenEnv: string;
    baseUrl: string;
    projectKey: string;
    issueType: string;
    emailEnv: string;
    transitions: {
        in_progress: string;
        closed: string;
    };
}, {
    baseUrl: string;
    projectKey: string;
    tokenEnv?: string | undefined;
    issueType?: string | undefined;
    emailEnv?: string | undefined;
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
    updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
    closeIssue(id: string): Promise<Issue>;
    listIssues(filter?: {
        phase?: string;
        state?: IssueState;
    }): Promise<Issue[]>;
    createPhase(name: string): Promise<Phase>;
    listPhases(): Promise<Phase[]>;
}
export {};
