import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexDbPath, MemoryIndex } from "../src/memory/index-store.js";

describe("indexDbPath", () => {
  it("derives a stable path under the home dir, outside the project", () => {
    const p1 = indexDbPath("/tmp/project-a");
    const p2 = indexDbPath("/tmp/project-a");
    const p3 = indexDbPath("/tmp/project-b");
    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(p1).toContain(".cairn/index/");
    expect(p1).toContain("project-a-");
    expect(p1.endsWith(".db")).toBe(true);
  });
});

describe("MemoryIndex", () => {
  const dbPaths: string[] = [];
  const freshDbPath = () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-index-"));
    const p = join(dir, "test.db");
    dbPaths.push(dir);
    return p;
  };
  afterEach(() => { for (const d of dbPaths.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("indexes and full-text-searches content", () => {
    const idx = new MemoryIndex(freshDbPath());
    idx.index({ content: "GitHub secondary rate limits return 403", source: "research", phase: 1, issueId: null, createdAt: "2026-07-14T00:00:00Z" });
    idx.index({ content: "Unrelated note about jira epics", source: "research", phase: 2, issueId: null, createdAt: "2026-07-14T00:00:01Z" });
    const results = idx.search("rate limits");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("rate limits");
    idx.close();
  });

  it("filters search by phase and issueId", () => {
    const idx = new MemoryIndex(freshDbPath());
    idx.index({ content: "shared term alpha", source: "s", phase: 1, issueId: "A-1", createdAt: "2026-07-14T00:00:00Z" });
    idx.index({ content: "shared term beta", source: "s", phase: 2, issueId: "B-2", createdAt: "2026-07-14T00:00:01Z" });
    expect(idx.search("shared term", { phase: 1 }).length).toBe(1);
    expect(idx.search("shared term", { issueId: "B-2" }).length).toBe(1);
    expect(idx.search("shared term").length).toBe(2);
    idx.close();
  });

  it("reports chunk count and approximate size via stats", () => {
    const idx = new MemoryIndex(freshDbPath());
    idx.index({ content: "twelve characters here", source: "s", phase: null, issueId: null, createdAt: "2026-07-14T00:00:00Z" });
    const stats = idx.stats();
    expect(stats.chunkCount).toBe(1);
    expect(stats.approxBytes).toBeGreaterThan(0);
    expect(stats.approxTokens).toBe(Math.ceil(stats.approxBytes / 4));
    idx.close();
  });

  it("persists across close and reopen (real file, not in-memory)", () => {
    const path = freshDbPath();
    const idx1 = new MemoryIndex(path);
    idx1.index({ content: "durable content check", source: "s", phase: null, issueId: null, createdAt: "2026-07-14T00:00:00Z" });
    idx1.close();
    const idx2 = new MemoryIndex(path);
    expect(idx2.search("durable content").length).toBe(1);
    idx2.close();
  });
});
