export type ErrorCode = "CONFIG_MISSING" | "CONFIG_INVALID" | "AUTH_MISSING" | "RATE_LIMITED" | "NOT_FOUND" | "TRACKER_DOWN" | "TRACKER_REJECTED" | "HANDOFF_INVALID" | "HANDOFF_STALE" | "UNSUPPORTED" | "PRECONDITION_FAILED";
export declare class CairnError extends Error {
    readonly code: ErrorCode;
    readonly nextAction?: string | undefined;
    constructor(code: ErrorCode, message: string, nextAction?: string | undefined);
}
