import { CairnError } from "../errors.js";
import type { Phase, Tracker } from "../tracker/types.js";
import { projectStatus } from "./status.js";

export const canonicalPhaseName = (number: number, name: string) =>
  `Phase ${number}: ${name}`;

export async function ensurePhase(
  tracker: Tracker, number: number, name: string,
): Promise<Phase> {
  if (!tracker.capabilities.hasPhases) {
    throw new CairnError("CONFIG_INVALID",
      "the configured tracker does not support phases",
      "phase mirroring requires a backend with milestones/epics/sections/lists");
  }
  const canonical = canonicalPhaseName(number, name);
  const existing = (await tracker.listPhases()).find((p) => p.name === canonical);
  if (existing) return existing;
  return tracker.createPhase(canonical);
}

export interface DriftItem {
  issueId: string; phase: number; reason: "missing" | "closed";
}

export async function driftReport(
  tracker: Tracker, projectDir: string,
): Promise<{ flagged: DriftItem[]; ok: string[] }> {
  const flagged: DriftItem[] = [];
  const ok: string[] = [];
  for (const phase of projectStatus(projectDir).phases) {
    for (const issueId of phase.issues) {
      let state: string;
      try {
        state = (await tracker.getIssue(issueId)).state;
      } catch (e) {
        if (e instanceof CairnError && e.code === "NOT_FOUND") {
          flagged.push({ issueId, phase: phase.number, reason: "missing" });
          continue;
        }
        throw e; // rate limits / auth problems are NOT drift
      }
      if (state === "closed" && !phase.hasVerification) {
        flagged.push({ issueId, phase: phase.number, reason: "closed" });
      } else {
        ok.push(issueId);
      }
    }
  }
  return { flagged, ok };
}
