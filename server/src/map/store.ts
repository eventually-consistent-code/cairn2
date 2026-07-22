import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CairnError } from "../errors.js";

export type NodeType = "module" | "phase" | "issue" | "decision" | "person";
export type EdgeType = "depends-on" | "implements" | "decided-in" | "owns";

export interface MapNode { type: NodeType; label: string; detail?: string; }
export interface MapEdge { from: string; to: string; type: EdgeType; }
export interface ProjectMap { nodes: Record<string, MapNode>; edges: MapEdge[]; }

const NodeTypeSchema = z.enum(["module", "phase", "issue", "decision", "person"]);
const EdgeTypeSchema = z.enum(["depends-on", "implements", "decided-in", "owns"]);
const MapNodeSchema = z.object({
  type: NodeTypeSchema, label: z.string(), detail: z.string().optional(),
});
const MapEdgeSchema = z.object({ from: z.string(), to: z.string(), type: EdgeTypeSchema });

const mapPath = (projectDir: string) => join(projectDir, ".cairn", "map", "map.json");

function readMap(projectDir: string): ProjectMap {
  const path = mapPath(projectDir);
  if (!existsSync(path)) return { nodes: {}, edges: [] };
  return JSON.parse(readFileSync(path, "utf8")) as ProjectMap;
}

function writeMap(projectDir: string, map: ProjectMap): void {
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
 */
export function mapSet(projectDir: string, patch: {
  nodes?: Record<string, MapNode | null>; edges?: MapEdge[];
}): { nodes: number; edges: number } {
  const current = readMap(projectDir);
  const nodes = { ...current.nodes };

  // Merge upserts first (validated); deletes are applied after edges are
  // known, so a delete can be checked against the final edge list.
  for (const [id, value] of Object.entries(patch.nodes ?? {})) {
    if (value === null) continue;
    const parsed = MapNodeSchema.safeParse(value);
    if (!parsed.success) {
      throw new CairnError("UNSUPPORTED",
        `node '${id}' has an invalid type: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        `use one of: ${NodeTypeSchema.options.join(", ")}`);
    }
    nodes[id] = parsed.data;
  }

  let edges = current.edges;
  if (patch.edges !== undefined) {
    for (const e of patch.edges) {
      const parsed = MapEdgeSchema.safeParse(e);
      if (!parsed.success) {
        throw new CairnError("UNSUPPORTED",
          `edge '${e?.from}->${e?.to}' has an invalid type: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          `use one of: ${EdgeTypeSchema.options.join(", ")}`);
      }
    }
    edges = patch.edges;
  }

  for (const [id, value] of Object.entries(patch.nodes ?? {})) {
    if (value !== null) continue;
    const attached = edges.filter((e) => e.from === id || e.to === id);
    if (attached.length > 0) {
      throw new CairnError("PRECONDITION_FAILED",
        `cannot delete node '${id}' -- still attached to edge(s): ${
          attached.map((e) => `${e.from}->${e.to}`).join(", ")}`,
        "drop those edges (patch edges to exclude them) before deleting the node");
    }
    delete nodes[id];
  }

  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!(id in nodes)) {
        throw new CairnError("PRECONDITION_FAILED",
          `edge '${e.from}->${e.to}' references missing node '${id}'`,
          "create the node first, or fix the edge endpoint");
      }
    }
  }

  writeMap(projectDir, { nodes, edges });
  return { nodes: Object.keys(nodes).length, edges: edges.length };
}

function sortMap(map: ProjectMap): ProjectMap {
  const nodes: Record<string, MapNode> = {};
  for (const id of Object.keys(map.nodes).sort()) nodes[id] = map.nodes[id];
  const edges = [...map.edges].sort((a, b) =>
    a.from !== b.from ? (a.from < b.from ? -1 : 1)
      : a.to !== b.to ? (a.to < b.to ? -1 : 1)
        : a.type !== b.type ? (a.type < b.type ? -1 : 1) : 0);
  return { nodes, edges };
}

function pickNodes(nodes: Record<string, MapNode>, ids: Set<string>): Record<string, MapNode> {
  const out: Record<string, MapNode> = {};
  for (const id of [...ids].sort()) if (id in nodes) out[id] = nodes[id];
  return out;
}

/** Missing file reads as an empty store: `{ nodes: {}, edges: [] }`. */
export function mapGet(projectDir: string, filter?: {
  nodeType?: NodeType; edgeType?: EdgeType; node?: string;
}): ProjectMap {
  const map = sortMap(readMap(projectDir));
  if (!filter) return map;

  if (filter.node !== undefined) {
    const id = filter.node;
    if (!(id in map.nodes)) return { nodes: {}, edges: [] };
    const edges = map.edges.filter((e) => e.from === id || e.to === id);
    const ids = new Set<string>([id]);
    for (const e of edges) { ids.add(e.from); ids.add(e.to); }
    return { nodes: pickNodes(map.nodes, ids), edges };
  }

  let nodeEntries = Object.entries(map.nodes);
  if (filter.nodeType !== undefined) {
    nodeEntries = nodeEntries.filter(([, n]) => n.type === filter.nodeType);
  }
  let edges = map.edges;
  if (filter.edgeType !== undefined) {
    edges = edges.filter((e) => e.type === filter.edgeType);
  }
  return { nodes: Object.fromEntries(nodeEntries), edges };
}
