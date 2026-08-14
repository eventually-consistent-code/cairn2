import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CairnError } from "../errors.js";

export type NodeType = "module" | "phase" | "issue" | "decision" | "person";
export type EdgeType = "depends-on" | "implements" | "decided-in" | "owns";

export interface MapNode {
  type: NodeType;
  label: string;
  detail?: string;
}
export interface MapEdge {
  from: string;
  to: string;
  type: EdgeType;
}

/**
 * Freshness envelope stamped by mapSet on every write. builtAt marks when the
 * graph was (re)built from scratch; updatedAt moves on every write; generation
 * counts writes since the last rebuild. A legacy map.json without meta loads
 * fine -- meta stays absent until the next write stamps it.
 */
export interface MapMeta {
  builtAt: string;
  updatedAt: string;
  generation: number;
}

export interface ProjectMap {
  nodes: Record<string, MapNode>;
  edges: MapEdge[];
  meta?: MapMeta;
}

const NodeTypeSchema = z.enum([
  "module",
  "phase",
  "issue",
  "decision",
  "person",
]);
const EdgeTypeSchema = z.enum([
  "depends-on",
  "implements",
  "decided-in",
  "owns",
]);
const MapNodeSchema = z.object({
  type: NodeTypeSchema,
  label: z.string(),
  detail: z.string().optional(),
});
const MapEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: EdgeTypeSchema,
});
const MapMetaSchema = z.object({
  builtAt: z.string(),
  updatedAt: z.string(),
  generation: z.number(),
});
// The whole on-disk store -- readMap validates against this so a hand-edited
// map.json (say, a node missing its label) fails loudly at read time with the
// defect named, instead of TypeError-ing later inside a query.
const ProjectMapSchema = z.object({
  nodes: z.record(z.string(), MapNodeSchema),
  edges: z.array(MapEdgeSchema),
  meta: MapMetaSchema.optional(),
});

const mapPath = (projectDir: string) =>
  join(projectDir, ".cairn", "map", "map.json");

function readMap(projectDir: string): ProjectMap {
  const path = mapPath(projectDir);
  if (!existsSync(path)) return { nodes: {}, edges: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CairnError(
      "CONFIG_INVALID",
      `${path} is not valid JSON`,
      "fix or delete the map file -- a missing file reads as an empty store",
    );
  }
  const parsed = ProjectMapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CairnError(
      "CONFIG_INVALID",
      `${path} does not match the map schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      "fix the named field(s) by hand, or delete the map file and rebuild",
    );
  }
  return parsed.data;
}

function writeMap(projectDir: string, map: ProjectMap): void {
  const path = mapPath(projectDir);
  mkdirSync(join(projectDir, ".cairn", "map"), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
  renameSync(tmp, path);
}

// Identity of an edge is its exact from+to+type triple -- add/remove/dedupe
// all match on this key, nothing fuzzier.
const edgeKey = (e: MapEdge) => JSON.stringify([e.from, e.to, e.type]);

/** Shape-check a list of edges, naming the offender on failure. */
function validateEdges(edges: MapEdge[]): void {
  for (const e of edges) {
    const parsed = MapEdgeSchema.safeParse(e);
    if (!parsed.success) {
      throw new CairnError(
        "UNSUPPORTED",
        `edge '${e?.from}->${e?.to}' has an invalid type: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        `use one of: ${EdgeTypeSchema.options.join(", ")}`,
      );
    }
  }
}

/**
 * Single-writer merge-patch, config_set-style: nodes merge by id (null
 * deletes). Edges patch two ways:
 *
 * - `edges` replaces the list wholesale -- full rebuilds only, and it
 *   REFUSES (CONFIG_INVALID) unless `rebuild: true` accompanies it.
 * - `edgesAdd` / `edgesRemove` patch by exact from+to+type triple, and
 *   compose in one call: removes apply BEFORE adds, so remove+re-add of the
 *   same triple lands present. Adds dedupe silently against identical
 *   existing triples; removing a triple that isn't there is a no-op --
 *   idempotent on purpose, so a retried patch can't fail on its own success.
 *
 * Passing `edges` together with either edge op is CONFIG_INVALID -- replace
 * and patch in one call is ambiguous intent. Every edge endpoint must exist
 * in the post-merge node set, and a node with an edge still attached (in the
 * FINAL edge list, so a same-call edgesRemove counts) can't be deleted --
 * both rejections name the offending id(s).
 *
 * Every write stamps the meta envelope: updatedAt moves, generation bumps.
 * Design choice: `rebuild: true` signals a from-scratch rebuild -- builtAt
 * resets to now and generation restarts at 1. A first-ever write (or a write
 * over a legacy pre-envelope file) counts as a build too.
 */
