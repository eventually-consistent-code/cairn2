import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, ProbeResult, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    projectGid: z.ZodString;
    tokenEnv: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    tokenEnv: string;
    projectGid: string;
}, {
    projectGid: string;
    tokenEnv?: string | undefined;
}>;
export declare function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker;
export declare class AsanaTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly tokenProvider;
    readonly capabilities: Capability;
    constructor(cfg: {
        projectGid: string;
        tokenEnv: string;
    }, fetchImpl?: FetchLike, tokenProvider?: () => string);
    private headers;
    private api;
    private assertId;
    /** Preflight: /projects/{projectGid} over /users/me -- /users/me only
     *  proves the token is valid, not that the configured project exists.
     *  A typo'd projectGid now 404s instead of reading "ok". */
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
    closePhase(_id: string): Promise<Phase>;
    createMilestone(_name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(_id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
}
export declare function resolveAsanaToken(tokenEnv: string): string;
