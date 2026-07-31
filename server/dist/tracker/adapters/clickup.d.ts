import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, ProbeResult, Tracker } from "../types.js";
export declare const configSchema: z.ZodEffects<z.ZodObject<{
    defaultListId: z.ZodString;
    folderId: z.ZodOptional<z.ZodString>;
    spaceId: z.ZodOptional<z.ZodString>;
    tokenEnv: z.ZodDefault<z.ZodString>;
    statuses: z.ZodEffects<z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>, Record<string, string>, Record<string, string> | undefined>;
}, "strip", z.ZodTypeAny, {
    tokenEnv: string;
    defaultListId: string;
    statuses: Record<string, string>;
    folderId?: string | undefined;
    spaceId?: string | undefined;
}, {
    defaultListId: string;
    tokenEnv?: string | undefined;
    folderId?: string | undefined;
    spaceId?: string | undefined;
    statuses?: Record<string, string> | undefined;
}>, {
    tokenEnv: string;
    defaultListId: string;
    statuses: Record<string, string>;
    folderId?: string | undefined;
    spaceId?: string | undefined;
}, {
    defaultListId: string;
    tokenEnv?: string | undefined;
    folderId?: string | undefined;
    spaceId?: string | undefined;
    statuses?: Record<string, string> | undefined;
}>;
export type ClickUpConfig = z.infer<typeof configSchema>;
export declare function make(config: ClickUpConfig, fetchImpl?: FetchLike): Tracker;
export declare function resolveClickUpToken(tokenEnv: string): string;
export declare class ClickUpTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly tokenProvider;
    readonly capabilities: Capability;
    constructor(cfg: ClickUpConfig, fetchImpl?: FetchLike, tokenProvider?: () => string);
    private headers;
    private api;
    private assertId;
    /** Preflight: /team is ClickUp's cheapest authenticated call. */
    probe(): Promise<ProbeResult>;
    /** Validates a caller-supplied phase (list) id before it reaches a URL. defaultListId is trusted config, not user input. */
    private assertPhaseId;
    private normalizeState;
    private normalize;
    createIssue(input: IssueCreate): Promise<Issue>;
    getIssue(id: string): Promise<Issue>;
    /** Adds/removes tags to match `desired`, given the tags currently on the task (by name). */
    private reconcileTags;
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
