// Shared credential-preflight helper (CRN-48). Every tracker/docs adapter's
// probe() funnels its one cheap authenticated call through runProbe(), which
// maps whatever http.ts's fetchRaw (or a synchronous credential-resolution
// throw) produced onto a specific, actionable verdict. Reuses #46's error
// diagnosability (truncated body, auth-shaped nextAction) instead of
// re-parsing response bodies here -- a probe failure IS the result, so this
// never rethrows.

import { CairnError } from "../errors.js";
import type { ProbeResult } from "./types.js";

// http.ts's fetchRaw tags a genuine network/DNS failure this way (optionally
// prefixed by a "[context] " tag) -- the only TRACKER_DOWN shape that means
// "couldn't even reach the host" rather than "host answered badly".
const NETWORK_ERROR_RE = /network error calling/;

// authNextAction's scope/permission branch is the only nextAction shape that
// should read as "wrong grant", not "wrong credential" -- everything else
// AUTH_MISSING throws (rejected token, org policy, or the generic fallback
// hint) is a bad/rejected token from the probe's point of view.
const SCOPE_RE = /scope|permission/i;

/** Maps a caught error from a probe's cheap call onto a ProbeResult. */
export function probeVerdictForError(e: unknown): ProbeResult {
  if (!(e instanceof CairnError)) {
    return { verdict: "down", detail: String(e) };
  }
  switch (e.code) {
    case "NOT_FOUND":
      return { verdict: "bad_host", detail: e.message };
    case "TRACKER_DOWN":
      return NETWORK_ERROR_RE.test(e.message)
        ? { verdict: "bad_host", detail: e.message }
        : { verdict: "down", detail: e.message };
    case "AUTH_MISSING": {
      const detail = e.nextAction ?? e.message;
      return { verdict: SCOPE_RE.test(detail) ? "missing_scope" : "bad_token", detail };
    }
    case "RATE_LIMITED":
      return { verdict: "rate_limited", detail: e.message };
    default:
      return { verdict: "down", detail: e.message };
  }
}

/**
 * Runs an adapter's cheap authenticated call and turns success/failure into
 * a ProbeResult. `check`'s return value is discarded -- only whether it
 * resolved or rejected (and how) matters.
 */
export async function runProbe(check: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await check();
    return { verdict: "ok" };
  } catch (e) {
    return probeVerdictForError(e);
  }
}
