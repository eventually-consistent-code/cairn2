import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapGet, mapSet } from "../src/map/store.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-map-"));

describe("mapSet", () => {
  it("merges new nodes and edges into an empty store", () => {
    const dir = fresh();
    const out = mapSet(dir, {
      nodes: {
        "phase-1": { type: "phase", label: "Tier E" },
        "mod-store": { type: "module", label: "map store" },
      },
      edges: [{ from: "mod-store", to: "phase-1", type: "implements" }],
    });
    expect(out).toEqual({ nodes: 2, edges: 1 });
    const map = mapGet(dir);
    expect(map.nodes["phase-1"]).toEqual({ type: "phase", label: "Tier E" });
    expect(map.edges).toEqual([{ from: "mod-store", to: "phase-1", type: "implements" }]);
  });

  it("merges an existing node's fields and null deletes an unattached node", () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "issue-9": { type: "issue", label: "leak guard gap", detail: "old detail" },
        "person-jr": { type: "person", label: "John Reed" },
      },
    });
    const out = mapSet(dir, {
      nodes: {
        "issue-9": { type: "issue", label: "leak guard gap", detail: "fixed in #12" },
        "person-jr": null,
      },
    });
    expect(out).toEqual({ nodes: 1, edges: 0 });
    const map = mapGet(dir);
    expect(map.nodes).toEqual({
      "issue-9": { type: "issue", label: "leak guard gap", detail: "fixed in #12" },
    });
  });

  it("rejects deleting a node that still has an edge attached, naming the edge", () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "mod-a": { type: "module", label: "A" },
        "mod-b": { type: "module", label: "B" },
      },
      edges: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
    });
    expect(() => mapSet(dir, { nodes: { "mod-b": null } }))
      .toThrow(/mod-a->mod-b/);
  });

  it("replaces the edges list wholesale rather than merging it", () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "mod-a": { type: "module", label: "A" },
        "mod-b": { type: "module", label: "B" },
        "mod-c": { type: "module", label: "C" },
      },
      edges: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
    });
    const out = mapSet(dir, {
      edges: [{ from: "mod-a", to: "mod-c", type: "depends-on" }],
    });
    expect(out.edges).toBe(1);
    const map = mapGet(dir);
    expect(map.edges).toEqual([{ from: "mod-a", to: "mod-c", type: "depends-on" }]);
  });

  it("rejects an edge whose endpoint is missing from the post-merge node set, naming the id", () => {
    const dir = fresh();
    mapSet(dir, { nodes: { "mod-a": { type: "module", label: "A" } } });
    expect(() => mapSet(dir, {
      edges: [{ from: "mod-a", to: "mod-ghost", type: "depends-on" }],
    })).toThrow(/mod-ghost/);
  });

  it("rejects an invalid node type", () => {
    const dir = fresh();
    expect(() => mapSet(dir, {
      nodes: { "bad-node": { type: "widget" as never, label: "nope" } },
    })).toThrow(/bad-node/);
  });

  it("rejects an invalid edge type", () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "mod-a": { type: "module", label: "A" },
        "mod-b": { type: "module", label: "B" },
      },
    });
    expect(() => mapSet(dir, {
      edges: [{ from: "mod-a", to: "mod-b", type: "blocks" as never }],
    })).toThrow(/mod-a|mod-b/);
  });

  it("writes atomically -- no leftover .tmp file after a successful write", () => {
    const dir = fresh();
    mapSet(dir, { nodes: { "mod-a": { type: "module", label: "A" } } });
    expect(existsSync(join(dir, ".cairn", "map", "map.json"))).toBe(true);
    expect(existsSync(join(dir, ".cairn", "map", "map.json.tmp"))).toBe(false);
  });
});

describe("mapGet", () => {
  it("returns an empty store when no map file exists yet", () => {
    const dir = fresh();
    expect(mapGet(dir)).toEqual({ nodes: {}, edges: [] });
  });

  it("sorts nodes by id and edges by (from, to, type) deterministically", () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "mod-z": { type: "module", label: "Z" },
        "mod-a": { type: "module", label: "A" },
        "mod-m": { type: "module", label: "M" },
      },
      edges: [
        { from: "mod-z", to: "mod-a", type: "depends-on" },
        { from: "mod-a", to: "mod-m", type: "implements" },
        { from: "mod-a", to: "mod-m", type: "depends-on" },
      ],
    });
    const first = mapGet(dir);
    expect(Object.keys(first.nodes)).toEqual(["mod-a", "mod-m", "mod-z"]);
    expect(first.edges).toEqual([
      { from: "mod-a", to: "mod-m", type: "depends-on" },
      { from: "mod-a", to: "mod-m", type: "implements" },
      { from: "mod-z", to: "mod-a", type: "depends-on" },
    ]);
    const second = mapGet(dir);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("filters by nodeType", () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "phase-1": { type: "phase", label: "Tier E" },
        "mod-store": { type: "module", label: "map store" },
      },
    });
    const filtered = mapGet(dir, { nodeType: "phase" });
    expect(Object.keys(filtered.nodes)).toEqual(["phase-1"]);
  });

  it("filters by edgeType", () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "mod-a": { type: "module", label: "A" },
        "mod-b": { type: "module", label: "B" },
      },
      edges: [
        { from: "mod-a", to: "mod-b", type: "depends-on" },
        { from: "mod-a", to: "mod-b", type: "implements" },
      ],
    });
    const filtered = mapGet(dir, { edgeType: "implements" });
    expect(filtered.edges).toEqual([{ from: "mod-a", to: "mod-b", type: "implements" }]);
  });

  it("filters by node, returning self, touching edges, and neighbor nodes", () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "mod-a": { type: "module", label: "A" },
        "mod-b": { type: "module", label: "B" },
        "mod-c": { type: "module", label: "C" },
        "mod-lonely": { type: "module", label: "unrelated" },
      },
      edges: [
        { from: "mod-a", to: "mod-b", type: "depends-on" },
        { from: "mod-c", to: "mod-a", type: "implements" },
      ],
    });
    const view = mapGet(dir, { node: "mod-a" });
    expect(Object.keys(view.nodes).sort()).toEqual(["mod-a", "mod-b", "mod-c"]);
    expect(view.edges).toEqual([
      { from: "mod-a", to: "mod-b", type: "depends-on" },
      { from: "mod-c", to: "mod-a", type: "implements" },
    ]);
  });
});
