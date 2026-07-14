import { CairnError } from "../errors.js";
import { projectStatus } from "./status.js";
export const canonicalPhaseName = (number, name) => `Phase ${number}: ${name}`;
export async function ensurePhase(tracker, number, name) {
    if (!tracker.capabilities.hasPhases) {
        throw new CairnError("CONFIG_INVALID", "the configured tracker does not support phases", "phase mirroring requires a backend with milestones/epics/sections/lists");
    }
    const canonical = canonicalPhaseName(number, name);
    const existing = (await tracker.listPhases()).find((p) => p.name === canonical);
    if (existing)
        return existing;
    return tracker.createPhase(canonical);
}
export async function driftReport(tracker, projectDir) {
    const flagged = [];
    const ok = [];
    for (const phase of projectStatus(projectDir).phases) {
        for (const issueId of phase.issues) {
            let state;
            try {
                state = (await tracker.getIssue(issueId)).state;
            }
            catch (e) {
                if (e instanceof CairnError && e.code === "NOT_FOUND") {
                    flagged.push({ issueId, phase: phase.number, reason: "missing" });
                    continue;
                }
                throw e; // rate limits / auth problems are NOT drift
            }
            if (state === "closed" && !phase.hasVerification) {
                flagged.push({ issueId, phase: phase.number, reason: "closed" });
            }
            else {
                ok.push(issueId);
            }
        }
    }
    return { flagged, ok };
}
