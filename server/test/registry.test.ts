import { describe, it, expect } from "vitest";
import { makeTracker } from "../src/tracker/registry.js";
import { GitHubTracker } from "../src/tracker/adapters/github.js";
import type { CairnConfig } from "../src/config.js";

const cfg = (type: string, config: Record<string, unknown>): CairnConfig =>
  ({ tracker: { type: type as CairnConfig["tracker"]["type"], config },
     agents: { model: "auto" } });

describe("makeTracker", () => {
  it("builds a GitHubTracker for type=github", () => {
    expect(makeTracker(cfg("github", { repo: "o/r" }))).toBeInstanceOf(GitHubTracker);
  });

  it("rejects github config missing repo", () => {
    expect(() => makeTracker(cfg("github", {})))
      .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("names unimplemented backends clearly", () => {
    expect(() => makeTracker(cfg("clickup", {})))
      .toThrowError(/clickup.*not yet implemented/);
  });
});
