import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssueLink, IssuePatch, IssueState, LinkType, Milestone, Phase, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    teamId: z.ZodString;
    apiKeyEnv: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    teamId: string;
    apiKeyEnv: string;
}, {
    teamId: string;
    apiKeyEnv?: string | undefined;
}>;
export declare function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker;
export declare class LinearTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly keyProvider;
    readonly capabilities: Capability;
    private statesCache;
    private labelCache;
    constructor(cfg: {
        teamId: string;
        apiKeyEnv: string;
    }, fetchImpl?: FetchLike, keyProvider?: () => string);
    private gql;
    private normalize;
    /** Team workflow states, fetched once. */
    private states;
    /** SPI state → a team stateId: canonical three by bucket, anything else
     *  matched against the team's workflow state names (CRN-26). */
    private stateId;
    /** Label names → ids, find-or-create against the team. */
    private labelIds;
    createIssue(input: IssueCreate): Promise<Issue>;
    getIssue(id: string): Promise<Issue>;
    updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
    closeIssue(id: string): Promise<Issue>;
    listIssues(filter?: {
        phase?: string;
        state?: IssueState;
    }): Promise<Issue[]>;
    private normalizePhase;
    createPhase(name: string): Promise<Phase>;
    listPhases(): Promise<Phase[]>;
    /** Org project statuses, fetched once — close writes the 'completed' one. */
    private completedStatusCache;
    private completedStatusId;
    closePhase(id: string): Promise<Phase>;
    createMilestone(_name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(_id: string): Promise<Milestone>;
    /** Identifier (ENG-123) → internal UUID; free NOT_FOUND on missing issues. */
    private uuid;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
    private static readonly RELATION_TYPE;
    private static readonly FROM_RELATION_TYPE;
    linkIssues(from: string, type: LinkType, to: string): Promise<void>;
    unlinkIssues(from: string, type: LinkType, to: string): Promise<void>;
    private issueLinksRaw;
    listLinks(id?: string): Promise<IssueLink[]>;
}
export declare function resolveLinearKey(apiKeyEnv: string): string;
