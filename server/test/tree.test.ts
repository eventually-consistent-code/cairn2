import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameToTitle, scanDocs, tocMarkdown } from "../src/docs/tree.js";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-tree-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("nameToTitle", () => {
  it("strips extensions, numeric prefixes, and kebab/underscore", () => {
    expect(nameToTitle("0004-api-versioning.md")).toBe("Api Versioning");
    expect(nameToTitle("quick_start.md")).toBe("Quick Start");
    expect(nameToTitle("adr")).toBe("Adr");
  });
});

describe("scanDocs", () => {
  it("maps docs/ files and directories into a tree", () => {
    const dir = tempProject({
      "docs/ARCHITECTURE.md": "# Architecture\n\nBig picture.",
      "docs/adr/0001-first.md": "# First Decision\n\nBecause.",
      "docs/adr/0002-second.md": "no heading here",
    });
    try {
      const nodes = scanDocs(dir);
      expect(nodes.map((n) => n.title)).toEqual(["Architecture", "Adr"]);
      const adr = nodes[1];
      expect(adr.children.map((c) => c.title)).toEqual(["First Decision", "Second"]);
      expect(adr.markdown).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("prefers the first H1 as the title", () => {
    const dir = tempProject({ "docs/x.md": "intro\n\n# Real Title\n" });
    try {
      expect(scanDocs(dir)[0].title).toBe("Real Title");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("includes a root CHANGELOG.md after the docs tree", () => {
    const dir = tempProject({
      "docs/a.md": "# A",
      "CHANGELOG.md": "# Changelog\n\n- stuff",
    });
    try {
      expect(scanDocs(dir).map((n) => n.title)).toEqual(["A", "Changelog"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignores non-markdown files, hidden entries, and empty dirs", () => {
    const dir = tempProject({
      "docs/keep.md": "# Keep",
      "docs/skip.png": "binary",
      "docs/.hidden.md": "# Hidden",
      "docs/empty/placeholder.txt": "x",
    });
    try {
      expect(scanDocs(dir).map((n) => n.title)).toEqual(["Keep"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns empty for a project with no docs", () => {
    const dir = tempProject({});
    try {
      expect(scanDocs(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("tocMarkdown", () => {
  it("renders a Documentation section", () => {
    expect(tocMarkdown([{ title: "A", url: "u1" }, { title: "B", url: "u2" }]))
      .toBe("\n\n## Documentation\n\n- [A](u1)\n- [B](u2)\n");
  });

  it("is empty for no entries", () => {
    expect(tocMarkdown([])).toBe("");
  });
});
