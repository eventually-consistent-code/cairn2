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
/** Where an estimate number came from. A real tracker field and a regex
 *  scrape of a prose line are NOT the same evidence -- pooling them without
 *  saying so is how a calibration curve gets fitted to a parser bug. */
export type EstimateSource = "field" | "body";
/** How many numbers in a pool came from each source. */
export interface SourceTally {
    field: number;
    body: number;
}
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
        /** Minutes the target phase's issues estimate -- native minutes field, or
         *  the hours half of the body line x 60. Null when nothing resolves. */
        minutesTotal: number | null;
        issueCount: number;
        /** How many real (phase total, issue count) pairs fed the per-issue
         *  grain -- 0 means the range came from whole-phase totals or defaults. */
        perIssuePairs: number;
        /** How many completed phases fed the tokens-per-minute grain -- 0 means
         *  minutes contributed nothing to this range. */
        perMinutePairs: number;
        /** Provenance of the TARGET phase's numbers, carried not inferred. */
        estimateSources: {
            points: SourceTally;
            minutes: SourceTally;
        };
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
/** What one issue estimates, with the provenance of each number. */
export interface IssueEstimateRead {
    points: number | null;
    minutes: number | null;
    /** Null exactly where the matching number is null. */
    pointsSource: EstimateSource | null;
    minutesSource: EstimateSource | null;
}
/**
 * Estimate a phase's agent-token spend as a range, before it runs.
 *
 * Method: collapse metrics history (latest row per session, grouped by phase
 * tag), derive tokens-per-point / tokens-per-minute / tokens-per-issue /
 * tokens-per-phase distributions from completed phases, then scale by the
 * target phase's points, estimated minutes and issue count. No usable history
 * degrades to a published wide default with confidence "wide" and an honest
 * note.
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
