// Docusaurus connector unit tests — temp-dir site fixtures, no live backend.
// The temp dir IS the backend, so these are also the connector's live tests.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { configSchema, make, slugify } from "../src/docs/adapters/docusaurus.js";
import { docsConnectorContract } from "./docs-contract.js";

function tempSite(): string {
  const site = mkdtempSync(join(tmpdir(), "cairn-dsite-"));
  writeFileSync(join(site, "docusaurus.config.js"), "export default {};\n");
  return site;
}

function connectorAt(site: string) {
  const cfg = configSchema.parse({ sitePath: site });
  return { cfg, c: make(cfg) };
}

describe("slugify", () => {
  it("lowercases, collapses non-alphanumerics to single hyphens, trims", () => {
    expect(slugify("Quick Start!")).toBe("quick-start");
    expect(slugify("API — v2 (draft)")).toBe("api-v2-draft");
  });
});

describe("DocusaurusConnector", () => {
  it("ensureRoot creates docs/<slug>/ with _category_.json, idempotently", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const a = await c.ensureRoot("My Proj");
    const b = await c.ensureRoot("My Proj");
    expect(b.id).toBe(a.id);
    const cat = JSON.parse(readFileSync(join(site, "docs", "my-proj", "_category_.json"), "utf8"));
    expect(cat.label).toBe("My Proj");
  });

  it("rejects a sitePath without a docusaurus config", async () => {
    const bare = mkdtempSync(join(tmpdir(), "cairn-bare-"));
    const { c } = connectorAt(bare);
    await expect(c.ensureRoot("x")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("createPage writes front matter + verbatim body; position from sibling order", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "First", markdown: "# First\n\nbody", parentId: root.id });
    const page = await c.createPage({ title: 'He said "hi"', markdown: "x", parentId: root.id });
    const raw = readFileSync(join(site, "docs", page.id), "utf8");
    expect(raw).toContain('title: "He said \\"hi\\""');
    expect(raw).toContain("sidebar_position: 2");
    expect(raw.endsWith("x\n")).toBe(true);
  });

  it("container spec creates a folder; empty markdown gets a generated-index category", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    const dir = await c.createPage({ title: "Guide", markdown: "", parentId: root.id, container: true });
    const catPath = join(site, "docs", dir.id, "_category_.json");
    expect(JSON.parse(readFileSync(catPath, "utf8")).link).toEqual({ type: "generated-index" });
    expect(existsSync(join(site, "docs", dir.id, "index.md"))).toBe(false);
    const child = await c.createPage({ title: "Setup", markdown: "s", parentId: dir.id });
    expect(child.parentId).toBe(dir.id);
  });

  it("updatePage bumps version, keeps the file path on rename, preserves position", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    const page = await c.createPage({ title: "Old Name", markdown: "v1", parentId: root.id });
    const updated = await c.updatePage(page.id, { title: "New Name", markdown: "v2", parentId: root.id });
    expect(updated.id).toBe(page.id); // old-name.md — path stable
    expect(updated.version ?? 0).toBeGreaterThan(page.version ?? 0);
    const raw = readFileSync(join(site, "docs", page.id), "utf8");
    expect(raw).toContain('title: "New Name"');
    expect(raw).toContain("sidebar_position: 1");
  });

  it("findPage locates by slug, falls back to front matter title after rename, null on miss", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    const page = await c.createPage({ title: "Original", markdown: "m", parentId: root.id });
    await c.updatePage(page.id, { title: "Renamed", markdown: "m", parentId: root.id });
    expect((await c.findPage("Renamed", root.id))?.id).toBe(page.id);
    expect(await c.findPage("Nope", root.id)).toBeNull();
  });

  it("listChildren returns md files and folders, never index.md or _category_.json", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "Leaf", markdown: "x", parentId: root.id });
    await c.createPage({ title: "Sub", markdown: "landing", parentId: root.id, container: true });
    const kids = await c.listChildren(root.id);
    expect(kids.map((k) => k.title).sort()).toEqual(["Leaf", "Sub"]);
  });

  it("never touches files outside the project folder", async () => {
    const site = tempSite();
    writeFileSync(join(site, "docs.keep"), "untouched");
    mkdirSync(join(site, "docs"), { recursive: true });
    writeFileSync(join(site, "docs", "handwritten.md"), "mine");
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "P", markdown: "x", parentId: root.id });
    expect(readFileSync(join(site, "docs", "handwritten.md"), "utf8")).toBe("mine");
    expect(readdirSync(join(site, "docs")).sort()).toEqual(["handwritten.md", "proj"]);
  });
});

docsConnectorContract("docusaurus (temp dir)", () => {
  const { c } = connectorAt(tempSite());
  return c;
});
