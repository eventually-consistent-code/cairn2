import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CairnError } from "../src/errors.js";
import { mapGet, mapQuery, mapSet } from "../src/map/store.js";

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
    // validate-before-write atomicity: the rejected patch must leave the store untouched.
    const map = mapGet(dir);
    expect(map.nodes).toEqual({ "mod-a": { type: "module", label: "A" } });
    expect(map.edges).toEqual([]);
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

describe("edge-safe patch ops (#63)", () => {
  // shared fixture: three modules with one existing edge, enough to exercise
  // add/remove/dedupe without the wholesale-replace foot-gun
  const seeded = () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "mod-a": { type: "module", label: "A" },
        "mod-b": { type: "module", label: "B" },
        "mod-c": { type: "module", label: "C" },
      },
      edges: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
    });
    return dir;
  };

  it("edgesAdd appends new edges without touching existing ones", () => {
    const dir = seeded();
    const out = mapSet(dir, {
      edgesAdd: [{ from: "mod-b", to: "mod-c", type: "depends-on" }],
    });
    expect(out.edges).toBe(2);
    expect(mapGet(dir).edges).toEqual([
      { from: "mod-a", to: "mod-b", type: "depends-on" },
      { from: "mod-b", to: "mod-c", type: "depends-on" },
    ]);
  });

  it("edgesAdd silently dedupes against an existing identical triple", () => {
    const dir = seeded();
    const out = mapSet(dir, {
      edgesAdd: [
        { from: "mod-a", to: "mod-b", type: "depends-on" }, // already there
        { from: "mod-a", to: "mod-c", type: "depends-on" },
        { from: "mod-a", to: "mod-c", type: "depends-on" }, // dupe within the add list too
      ],
    });
    expect(out.edges).toBe(2);
  });

  it("edgesAdd rejects a dangling endpoint, naming the id, and leaves the store untouched", () => {
    const dir = seeded();
    expect(() => mapSet(dir, {
      edgesAdd: [{ from: "mod-a", to: "mod-ghost", type: "depends-on" }],
    })).toThrow(/mod-ghost/);
    expect(mapGet(dir).edges).toEqual([{ from: "mod-a", to: "mod-b", type: "depends-on" }]);
  });

  it("edgesRemove drops only the exact from+to+type triple", () => {
    const dir = seeded();
    // same endpoints, different type -- must survive a remove of the depends-on triple
    mapSet(dir, { edgesAdd: [{ from: "mod-a", to: "mod-b", type: "implements" }] });
    const out = mapSet(dir, {
      edgesRemove: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
    });
    expect(out.edges).toBe(1);
    expect(mapGet(dir).edges).toEqual([{ from: "mod-a", to: "mod-b", type: "implements" }]);
  });

  it("edgesRemove of a non-existent edge is a no-op (idempotent, retry-safe)", () => {
    const dir = seeded();
    const out = mapSet(dir, {
      edgesRemove: [{ from: "mod-b", to: "mod-c", type: "owns" }],
    });
    expect(out.edges).toBe(1);
    expect(mapGet(dir).edges).toEqual([{ from: "mod-a", to: "mod-b", type: "depends-on" }]);
  });

  it("removes apply before adds: remove + re-add the same triple in one call leaves it present", () => {
    const dir = seeded();
    const out = mapSet(dir, {
      edgesRemove: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
      edgesAdd: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
    });
    expect(out.edges).toBe(1);
    expect(mapGet(dir).edges).toEqual([{ from: "mod-a", to: "mod-b", type: "depends-on" }]);
  });

  it("composes in one call: remove one edge, add another", () => {
    const dir = seeded();
    const out = mapSet(dir, {
      edgesRemove: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
      edgesAdd: [{ from: "mod-b", to: "mod-c", type: "depends-on" }],
    });
    expect(out.edges).toBe(1);
    expect(mapGet(dir).edges).toEqual([{ from: "mod-b", to: "mod-c", type: "depends-on" }]);
  });

  it("wholesale edges together with edgesAdd is CONFIG_INVALID (ambiguous intent)", () => {
    const dir = seeded();
    try {
      mapSet(dir, {
        edges: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
        edgesAdd: [{ from: "mod-b", to: "mod-c", type: "depends-on" }],
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });

  it("wholesale edges together with edgesRemove is CONFIG_INVALID too", () => {
    const dir = seeded();
    try {
      mapSet(dir, {
        edges: [],
        edgesRemove: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });

  it("node-delete-while-edged still rejects, but composes with edgesRemove in one call", () => {
    const dir = seeded();
    // still attached -> still rejected, same rule as wholesale
    expect(() => mapSet(dir, { nodes: { "mod-b": null } })).toThrow(/mod-a->mod-b/);
    // remove the edge and delete the node in ONE call: checked against the final edge list
    const out = mapSet(dir, {
      nodes: { "mod-b": null },
      edgesRemove: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
    });
    expect(out).toEqual({ nodes: 2, edges: 0 });
  });

  it("edge-op writes still stamp meta: updatedAt moves, generation bumps", () => {
    const dir = seeded();
    const before = mapGet(dir).meta;
    const out = mapSet(dir, {
      edgesAdd: [{ from: "mod-b", to: "mod-c", type: "depends-on" }],
    });
    expect(out.edges).toBe(2);
    const after = mapGet(dir).meta;
    expect(after?.generation).toBe((before?.generation ?? 0) + 1);
    expect(after?.builtAt).toBe(before?.builtAt);
    expect(Number.isNaN(Date.parse(after?.updatedAt ?? ""))).toBe(false);
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

describe("meta envelope", () => {
  it("stamps meta on first write: ISO timestamps and generation 1", () => {
    const dir = fresh();
    mapSet(dir, { nodes: { "mod-a": { type: "module", label: "A" } } });
    const map = mapGet(dir);
    expect(map.meta).toBeDefined();
    expect(map.meta?.generation).toBe(1);
    // both stamps must be valid ISO datetimes, and a first write IS the build
    expect(Number.isNaN(Date.parse(map.meta?.builtAt ?? ""))).toBe(false);
    expect(Number.isNaN(Date.parse(map.meta?.updatedAt ?? ""))).toBe(false);
    expect(map.meta?.builtAt).toBe(map.meta?.updatedAt);
  });

  it("increments generation on every write and preserves builtAt", () => {
    const dir = fresh();
    mapSet(dir, { nodes: { "mod-a": { type: "module", label: "A" } } });
    const first = mapGet(dir).meta;
    mapSet(dir, { nodes: { "mod-b": { type: "module", label: "B" } } });
    const second = mapGet(dir).meta;
    expect(second?.generation).toBe(2);
    expect(second?.builtAt).toBe(first?.builtAt);
  });

  it("rebuild: true resets builtAt to now and generation to 1", () => {
    const dir = fresh();
    mapSet(dir, { nodes: { "mod-a": { type: "module", label: "A" } } });
    mapSet(dir, { nodes: { "mod-b": { type: "module", label: "B" } } });
    mapSet(dir, { nodes: { "mod-c": { type: "module", label: "C" } } }, { rebuild: true });
    const meta = mapGet(dir).meta;
    expect(meta?.generation).toBe(1);
    expect(meta?.builtAt).toBe(meta?.updatedAt);
  });

  it("legacy map.json without meta still loads, and the next write stamps it", () => {
    const dir = fresh();
    // hand-roll a pre-envelope store on disk, exactly as old versions wrote it
    mkdirSync(join(dir, ".cairn", "map"), { recursive: true });
    writeFileSync(join(dir, ".cairn", "map", "map.json"), JSON.stringify({
      nodes: { "mod-old": { type: "module", label: "legacy" } }, edges: [],
    }, null, 2));
    const map = mapGet(dir);
    expect(map.nodes["mod-old"]).toEqual({ type: "module", label: "legacy" });
    expect(map.meta).toBeUndefined();
    mapSet(dir, { nodes: { "mod-new": { type: "module", label: "fresh" } } });
    expect(mapGet(dir).meta?.generation).toBe(1);
  });

  it("missing file still reads as an empty map with no meta", () => {
    const dir = fresh();
    const map = mapGet(dir);
    expect(map.nodes).toEqual({});
    expect(map.meta).toBeUndefined();
  });
});

describe("mapQuery", () => {
  // shared fixture: a 4-node chain a->b->c->d plus a person owning b,
  // enough shape to exercise depth, type, and label filters together
  const seeded = () => {
    const dir = fresh();
    mapSet(dir, {
      nodes: {
        "mod-a": { type: "module", label: "Alpha store" },
        "mod-b": { type: "module", label: "Beta store" },
        "mod-c": { type: "module", label: "Gamma API" },
        "issue-d": { type: "issue", label: "store leak" },
        "person-jr": { type: "person", label: "John Reed" },
      },
      edges: [
        { from: "mod-a", to: "mod-b", type: "depends-on" },
        { from: "mod-b", to: "mod-c", type: "depends-on" },
        { from: "mod-c", to: "issue-d", type: "implements" },
        { from: "person-jr", to: "mod-b", type: "owns" },
      ],
    });
    return dir;
  };

  it("depth 0 returns only the anchor node and no edges", () => {
    const out = mapQuery(seeded(), { node: "mod-b", depth: 0 });
    expect(Object.keys(out.nodes)).toEqual(["mod-b"]);
    expect(out.edges).toEqual([]);
  });

  it("depth 1 (the default) returns the anchor plus direct neighbors both directions", () => {
    const out = mapQuery(seeded(), { node: "mod-b" });
    expect(Object.keys(out.nodes).sort()).toEqual(["mod-a", "mod-b", "mod-c", "person-jr"]);
    // only edges with BOTH endpoints in the result set come back
    expect(out.edges).toEqual([
      { from: "mod-a", to: "mod-b", type: "depends-on" },
      { from: "mod-b", to: "mod-c", type: "depends-on" },
      { from: "person-jr", to: "mod-b", type: "owns" },
    ]);
  });

  it("depth 2 reaches two hops out via BFS", () => {
    const out = mapQuery(seeded(), { node: "mod-a", depth: 2 });
    expect(Object.keys(out.nodes).sort())
      .toEqual(["mod-a", "mod-b", "mod-c", "person-jr"]);
  });

  it("depth 3 covers the whole chain from one end", () => {
    const out = mapQuery(seeded(), { node: "mod-a", depth: 3 });
    expect(Object.keys(out.nodes).sort())
      .toEqual(["issue-d", "mod-a", "mod-b", "mod-c", "person-jr"]);
  });

  it("unknown anchor node returns an empty result, not an error", () => {
    const out = mapQuery(seeded(), { node: "mod-ghost" });
    expect(out.nodes).toEqual({});
    expect(out.edges).toEqual([]);
  });

  it("label filter is a case-insensitive substring match", () => {
    const out = mapQuery(seeded(), { label: "STORE" });
    expect(Object.keys(out.nodes).sort()).toEqual(["issue-d", "mod-a", "mod-b"]);
  });

  it("filters combine as AND: nodeType + edgeType + label together", () => {
    const out = mapQuery(seeded(), {
      nodeType: "module", edgeType: "depends-on", label: "store",
    });
    // modules whose label contains "store": mod-a, mod-b; only the
    // depends-on edge between them survives the edge filter
    expect(Object.keys(out.nodes).sort()).toEqual(["mod-a", "mod-b"]);
    expect(out.edges).toEqual([{ from: "mod-a", to: "mod-b", type: "depends-on" }]);
  });

  it("neighborhood combines with nodeType: depth 1 around mod-b, modules only", () => {
    const out = mapQuery(seeded(), { node: "mod-b", depth: 1, nodeType: "module" });
    expect(Object.keys(out.nodes).sort()).toEqual(["mod-a", "mod-b", "mod-c"]);
    expect(out.edges).toEqual([
      { from: "mod-a", to: "mod-b", type: "depends-on" },
      { from: "mod-b", to: "mod-c", type: "depends-on" },
    ]);
  });

  it("edges drop out when only one endpoint survives the filters", () => {
    const out = mapQuery(seeded(), { nodeType: "person" });
    expect(Object.keys(out.nodes)).toEqual(["person-jr"]);
    expect(out.edges).toEqual([]);
  });

  it("querying an empty (missing) map returns an empty result with no meta", () => {
    const dir = fresh();
    const out = mapQuery(dir, {});
    expect(out.nodes).toEqual({});
    expect(out.edges).toEqual([]);
    expect(out.meta).toBeUndefined();
  });

  it("query results carry the meta envelope through", () => {
    const out = mapQuery(seeded(), { node: "mod-b" });
    expect(out.meta?.generation).toBe(1);
  });
});
