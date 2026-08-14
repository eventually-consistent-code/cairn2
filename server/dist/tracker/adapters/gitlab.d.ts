import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, ProbeResult, Tracker } from "../types.js";
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
    /** Preflight: GET /projects/{project} (project-scoped, same URL base()
     *  already builds) over the site-root /user -- /user only proves the
     *  token is valid, not that the configured project exists. A typo'd
     *  project now 404s instead of reading "ok". Single attempt, no retry
     *  backoff -- a probe wants a fast verdict, not resilience. */
    probe(): Promise<ProbeResult>;
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
    extraLabels: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker;
