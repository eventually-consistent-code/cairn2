export type ErrorCode =
  | "CONFIG_MISSING" | "CONFIG_INVALID" | "AUTH_MISSING"
  | "RATE_LIMITED" | "NOT_FOUND" | "TRACKER_DOWN"
  | "HANDOFF_INVALID" | "HANDOFF_STALE";

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
