export type ErrorCode = "CONFIG_MISSING" | "CONFIG_INVALID" | "AUTH_MISSING" | "RATE_LIMITED" | "NOT_FOUND" | "TRACKER_DOWN";
export declare class CairnError extends Error {
    readonly code: ErrorCode;
    readonly nextAction?: string | undefined;
    constructor(code: ErrorCode, message: string, nextAction?: string | undefined);
}
