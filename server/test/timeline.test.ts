import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { MemoryIndex, indexDbPath } from "../src/memory/index-store.js";
import { createCard } from "../src/memory/cards.js";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";

describe("MemoryIndex.timeline", () => {
  const dbPaths: string[] = [];
  const freshDbPath = () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-timeline-"));
    const p = join(dir, "test.db");
    dbPaths.push(dir);
    return p;
  };
  afterEach(() => {
    for (const d of dbPaths.splice(0))
      rmSync(d, { recursive: true, force: true });
  });

  const seed = (idx: MemoryIndex) => {
    // Six chunks, one per day, all with the same source prefix so we can
    // assert on ordering rather than content matching.
    for (let i = 1; i <= 6; i++) {
      idx.index({
        content: `entry ${i}`,
        source: `s${i}`,
        phase: null,
        issueId: null,
        createdAt: `2026-07-1${i}T00:00:00.000Z`,
      });
    }
  };

  it("returns before/after neighbors in chronological order", () => {
    const idx = new MemoryIndex(freshDbPath());
    seed(idx);
    // anchor at day 4 (s4) -- expect s2,s3 before and s5,s6 after with before=2/after=2
    const neighbors = idx.timeline("2026-07-14T00:00:00.000Z", 2, 2);
    expect(neighbors.map((n) => n.source)).toEqual(["s2", "s3", "s5", "s6"]);
    idx.close();
  });

  it("caps before/after counts independently and excludes the exact anchor timestamp", () => {
    const idx = new MemoryIndex(freshDbPath());
    seed(idx);
    const neighbors = idx.timeline("2026-07-14T00:00:00.000Z", 1, 10);
    expect(neighbors.map((n) => n.source)).toEqual(["s3", "s5", "s6"]);
    idx.close();
  });

  it("returns an empty array when there are no chunks on one side", () => {
    const idx = new MemoryIndex(freshDbPath());
    seed(idx);
    const neighbors = idx.timeline("2026-07-11T00:00:00.000Z", 3, 0);
    expect(neighbors).toEqual([]);
    idx.close();
  });

  it("sourceCreatedAt returns the earliest createdAt for a source, or undefined", () => {
    const idx = new MemoryIndex(freshDbPath());
    seed(idx);
    expect(idx.sourceCreatedAt("s3")).toBe("2026-07-13T00:00:00.000Z");
    expect(idx.sourceCreatedAt("does-not-exist")).toBeUndefined();
    idx.close();
  });
});

describe("mem_timeline tool", () => {
  let projectDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text), isError: res.isError };
  };

  const setup = async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-timeline-mcp-"));
    const server = buildServer({ projectDir, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-timeline", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  };

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("unknown anchor returns NOT_FOUND", async () => {
    await setup();
    const res = await call("mem_timeline", { anchor: "nope" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
    expect(res.json.nextAction).toBeTruthy();
  });

  it("returns merged chronological neighbors around a chunk anchor, with card costs matching ceil(len/4)", async () => {
    await setup();
    // Seed chunks a day either side of "now" directly (bypassing mem_index's
    // wall-clock timestamp) so the ordering is deterministic regardless of
    // when this test actually runs. The card created below gets today's
    // day-precision date, landing it strictly between the two chunks.
    const dayOffset = (days: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString();
    };
    const idx = new MemoryIndex(indexDbPath(projectDir));
    idx.index({
      content: "early chunk",
      source: "early",
      phase: null,
      issueId: null,
      createdAt: dayOffset(-1),
    });
    idx.index({
      content: "late chunk",
      source: "late",
      phase: null,
      issueId: null,
      createdAt: dayOffset(1),
    });
    idx.close();

    const card = createCard(projectDir, {
      type: "decision",
      body: "Use FTS5 for the memory index.",
    });

    const result = await call("mem_timeline", {
      anchor: "early",
      before: 3,
      after: 3,
    });
    expect(result.isError).toBeFalsy();
    const ids = result.json.map(
      (e: { source?: string; id?: string }) => e.source ?? e.id,
    );
    // "early" itself is excluded; the card (today, between the two chunks)
    // and "late" chunk should both appear, in chronological order.
    expect(ids).toEqual([card.id, "late"]);

    const cardEntry = result.json.find(
      (e: { id?: string }) => e.id === card.id,
    );
    expect(cardEntry).toMatchObject({
      id: card.id,
      type: "decision",
      created: card.frontmatter.created,
    });
    expect(cardEntry.cost).toBe(Math.ceil(card.body.length / 4));
  });

  it("resolves a card anchor and tie-breaks same-day cards by id", async () => {
    await setup();
    const a = createCard(projectDir, {
      type: "decision",
      body: "AAAA decision body.",
    });
    const b = createCard(projectDir, {
      type: "decision",
      body: "BBBB decision body.",
    });
    const c = createCard(projectDir, {
      type: "decision",
      body: "CCCC decision body.",
    });
    const sortedIds = [a.id, b.id, c.id].sort();
    const [lo, mid, hi] = sortedIds;

    const result = await call("mem_timeline", {
      anchor: mid,
      before: 3,
      after: 3,
    });
    expect(result.isError).toBeFalsy();
    expect(result.json.map((e: { id: string }) => e.id)).toEqual([lo, hi]);
  });
});
