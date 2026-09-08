import { CairnError } from "../errors.js";
import type { Phase, Tracker } from "../tracker/types.js";
import { isValidPhaseNumber, PHASE_NUMBER_ERROR } from "./artifacts.js";
import { projectStatus } from "./status.js";

export const canonicalPhaseName = (number: number, name: string) =>
  `Phase ${number}: ${name}`;

// Tool-layer phase-param resolution (#138). issue_create's `phase` used to
// demand the tracker's internal phase-object id -- a mapping only
// plan_phase_ensure's return value knew, so passing the cairn phase number
// ("14") 422'd on GitHub. Resolve here, once, for every backend: an existing
// phase id passes through untouched (id wins on collision -- backward
// compatible), and a phase NUMBER resolves through the same canonical
// "Phase N: <name>" convention ensurePhase writes. One listPhases fetch
// serves both checks; no cross-call state.
const PHASE_NUMBER_RE = /^\d+(\.\d+)?$/;

export async function resolvePhaseParam(
  tracker: Tracker, phase: string,
): Promise<string> {
  // backends without phases keep their existing adapter-side error path
  if (!tracker.capabilities.hasPhases) return phase;
  const phases = await tracker.listPhases();
  const byId = phases.find((p) => p.id === phase);
  if (byId) return byId.id;
  if (PHASE_NUMBER_RE.test(phase)) {
    const prefix = `Phase ${phase}:`;
    const byNumber = phases.find((p) => p.name.startsWith(prefix));
    if (byNumber) return byNumber.id;
    throw new CairnError("NOT_FOUND",
      `phase '${phase}' matched neither an existing tracker phase id nor a phase named 'Phase ${phase}: ...'`,
      "phase_list shows valid ids; plan_phase_ensure creates the 'Phase N: <name>' phase first");
  }
  throw new CairnError("NOT_FOUND",
    `phase '${phase}' matched no existing tracker phase id, and it is not a cairn phase number (integer or decimal), so the 'Phase N:' name lookup was skipped`,
    "phase_list shows valid ids; plan_phase_ensure creates the 'Phase N: <name>' phase first");
}

export async function ensurePhase(
  tracker: Tracker, number: number, name: string,
): Promise<Phase> {
  if (!isValidPhaseNumber(number)) {
    throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(number));
  }
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
        state = (await tracker.getIssue(issueId)).category;
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
