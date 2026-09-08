import type { Issue } from "../tracker/types.js";
export declare const DEFAULT_TOKENS_PER_ISSUE: {
    low: number;
    high: number;
};
export declare const DEFAULT_PHASE_TOKENS: {
    low: number;
    high: number;
};
export declare const DEFAULT_USD_PER_MTOK: {
    low: number;
    high: number;
};
export interface TokenEstimate {
    phase: number;
    range: {
        low: number;
        high: number;
    };
    unit: "tokens";
    estUsd: {
        low: number;
        high: number;
    };
    basis: {
        historyPhases: number;
        pointsTotal: number | null;
        issueCount: number;
        /** How many real (phase total, issue count) pairs fed the per-issue
         *  grain -- 0 means the range came from whole-phase totals or defaults. */
        perIssuePairs: number;
    };
    confidence: "wide" | "calibrated";
    notes: string[];
}
/** Minimal tracker slice -- estimation only ever reads issues. */
export interface IssueReader {
    getIssue(id: string): Promise<Issue>;
}
export interface TokenEstimateOptions {
    /** Override the metrics log path -- tests point this at a fixture instead
     *  of the real ~/.cairn/metrics file. */
    metricsFile?: string;
    /** Tracker for per-issue point estimates. Optional -- estimation degrades
     *  to issue counts alone when absent or failing. */
    tracker?: IssueReader;
}
/**
 * Estimate a phase's agent-token spend as a range, before it runs.
 *
 * Method: collapse metrics history (latest row per session, grouped by phase
 * tag), derive tokens-per-point / tokens-per-issue / tokens-per-phase
 * distributions from completed phases, then scale by the target phase's
 * points and issue count. No usable history degrades to a published wide
 * default with confidence "wide" and an honest note.
 *
 * "Tokens" here means input + output only -- cache traffic is excluded from
 * the unit but folded into the history-derived USD rate, so estUsd stays
 * honest about where the money actually goes.
 *
 * :param projectDir: project root (its .cairn/plans + hashed metrics file)
 * :param phaseNumber: target phase -- decimals accepted (1.5 slots between 1 and 2)
 * :param opts: metricsFile override (tests) + optional tracker for points
 */
export declare function estimatePhaseTokens(projectDir: string, phaseNumber: number, opts?: TokenEstimateOptions): Promise<TokenEstimate>;
