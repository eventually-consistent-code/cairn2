import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { publishReadme } from "../src/docs/publish.js";
import type { DocsConnector, Page, PageSpec } from "../src/docs/types.js";

/** Minimal in-memory DocsConnector — records what publish asked for. */
function memoryConnector() {
  const pages = new Map<string, Page & { markdown: string }>();
  let seq = 0;
  const conn: DocsConnector = {
    capabilities: { hasPageTree: true, hasAttachments: false, hasLabels: false },
    async ensureRoot(projectName: string) {
      for (const p of pages.values()) if (p.title === projectName) return p;
      return conn.createPage({ title: projectName, markdown: "" });
    },
    async getPage(id: string) {
      const p = pages.get(id);
      if (!p) throw new Error(`no page ${id}`);
      return p;
    },
    async findPage(title: string, parentId?: string) {
      for (const p of pages.values()) {
        if (p.title === title && (parentId === undefined || p.parentId === parentId)) return p;
      }
      return null;
    },
    async listChildren(parentId: string) {
      return [...pages.values()].filter((p) => p.parentId === parentId);
    },
    async createPage(spec: PageSpec) {
      const page = { id: String(++seq), title: spec.title, parentId: spec.parentId,
        version: 1, url: `mem://${seq}`, markdown: spec.markdown };
      pages.set(page.id, page);
      return page;
    },
    async updatePage(id: string, spec: PageSpec) {
      const prev = pages.get(id)!;
      const page = { ...prev, title: spec.title, markdown: spec.markdown,
        version: (prev.version ?? 0) + 1 };
      pages.set(id, page);
      return page;
    },
  };
  return { conn, pages };
}

function tempProject(readme?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-pub-"));
  if (readme !== undefined) writeFileSync(join(dir, "README.md"), readme);
  return dir;
}

describe("publishReadme", () => {
  it("creates the landing page from README.md, titled after the project dir", async () => {
    const dir = tempProject("# Hello\n\nWorld.");
    const { conn, pages } = memoryConnector();
    try {
      const result = await publishReadme(conn, dir);
      expect(result.published).toBe(1);
      expect(result.root.title).toBe(basename(dir));
      expect([...pages.values()][0].markdown).toBe("# Hello\n\nWorld.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("re-publish updates the same page in place (idempotent)", async () => {
    const dir = tempProject("v1");
    const { conn, pages } = memoryConnector();
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
    const { conn } = memoryConnector();
    try {
      const result = await publishReadme(conn, dir, "My Project");
      expect(result.root.title).toBe("My Project");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws NOT_FOUND without a README", async () => {
    const dir = tempProject();
    const { conn } = memoryConnector();
    try {
      await expect(publishReadme(conn, dir)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
