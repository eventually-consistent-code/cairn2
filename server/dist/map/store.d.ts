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
export declare function mapSet(projectDir: string, patch: {
    nodes?: Record<string, MapNode | null>;
    edges?: MapEdge[];
    edgesAdd?: MapEdge[];
    edgesRemove?: MapEdge[];
}, opts?: {
    rebuild?: boolean;
}): {
    nodes: number;
    edges: number;
};
/** Missing file reads as an empty store: `{ nodes: {}, edges: [] }`. */
export declare function mapGet(projectDir: string, filter?: {
    nodeType?: NodeType;
    edgeType?: EdgeType;
    node?: string;
}): ProjectMap;
export interface MapQuery {
    node?: string;
    depth?: number;
    nodeType?: NodeType;
    edgeType?: EdgeType;
    label?: string;
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
export declare function queryMap(map: ProjectMap, q: MapQuery): ProjectMap;
/** Disk-backed wrapper: read the store (missing file -> empty, no meta) and query it. */
export declare function mapQuery(projectDir: string, q: MapQuery): ProjectMap;
