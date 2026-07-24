import { describe, it, expect } from "vitest";
import { makeDocsConnector } from "../src/docs/registry.js";
import { ConfigSchema } from "../src/config.js";
import type { CairnConfig } from "../src/config.js";

const base = { tracker: { type: "github", config: { repo: "o/r" } } };

const cfg = (docs?: Record<string, unknown>): CairnConfig =>
  ConfigSchema.parse(docs ? { ...base, docs } : base);

describe("config docs block", () => {
  it("is optional", () => {
    expect(cfg().docs).toBeUndefined();
  });

  it("accepts a confluence connector block", () => {
    const c = cfg({ connector: "confluence", config: { baseUrl: "https://x.atlassian.net/wiki" } });
    expect(c.docs?.connector).toBe("confluence");
  });

  it("rejects unknown connectors", () => {
    expect(() => cfg({ connector: "geocities", config: {} })).toThrow();
  });
});

describe("makeDocsConnector", () => {
  it("throws CONFIG_MISSING without a docs block", async () => {
    await expect(makeDocsConnector(cfg())).rejects.toMatchObject({ code: "CONFIG_MISSING" });
  });
});
