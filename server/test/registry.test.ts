import { describe, it, expect } from "vitest";
import { makeTracker, importErrorToCairn } from "../src/tracker/registry.js";
import { GitHubTracker } from "../src/tracker/adapters/github.js";
import type { CairnConfig } from "../src/config.js";

const cfg = (type: string, config: Record<string, unknown>): CairnConfig =>
  ({ tracker: { type: type as CairnConfig["tracker"]["type"], config },
     agents: { model: "auto" } });

// Minimal valid config per adapter's configSchema — used for the six-backend
// build smoke test below. None of the adapters resolve their token env var
// until the first API call, so this exercises construction only (no network,
// no env vars needed).
const MINIMAL: Record<string, Record<string, unknown>> = {
  github: { repo: "o/r" },
  gitlab: { project: "o/r" },
  jira: { baseUrl: "https://x.atlassian.net", projectKey: "X" },
  asana: { projectGid: "123" },
  "azure-boards": { orgUrl: "https://dev.azure.com/o", project: "P" },
  clickup: { defaultListId: "1", spaceId: "2" },
};

describe("makeTracker", () => {
  it("builds a GitHubTracker for type=github", async () => {
    expect(await makeTracker(cfg("github", { repo: "o/r" }))).toBeInstanceOf(GitHubTracker);
  });

  it("rejects github config missing repo", async () => {
    await expect(makeTracker(cfg("github", {}))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects path-traversal repo strings", async () => {
    await expect(makeTracker(cfg("github", { repo: "../.." })))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("builds a tracker for every supported type", async () => {
    for (const [type, config] of Object.entries(MINIMAL)) {
      expect(await makeTracker(cfg(type, config))).toBeTruthy();
    }
  });
});

describe("importErrorToCairn", () => {
  it("maps missing modules to CONFIG_INVALID with 'not yet implemented'", () => {
    const notFound = Object.assign(new Error("Module not found"), { code: "ERR_MODULE_NOT_FOUND" });
    const err = importErrorToCairn("clickup", notFound);
    expect(err).toMatchObject({ code: "CONFIG_INVALID" });
    expect(err.message).toMatch(/not yet implemented/);
  });

  it("maps broken adapter modules to TRACKER_DOWN with error details", () => {
    const broken = new Error("boom at import time");
    const err = importErrorToCairn("clickup", broken);
    expect(err).toMatchObject({ code: "TRACKER_DOWN" });
    expect(err.message).toMatch(/failed to load/);
    expect(err.message).toMatch(/boom at import time/);
  });
});
