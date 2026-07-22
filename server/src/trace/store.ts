import {
  appendSession, closeSession, lastSessionEntry, listSessions,
  sessionId, startSession, type SessionInfo,
} from "../sessions/store.js";

export type TraceKind = "evidence" | "hypothesis" | "test" | "verdict";
export interface TraceInfo {
  id: string; status: "open" | "resolved"; issue: string;
  created: string; resolved?: string;
  entryCounts: Record<TraceKind, number>;
  description: string;
}

const toTraceInfo = (s: SessionInfo): TraceInfo => ({
  id: s.id, status: s.status, issue: s.issue, created: s.created,
  ...(s.resolved !== undefined ? { resolved: s.resolved } : {}),
  entryCounts: s.entryCounts as Record<TraceKind, number>,
  description: s.description,
});

export const traceId = (description: string) => sessionId("trace", description);
export const startTrace = (projectDir: string, description: string, issueId: string) =>
  startSession(projectDir, "trace", description, issueId);
export const appendTrace = (projectDir: string, id: string, kind: TraceKind, text: string) =>
  appendSession(projectDir, "trace", id, kind, text);
export const lastEntryKind = (projectDir: string, id: string) =>
  lastSessionEntry(projectDir, "trace", id) as TraceKind | null;
export const listTraces = (projectDir: string, status?: "open" | "resolved") =>
  listSessions(projectDir, "trace", status).map(toTraceInfo);
export function closeTrace(projectDir: string, id: string, resolution: string): {
  id: string; issue: string; description: string; verdicts: string[]; archivePath: string;
} {
  const { gateTexts, ...rest } = closeSession(projectDir, "trace", id, resolution);
  return { ...rest, verdicts: gateTexts };
}
