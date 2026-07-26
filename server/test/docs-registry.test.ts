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

  it("builds a ConfluenceConnector for connector=confluence", async () => {
    const { ConfluenceConnector } = await import("../src/docs/adapters/confluence.js");
    const conn = await makeDocsConnector(cfg({
      connector: "confluence",
      config: { baseUrl: "https://x.atlassian.net/wiki", spaceKey: "DOCS" },
    }));
    expect(conn).toBeInstanceOf(ConfluenceConnector);
  });

  it("rejects invalid confluence config", async () => {
    await expect(makeDocsConnector(cfg({ connector: "confluence", config: {} })))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("builds a DocusaurusConnector for connector=docusaurus", async () => {
    const { DocusaurusConnector } = await import("../src/docs/adapters/docusaurus.js");
    const conn = await makeDocsConnector(cfg({
      connector: "docusaurus", config: { sitePath: "../my-docs-site" },
    }));
    expect(conn).toBeInstanceOf(DocusaurusConnector);
    expect(conn.capabilities.hasNativeToc).toBe(true);
  });

  it("rejects invalid docusaurus config", async () => {
    await expect(makeDocsConnector(cfg({ connector: "docusaurus", config: {} })))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
