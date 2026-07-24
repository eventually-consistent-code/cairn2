import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, Tracker } from "../types.js";
export declare class GitLabTracker implements Tracker {
    private cfg;
    private fetchImpl;
    readonly capabilities: Capability;
    constructor(cfg: z.infer<typeof configSchema>, fetchImpl?: FetchLike);
    private token;
    private base;
    private headers;
    private api;
    private assertId;
    private normalize;
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
    createMilestone(_name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(_id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
}
export declare const configSchema: z.ZodObject<{
    baseUrl: z.ZodDefault<z.ZodString>;
    project: z.ZodString;
    tokenEnv: z.ZodDefault<z.ZodString>;
    extraLabels: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    project: string;
    baseUrl: string;
    tokenEnv: string;
    extraLabels: string[];
}, {
    project: string;
    baseUrl?: string | undefined;
    tokenEnv?: string | undefined;
    extraLabels?: string[] | undefined;
}>;
export declare function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker;
