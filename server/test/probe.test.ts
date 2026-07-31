// Shared credential-preflight helper (CRN-48) — verdict mapping in isolation,
// independent of any one adapter's transport.

import { describe, it, expect } from "vitest";
import { CairnError } from "../src/errors.js";
import { probeVerdictForError, runProbe } from "../src/tracker/probe.js";

describe("runProbe", () => {
  it("resolves to ok when the check succeeds", async () => {
    expect(await runProbe(async () => "anything")).toEqual({ verdict: "ok" });
  });

  it("never rethrows -- a rejected check becomes a verdict", async () => {
    await expect(runProbe(async () => {
      throw new CairnError("RATE_LIMITED", "HTTP 429 from https://x");
    })).resolves.toMatchObject({ verdict: "rate_limited" });
  });
});

describe("probeVerdictForError", () => {
  it("maps a network/DNS error (http.ts's tag) to bad_host", () => {
    const e = new CairnError("TRACKER_DOWN",
      "[github probe] network error calling https://api.github.com/user: TypeError: fetch failed");
    expect(probeVerdictForError(e)).toMatchObject({ verdict: "bad_host" });
  });

  it("maps NOT_FOUND on the probe endpoint to bad_host", () => {
    const e = new CairnError("NOT_FOUND", "404 from https://x/user");
    expect(probeVerdictForError(e)).toMatchObject({ verdict: "bad_host" });
  });

  it("maps a non-network TRACKER_DOWN to down", () => {
    const e = new CairnError("TRACKER_DOWN", "HTTP 500 from https://x/user");
    expect(probeVerdictForError(e)).toMatchObject({ verdict: "down" });
  });

  it("maps AUTH_MISSING with a scope-shaped nextAction to missing_scope", () => {
    const e = new CairnError("AUTH_MISSING", "HTTP 403 from https://x",
      "token is missing a required scope or permission — check the app's OAuth scopes or the account's access level");
    expect(probeVerdictForError(e)).toMatchObject({ verdict: "missing_scope" });
  });

  it("maps other AUTH_MISSING shapes (rejected token, org policy, no credentials) to bad_token", () => {
    const rejected = new CairnError("AUTH_MISSING", "HTTP 401 from https://x",
      "token was rejected — regenerate or check it matches the account");
    expect(probeVerdictForError(rejected)).toMatchObject({ verdict: "bad_token" });

    const policy = new CairnError("AUTH_MISSING", "HTTP 401 from https://x",
      "an org/workspace policy is blocking this token — check IP allowlists, SSO enforcement, or app restrictions");
    expect(probeVerdictForError(policy)).toMatchObject({ verdict: "bad_token" });

    const noCreds = new CairnError("AUTH_MISSING", "no GitHub credentials",
      "export GITHUB_TOKEN or run: gh auth login");
    expect(probeVerdictForError(noCreds)).toMatchObject({ verdict: "bad_token" });
  });

  it("maps RATE_LIMITED to rate_limited", () => {
    const e = new CairnError("RATE_LIMITED", "HTTP 429 from https://x/user");
    expect(probeVerdictForError(e)).toMatchObject({ verdict: "rate_limited" });
  });

  it("maps a non-CairnError to down", () => {
    expect(probeVerdictForError(new Error("boom"))).toMatchObject({ verdict: "down" });
  });
});
