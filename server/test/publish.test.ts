import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mkdirSync } from "node:fs";
import { publishReadme, publishTree } from "../src/docs/publish.js";
import { FakeDocsConnector } from "../src/docs/fake.js";

function tempProject(readme?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-pub-"));
  if (readme !== undefined) writeFileSync(join(dir, "README.md"), readme);
  return dir;
}

describe("publishReadme", () => {
  it("creates the landing page from README.md, titled after the project dir", async () => {
    const dir = tempProject("# Hello\n\nWorld.");
    const conn = new FakeDocsConnector();
    const pages = conn.pages;
    try {
      const result = await publishReadme(conn, dir);
      expect(result.published).toBe(1);
      expect(result.root.title).toBe(basename(dir));
      expect([...pages.values()][0].markdown).toBe("# Hello\n\nWorld.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("re-publish updates the same page in place (idempotent)", async () => {
    const dir = tempProject("v1");
    const conn = new FakeDocsConnector();
    const pages = conn.pages;
    try {
      const first = await publishReadme(conn, dir, "proj");
      writeFileSync(join(dir, "README.md"), "v2");
      const second = await publishReadme(conn, dir, "proj");
      expect(second.root.id).toBe(first.root.id);
      expect(pages.size).toBe(1);
      expect(pages.get(first.root.id)!.markdown).toBe("v2");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("honors an explicit project name", async () => {
    const dir = tempProject("x");
    const conn = new FakeDocsConnector();
    try {
      const result = await publishReadme(conn, dir, "My Project");
      expect(result.root.title).toBe("My Project");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws NOT_FOUND without a README", async () => {
    const dir = tempProject();
    const conn = new FakeDocsConnector();
    try {
      await expect(publishReadme(conn, dir)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("publishTree", () => {
  function docsProject(): string {
    const dir = tempProject("# Readme body");
    mkdirSync(join(dir, "docs", "adr"), { recursive: true });
    writeFileSync(join(dir, "docs", "ARCHITECTURE.md"), "# Architecture\n\nShape.");
    writeFileSync(join(dir, "docs", "adr", "0001-x.md"), "# First\n\nWhy.");
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n- v1");
    return dir;
  }

  it("publishes the full tree with correct ancestry", async () => {
    const dir = docsProject();
    const conn = new FakeDocsConnector();
    const pages = conn.pages;
    try {
      const result = await publishTree(conn, dir, "proj");
      // root + Architecture + Adr + First + Changelog
      expect(result.published).toBe(5);
      const byTitle = (t: string) => [...pages.values()].find((p) => p.title === t)!;
      expect(byTitle("Architecture").parentId).toBe(byTitle("proj").id);
      expect(byTitle("Adr").parentId).toBe(byTitle("proj").id);
      expect(byTitle("First").parentId).toBe(byTitle("Adr").id);
      expect(byTitle("Changelog").parentId).toBe(byTitle("proj").id);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("writes a Documentation TOC on the landing page and a child list on dir pages", async () => {
    const dir = docsProject();
    const conn = new FakeDocsConnector();
    const pages = conn.pages;
    try {
      await publishTree(conn, dir, "proj");
      const root = [...pages.values()].find((p) => p.title === "proj")!;
      expect(root.markdown).toContain("# Readme body");
      expect(root.markdown).toContain("## Documentation");
      expect(root.markdown).toContain("[Architecture](");
      const adr = [...pages.values()].find((p) => p.title === "Adr")!;
      expect(adr.markdown).toContain("[First](");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("re-publish updates in place — page count stays constant", async () => {
    const dir = docsProject();
    const conn = new FakeDocsConnector();
    const pages = conn.pages;
    try {
      await publishTree(conn, dir, "proj");
      const count = pages.size;
      const again = await publishTree(conn, dir, "proj");
      expect(pages.size).toBe(count);
      expect(again.published).toBe(5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("disambiguates space-wide title conflicts with a (Context) suffix", async () => {
    const dir = docsProject();
    const conn = new FakeDocsConnector();
    const pages = conn.pages;
    // Simulate an unrelated page elsewhere in the space already owning the title.
    await conn.createPage({ title: "Architecture", markdown: "other", parentId: "elsewhere" });
    try {
      await publishTree(conn, dir, "proj");
      const ours = [...pages.values()].find((p) => p.title === "Architecture (proj)");
      expect(ours).toBeDefined();
      // Re-publish stays idempotent on the disambiguated title.
      const count = pages.size;
      await publishTree(conn, dir, "proj");
      expect(pages.size).toBe(count);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("degenerates to README-only when there is no docs tree", async () => {
    const dir = tempProject("# Solo");
    const conn = new FakeDocsConnector();
    const pages = conn.pages;
    try {
      const result = await publishTree(conn, dir, "proj");
      expect(result.published).toBe(1);
      expect([...pages.values()][0].markdown).toBe("# Solo");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
