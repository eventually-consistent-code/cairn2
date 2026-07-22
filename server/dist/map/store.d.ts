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
export interface ProjectMap {
    nodes: Record<string, MapNode>;
    edges: MapEdge[];
}
/**
 * Single-writer merge-patch, config_set-style: nodes merge by id (null
 * deletes), edges replace wholesale. Every edge endpoint must exist in the
 * post-merge node set, and a node with an edge still attached can't be
 * deleted -- both rejections name the offending id(s).
 */
export declare function mapSet(projectDir: string, patch: {
    nodes?: Record<string, MapNode | null>;
    edges?: MapEdge[];
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
