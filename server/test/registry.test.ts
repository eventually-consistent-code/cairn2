import { describe, it, expect } from "vitest";
import { makeTracker, importErrorToCairn } from "../src/tracker/registry.js";
import { GitHubTracker } from "../src/tracker/adapters/github.js";
import type { CairnConfig } from "../src/config.js";

const cfg = (type: string, config: Record<string, unknown>): CairnConfig =>
  ({ tracker: { type: type as CairnConfig["tracker"]["type"], config },
     agents: { model: "auto" } });

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

  it("names unimplemented backends clearly", async () => {
    // The gitlab adapter doesn't exist, so import() will throw a module-not-found error
    // Our error handler should map this to CONFIG_INVALID with "not yet implemented"
    await expect(makeTracker(cfg("gitlab", {})))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
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
