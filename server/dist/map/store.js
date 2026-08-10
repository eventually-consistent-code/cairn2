import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CairnError } from "../errors.js";
const NodeTypeSchema = z.enum(["module", "phase", "issue", "decision", "person"]);
const EdgeTypeSchema = z.enum(["depends-on", "implements", "decided-in", "owns"]);
const MapNodeSchema = z.object({
    type: NodeTypeSchema, label: z.string(), detail: z.string().optional(),
});
const MapEdgeSchema = z.object({ from: z.string(), to: z.string(), type: EdgeTypeSchema });
const mapPath = (projectDir) => join(projectDir, ".cairn", "map", "map.json");
function readMap(projectDir) {
    const path = mapPath(projectDir);
    if (!existsSync(path))
        return { nodes: {}, edges: [] };
    return JSON.parse(readFileSync(path, "utf8"));
}
function writeMap(projectDir, map) {
    const path = mapPath(projectDir);
    mkdirSync(join(projectDir, ".cairn", "map"), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
    renameSync(tmp, path);
}
/**
 * Single-writer merge-patch, config_set-style: nodes merge by id (null
 * deletes), edges replace wholesale. Every edge endpoint must exist in the
 * post-merge node set, and a node with an edge still attached can't be
 * deleted -- both rejections name the offending id(s).
 *
 * Every write stamps the meta envelope: updatedAt moves, generation bumps.
 * Design choice: `rebuild: true` signals a from-scratch rebuild -- builtAt
 * resets to now and generation restarts at 1. A first-ever write (or a write
 * over a legacy pre-envelope file) counts as a build too.
 */
export function mapSet(projectDir, patch, opts) {
    const current = readMap(projectDir);
    const nodes = { ...current.nodes };
    // Merge upserts first (validated); deletes are applied after edges are
    // known, so a delete can be checked against the final edge list.
    for (const [id, value] of Object.entries(patch.nodes ?? {})) {
        if (value === null)
            continue;
        const parsed = MapNodeSchema.safeParse(value);
        if (!parsed.success) {
            throw new CairnError("UNSUPPORTED", `node '${id}' has an invalid type: ${parsed.error.issues.map((i) => i.message).join("; ")}`, `use one of: ${NodeTypeSchema.options.join(", ")}`);
        }
        nodes[id] = parsed.data;
    }
    let edges = current.edges;
    if (patch.edges !== undefined) {
        for (const e of patch.edges) {
            const parsed = MapEdgeSchema.safeParse(e);
            if (!parsed.success) {
                throw new CairnError("UNSUPPORTED", `edge '${e?.from}->${e?.to}' has an invalid type: ${parsed.error.issues.map((i) => i.message).join("; ")}`, `use one of: ${EdgeTypeSchema.options.join(", ")}`);
            }
        }
        edges = patch.edges;
    }
    for (const [id, value] of Object.entries(patch.nodes ?? {})) {
        if (value !== null)
            continue;
        const attached = edges.filter((e) => e.from === id || e.to === id);
        if (attached.length > 0) {
            throw new CairnError("PRECONDITION_FAILED", `cannot delete node '${id}' -- still attached to edge(s): ${attached.map((e) => `${e.from}->${e.to}`).join(", ")}`, "drop those edges (patch edges to exclude them) before deleting the node");
        }
        delete nodes[id];
    }
    for (const e of edges) {
        for (const id of [e.from, e.to]) {
            if (!(id in nodes)) {
                throw new CairnError("PRECONDITION_FAILED", `edge '${e.from}->${e.to}' references missing node '${id}'`, "create the node first, or fix the edge endpoint");
            }
        }
    }
    // Stamp the freshness envelope: rebuild (or no prior meta) starts a new
    // build epoch; an ordinary write just moves updatedAt and bumps generation.
    const now = new Date().toISOString();
    const rebuild = opts?.rebuild === true;
    const meta = {
        builtAt: rebuild ? now : current.meta?.builtAt ?? now,
        updatedAt: now,
        generation: rebuild ? 1 : (current.meta?.generation ?? 0) + 1,
    };
    writeMap(projectDir, { nodes, edges, meta });
    return { nodes: Object.keys(nodes).length, edges: edges.length };
}
function sortMap(map) {
    const nodes = {};
    for (const id of Object.keys(map.nodes).sort())
        nodes[id] = map.nodes[id];
    const edges = [...map.edges].sort((a, b) => a.from !== b.from ? (a.from < b.from ? -1 : 1)
        : a.to !== b.to ? (a.to < b.to ? -1 : 1)
            : a.type !== b.type ? (a.type < b.type ? -1 : 1) : 0);
    return { nodes, edges, ...(map.meta ? { meta: map.meta } : {}) };
}
function pickNodes(nodes, ids) {
    const out = {};
    for (const id of [...ids].sort())
        if (id in nodes)
            out[id] = nodes[id];
    return out;
}
/** Missing file reads as an empty store: `{ nodes: {}, edges: [] }`. */
export function mapGet(projectDir, filter) {
    const map = sortMap(readMap(projectDir));
    if (!filter)
        return map;
    // Filtered views carry the meta envelope through unchanged -- freshness
    // describes the store, not the slice.
    const meta = map.meta ? { meta: map.meta } : {};
    if (filter.node !== undefined) {
        const id = filter.node;
        if (!(id in map.nodes))
            return { nodes: {}, edges: [], ...meta };
        const edges = map.edges.filter((e) => e.from === id || e.to === id);
        const ids = new Set([id]);
        for (const e of edges) {
            ids.add(e.from);
            ids.add(e.to);
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
export function queryMap(map, q) {
    const meta = map.meta ? { meta: map.meta } : {};
    const depth = q.depth ?? 1;
    const edgePool = q.edgeType !== undefined
        ? map.edges.filter((e) => e.type === q.edgeType) : map.edges;
    // Candidate set: BFS neighborhood around the anchor, or every node.
    let candidates;
    if (q.node !== undefined) {
        if (!(q.node in map.nodes))
            return { nodes: {}, edges: [], ...meta };
        candidates = new Set([q.node]);
        let frontier = new Set([q.node]);
        for (let hop = 0; hop < depth && frontier.size > 0; hop++) {
            const next = new Set();
            for (const e of edgePool) {
                // undirected walk: an edge touches the frontier from either end
                if (frontier.has(e.from) && !candidates.has(e.to))
                    next.add(e.to);
                if (frontier.has(e.to) && !candidates.has(e.from))
                    next.add(e.from);
            }
            for (const id of next)
                candidates.add(id);
            frontier = next;
        }
    }
    else {
        candidates = new Set(Object.keys(map.nodes));
    }
    // Attribute filters AND together over the candidate set.
    const needle = q.label?.toLowerCase();
    const ids = new Set([...candidates].filter((id) => {
        const n = map.nodes[id];
        if (q.nodeType !== undefined && n.type !== q.nodeType)
            return false;
        if (needle !== undefined && !n.label.toLowerCase().includes(needle))
            return false;
        return true;
    }));
    const edges = edgePool.filter((e) => ids.has(e.from) && ids.has(e.to));
    return sortMap({ nodes: pickNodes(map.nodes, ids), edges, ...meta });
}
/** Disk-backed wrapper: read the store (missing file -> empty, no meta) and query it. */
export function mapQuery(projectDir, q) {
    return queryMap(readMap(projectDir), q);
}
