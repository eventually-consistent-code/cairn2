import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker } from "../types.js";
export declare const configSchema: z.ZodEffects<z.ZodObject<{
    defaultListId: z.ZodString;
    folderId: z.ZodOptional<z.ZodString>;
    spaceId: z.ZodOptional<z.ZodString>;
    tokenEnv: z.ZodDefault<z.ZodString>;
    statuses: z.ZodDefault<z.ZodObject<{
        open: z.ZodDefault<z.ZodString>;
        in_progress: z.ZodString;
        closed: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        open: string;
        in_progress: string;
        closed: string;
    }, {
        in_progress: string;
        closed: string;
        open?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    tokenEnv: string;
    defaultListId: string;
    statuses: {
        open: string;
        in_progress: string;
        closed: string;
    };
    folderId?: string | undefined;
    spaceId?: string | undefined;
}, {
    defaultListId: string;
    tokenEnv?: string | undefined;
    folderId?: string | undefined;
    spaceId?: string | undefined;
    statuses?: {
        in_progress: string;
        closed: string;
        open?: string | undefined;
    } | undefined;
}>, {
    tokenEnv: string;
    defaultListId: string;
    statuses: {
        open: string;
        in_progress: string;
        closed: string;
    };
    folderId?: string | undefined;
    spaceId?: string | undefined;
}, {
    defaultListId: string;
    tokenEnv?: string | undefined;
    folderId?: string | undefined;
    spaceId?: string | undefined;
    statuses?: {
        in_progress: string;
        closed: string;
        open?: string | undefined;
    } | undefined;
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
}
