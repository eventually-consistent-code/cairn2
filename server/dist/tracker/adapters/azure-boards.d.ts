import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Phase, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    orgUrl: z.ZodString;
    project: z.ZodString;
    workItemType: z.ZodDefault<z.ZodString>;
    patEnv: z.ZodDefault<z.ZodString>;
    apiVersion: z.ZodDefault<z.ZodString>;
    states: z.ZodDefault<z.ZodObject<{
        in_progress: z.ZodString;
        closed: z.ZodString;
        open: z.ZodDefault<z.ZodString>;
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
    orgUrl: string;
    project: string;
    workItemType: string;
    patEnv: string;
    apiVersion: string;
    states: {
        open: string;
        in_progress: string;
        closed: string;
    };
}, {
    orgUrl: string;
    project: string;
    workItemType?: string | undefined;
    patEnv?: string | undefined;
    apiVersion?: string | undefined;
    states?: {
        in_progress: string;
        closed: string;
        open?: string | undefined;
    } | undefined;
}>;
type Config = z.infer<typeof configSchema>;
export declare function make(config: Config, fetchImpl?: FetchLike): Tracker;
export declare function resolveAzurePat(patEnv: string): string;
export declare class AzureBoardsTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly tokenProvider;
    readonly capabilities: Capability;
    /** id (GUID) -> full iteration path, refreshed from listPhases() when an unknown id shows up. */
    private phasePaths;
    /** Tracks whether we've called listPhases() once on this instance (guards against infinite refresh loops). */
    private phasesLoaded;
    constructor(cfg: Config, fetchImpl?: FetchLike, tokenProvider?: () => string);
    private headers;
    private url;
    private api;
    private assertId;
    private get projectPath();
    private normalizeState;
    private normalize;
    /** Escapes single quotes in a WIQL string literal by doubling them. */
    private escapeWiql;
    /**
     * Normalizes a classificationnodes iteration path to the System.IterationPath
     * format: strips a leading backslash and the literal "Iteration\" segment
     * classificationnodes includes but System.IterationPath doesn't, e.g.
     * `\Proj\Iteration\Sprint 1` -> `Proj\Sprint 1`.
     */
    private normalizeIterationPath;
    /** Flattens a classificationnodes response into a flat list of leaf-ish iteration nodes, tolerating both response shapes. */
    private flattenIterationNodes;
    /** Resolves a phase id (GUID) to its iteration path, refreshing the map from listPhases() if unknown. */
    private resolvePhasePath;
    /** Resolves an iteration path to a phase id (GUID), self-healing the map on miss if not yet loaded. */
    private phaseIdForPath;
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
