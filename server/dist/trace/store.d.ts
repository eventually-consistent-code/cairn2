export type TraceKind = "evidence" | "hypothesis" | "test" | "verdict";
export interface TraceInfo {
    id: string;
    status: "open" | "resolved";
    issue: string;
    created: string;
    resolved?: string;
    entryCounts: Record<TraceKind, number>;
    description: string;
}
export declare function traceId(description: string): string;
export declare function startTrace(projectDir: string, description: string, issueId: string): {
    id: string;
    path: string;
};
/** The kind of the final entry block in the trace file (file order), or null if none/missing. */
export declare function lastEntryKind(projectDir: string, id: string): TraceKind | null;
export declare function appendTrace(projectDir: string, id: string, kind: TraceKind, text: string): {
    path: string;
};
export declare function listTraces(projectDir: string, status?: "open" | "resolved"): TraceInfo[];
export declare function closeTrace(projectDir: string, id: string, resolution: string): {
    id: string;
    issue: string;
    description: string;
    verdicts: string[];
    archivePath: string;
};