export function mapSet(
  projectDir: string,
  patch: {
    nodes?: Record<string, MapNode | null>;
    edges?: MapEdge[];
    edgesAdd?: MapEdge[];
    edgesRemove?: MapEdge[];
  },
  opts?: { rebuild?: boolean },
): { nodes: number; edges: number } {
  if (
    patch.edges !== undefined &&
    (patch.edgesAdd !== undefined || patch.edgesRemove !== undefined)
  ) {
    throw new CairnError(
      "CONFIG_INVALID",
      "patch mixes wholesale 'edges' with edgesAdd/edgesRemove -- ambiguous intent",
      "use edges alone for a full rebuild, or edgesAdd/edgesRemove alone for a surgical patch",
    );
  }

  // Wholesale replacement silently drops every edge not restated -- that is
  // only ever right in a from-scratch rebuild, so it demands the explicit flag.
  if (patch.edges !== undefined && opts?.rebuild !== true) {
    throw new CairnError(
      "CONFIG_INVALID",
      "wholesale edges replacement is rebuild-only — pass rebuild: true, or use edgesAdd/edgesRemove",
      "surgical changes belong to edgesAdd/edgesRemove; a full rebuild passes rebuild: true",
    );
  }

  const current = readMap(projectDir);
  const nodes = { ...current.nodes };

  // Merge upserts first (validated); deletes are applied after edges are
  // known, so a delete can be checked against the final edge list.
  for (const [id, value] of Object.entries(patch.nodes ?? {})) {
    if (value === null) continue;
    const parsed = MapNodeSchema.safeParse(value);
    if (!parsed.success) {
      throw new CairnError(
        "UNSUPPORTED",
        `node '${id}' has an invalid type: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        `use one of: ${NodeTypeSchema.options.join(", ")}`,
      );
    }
    nodes[id] = parsed.data;
  }

  let edges = current.edges;
  if (patch.edges !== undefined) {
    validateEdges(patch.edges);
    edges = patch.edges;
  }

  // Removes apply BEFORE adds -- documented order, so a remove+re-add of the
  // same triple in one call lands present, never mysteriously absent.
  if (patch.edgesRemove !== undefined) {
    validateEdges(patch.edgesRemove);
    const drop = new Set(patch.edgesRemove.map(edgeKey));
    edges = edges.filter((e) => !drop.has(edgeKey(e)));
  }

  if (patch.edgesAdd !== undefined) {
    validateEdges(patch.edgesAdd);
    const seen = new Set(edges.map(edgeKey));
    edges = [...edges];
    for (const e of patch.edgesAdd) {
      if (seen.has(edgeKey(e))) continue; // silent dedupe, existing + within the add list
      seen.add(edgeKey(e));
      edges.push(e);
    }
  }

  for (const [id, value] of Object.entries(patch.nodes ?? {})) {
    if (value !== null) continue;
    const attached = edges.filter((e) => e.from === id || e.to === id);
    if (attached.length > 0) {
      throw new CairnError(
        "PRECONDITION_FAILED",
        `cannot delete node '${id}' -- still attached to edge(s): ${attached
          .map((e) => `${e.from}->${e.to}`)
          .join(", ")}`,
        "drop those edges (patch edges to exclude them) before deleting the node",
      );
    }
    delete nodes[id];
  }

  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!(id in nodes)) {
        throw new CairnError(
          "PRECONDITION_FAILED",
          `edge '${e.from}->${e.to}' references missing node '${id}'`,
          "create the node first, or fix the edge endpoint",
        );
      }
    }
  }

  // Stamp the freshness envelope: rebuild (or no prior meta) starts a new
  // build epoch; an ordinary write just moves updatedAt and bumps generation.
  const now = new Date().toISOString();
  const rebuild = opts?.rebuild === true;
  const meta: MapMeta = {
    builtAt: rebuild ? now : (current.meta?.builtAt ?? now),
    updatedAt: now,
    generation: rebuild ? 1 : (current.meta?.generation ?? 0) + 1,
  };

  writeMap(projectDir, { nodes, edges, meta });
  return { nodes: Object.keys(nodes).length, edges: edges.length };
}

function sortMap(map: ProjectMap): ProjectMap {
  const nodes: Record<string, MapNode> = {};
  for (const id of Object.keys(map.nodes).sort()) nodes[id] = map.nodes[id];
  const edges = [...map.edges].sort((a, b) =>
    a.from !== b.from
      ? a.from < b.from
        ? -1
        : 1
      : a.to !== b.to
        ? a.to < b.to
          ? -1
          : 1
        : a.type !== b.type
          ? a.type < b.type
            ? -1
            : 1
          : 0,
  );
  return { nodes, edges, ...(map.meta ? { meta: map.meta } : {}) };
}

function pickNodes(
  nodes: Record<string, MapNode>,
  ids: Set<string>,
): Record<string, MapNode> {
  const out: Record<string, MapNode> = {};
  for (const id of [...ids].sort()) if (id in nodes) out[id] = nodes[id];
  return out;
}

/** Missing file reads as an empty store: `{ nodes: {}, edges: [] }`. */
export function mapGet(
  projectDir: string,
  filter?: {
    nodeType?: NodeType;
    edgeType?: EdgeType;
    node?: string;
  },
): ProjectMap {
  const map = sortMap(readMap(projectDir));
  if (!filter) return map;

  // Filtered views carry the meta envelope through unchanged -- freshness
  // describes the store, not the slice.
  const meta = map.meta ? { meta: map.meta } : {};

  // Node view semantics: self + touching edges + neighbors, with the other
  // filters honored too -- edgeType narrows the touching edges (and thus
  // which neighbors are reachable), nodeType narrows the NEIGHBOR set (the
  // anchor always stays, even when its own type misses the filter), and any
  // edge left dangling at a filtered-out neighbor is dropped rather than
  // pointing at a node the caller can't see.
  if (filter.node !== undefined) {
    const id = filter.node;
    if (!(id in map.nodes)) return { nodes: {}, edges: [], ...meta };
    let edges = map.edges.filter((e) => e.from === id || e.to === id);
    if (filter.edgeType !== undefined) {
      edges = edges.filter((e) => e.type === filter.edgeType);
    }
    const ids = new Set<string>([id]);
    for (const e of edges) {
      ids.add(e.from);
      ids.add(e.to);
    }
    if (filter.nodeType !== undefined) {
      for (const nid of [...ids]) {
        if (nid !== id && map.nodes[nid].type !== filter.nodeType)
          ids.delete(nid);
      }
      edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    }
    return { nodes: pickNodes(map.nodes, ids), edges, ...meta };
  }

  let nodeEntries = Object.entries(map.nodes);
  if (filter.nodeType !== undefined) {
    nodeEntries = nodeEntries.filter(([, n]) => n.type === filter.nodeType);
  }
  let edges = map.edges;
  if (filter.edgeType !== undefined) {
    edges = edges.filter((e) => e.type === filter.edgeType);
  }
  return { nodes: Object.fromEntries(nodeEntries), edges, ...meta };
}

export interface MapQuery {
  node?: string; // anchor id for a neighborhood view
  depth?: number; // 0-3 hops out from the anchor (default 1)
  nodeType?: NodeType;
  edgeType?: EdgeType;
  label?: string; // case-insensitive substring over node labels
}

/**
 * Composite query over an in-memory ProjectMap -- pure, no disk I/O, so the
 * neighborhood/filter logic is testable without a store on disk.
 *
 * Semantics, in order:
 * - node + depth: BFS over edges in BOTH directions, up to `depth` hops
 *   (default 1; depth 0 is just the anchor). Unknown anchor -> empty result.
 *   Traversal walks the edgeType-filtered edge set, so an edgeType filter
 *   shapes the neighborhood too.
 * - nodeType / label then narrow the surviving nodes (all filters AND).
 * - Edges in the result are only those with BOTH endpoints in the final node
 *   set -- a half-dangling edge would point at a node the caller can't see,
 *   which is worse than omitting it.
 */
export function queryMap(map: ProjectMap, q: MapQuery): ProjectMap {
  const meta = map.meta ? { meta: map.meta } : {};
  const depth = q.depth ?? 1;
  const edgePool =
    q.edgeType !== undefined
      ? map.edges.filter((e) => e.type === q.edgeType)
      : map.edges;

  // Candidate set: BFS neighborhood around the anchor, or every node.
  let candidates: Set<string>;
  if (q.node !== undefined) {
    if (!(q.node in map.nodes)) return { nodes: {}, edges: [], ...meta };
    candidates = new Set([q.node]);
    let frontier = new Set([q.node]);
    for (let hop = 0; hop < depth && frontier.size > 0; hop++) {
      const next = new Set<string>();
      for (const e of edgePool) {
        // undirected walk: an edge touches the frontier from either end
        if (frontier.has(e.from) && !candidates.has(e.to)) next.add(e.to);
        if (frontier.has(e.to) && !candidates.has(e.from)) next.add(e.from);
      }
      for (const id of next) candidates.add(id);
      frontier = next;
    }
  } else {
    candidates = new Set(Object.keys(map.nodes));
  }

  // Attribute filters AND together over the candidate set.
  const needle = q.label?.toLowerCase();
  const ids = new Set(
    [...candidates].filter((id) => {
      const n = map.nodes[id];
      if (q.nodeType !== undefined && n.type !== q.nodeType) return false;
      if (needle !== undefined && !n.label.toLowerCase().includes(needle))
        return false;
      return true;
    }),
  );

  const edges = edgePool.filter((e) => ids.has(e.from) && ids.has(e.to));
  return sortMap({ nodes: pickNodes(map.nodes, ids), edges, ...meta });
}

/** Disk-backed wrapper: read the store (missing file -> empty, no meta) and query it. */
export function mapQuery(projectDir: string, q: MapQuery): ProjectMap {
  return queryMap(readMap(projectDir), q);
}
