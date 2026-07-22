export type SessionKind = "trace" | "probe" | "draft" | "thread";
export interface KindSpec {
    kind: SessionKind;
    entryKinds: readonly string[];
    closeGate: string;
}
export declare const KIND_SPECS: Record<SessionKind, KindSpec>;
export interface SessionInfo {
    kind: SessionKind;
    id: string;
    status: "open" | "resolved";
    issue: string;
    created: string;
    resolved?: string;
    phase?: string;
    entryCounts: Record<string, number>;
    description: string;
}
export declare function sessionId(kind: SessionKind, description: string): string;
export declare function startSession(projectDir: string, kind: SessionKind, description: string, issueId: string, phase?: string): {
    id: string;
    path: string;
};
export declare function lastSessionEntry(projectDir: string, kind: SessionKind, id: string): string | null;
export declare function appendSession(projectDir: string, kind: SessionKind, id: string, entryKind: string, text: string): {
    path: string;
};
export declare function listSessions(projectDir: string, kind: SessionKind, status?: "open" | "resolved"): SessionInfo[];
export declare function closeSession(projectDir: string, kind: SessionKind, id: string, resolution: string): {
    id: string;
    issue: string;
    description: string;
    gateTexts: string[];
    archivePath: string;
};
export declare function sessionResolution(projectDir: string, kind: SessionKind, id: string): string | null;
export interface Landscape {
    sessions: Array<SessionInfo & {
        resolution?: string;
    }>;
    openByKind: Record<SessionKind, number>;
    phases: Array<{
        phase: string;
        sessions: string[];
    }>;
}
/**
 * Deterministic cross-kind session join: sorted kind (trace, probe, draft)
 * then id; archived sessions carry their resolution text -- this is the
 * "already probed, verdict was stop" memory frontier mode must never lose.
 */
export declare function sessionLandscape(projectDir: string): Landscape;
