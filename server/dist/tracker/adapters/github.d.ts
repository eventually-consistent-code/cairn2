import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    repo: z.ZodString;
}, "strip", z.ZodTypeAny, {
    repo: string;
}, {
    repo: string;
}>;
export declare function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker;
export declare function resolveGithubToken(): string;
export declare class GitHubTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly tokenProvider;
    readonly capabilities: Capability;
    constructor(cfg: {
        repo: string;
    }, fetchImpl?: FetchLike, tokenProvider?: () => string);
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
}
