import { appendSession, closeSession, lastSessionEntry, listSessions, sessionId, startSession, } from "../sessions/store.js";
const toTraceInfo = (s) => ({
    id: s.id, status: s.status, issue: s.issue, created: s.created,
    ...(s.resolved !== undefined ? { resolved: s.resolved } : {}),
    entryCounts: s.entryCounts,
    description: s.description,
});
export const traceId = (description) => sessionId("trace", description);
export const startTrace = (projectDir, description, issueId) => startSession(projectDir, "trace", description, issueId);
export const appendTrace = (projectDir, id, kind, text) => appendSession(projectDir, "trace", id, kind, text);
export const lastEntryKind = (projectDir, id) => lastSessionEntry(projectDir, "trace", id);
export const listTraces = (projectDir, status) => listSessions(projectDir, "trace", status).map(toTraceInfo);
export function closeTrace(projectDir, id, resolution) {
    const { gateTexts, ...rest } = closeSession(projectDir, "trace", id, resolution);
    return { ...rest, verdicts: gateTexts };
}
