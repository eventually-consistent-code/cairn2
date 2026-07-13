import { describe, it, expect } from "vitest";
import { makeTracker } from "../src/tracker/registry.js";
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
    await expect(makeTracker(cfg("gitlab", {})))
      .rejects.toThrowError(/gitlab.*not yet implemented/);
  });
});
