export type ErrorCode =
  | "CONFIG_MISSING" | "CONFIG_INVALID" | "AUTH_MISSING"
  | "RATE_LIMITED" | "NOT_FOUND" | "TRACKER_DOWN" | "TRACKER_REJECTED"
  | "HANDOFF_INVALID" | "HANDOFF_STALE"
  | "UNSUPPORTED" | "PRECONDITION_FAILED";

export class CairnError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly nextAction?: string,
  ) {
    super(message);
    this.name = "CairnError";
  }
}
