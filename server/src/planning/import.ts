import { basename, resolve } from "node:path";
import { CairnError } from "../errors.js";
import type { Tracker } from "../tracker/types.js";
import {
  phaseDirName, scaffoldPhase, scaffoldProject, slugify, writePlanIssues,
} from "./artifacts.js";
import { projectStatus } from "./status.js";

export interface ImportResult {
  dir: string;
  number: number;
  name: string;
  trackerPhaseId: string;
  issues: string[];
  created: string[];
}

const CANONICAL_RE = /^Phase (\d+): (.+)$/;

export async function importPhase(
  tracker: Tracker, projectDir: string, phaseRef: string,
): Promise<ImportResult> {
  const phases = await tracker.listPhases();
  let phase = phases.find((p) => p.id === phaseRef);
  if (!phase) {
    const matches = phases.filter((p) =>
      p.name.toLowerCase().includes(phaseRef.toLowerCase()));
    if (matches.length > 1) {
      throw new CairnError("CONFIG_INVALID",
        `'${phaseRef}' matches ${matches.length} tracker phases: ${matches
          .map((p) => `'${p.name}'`).join(", ")}`,
        "re-run with the exact phase id");
    }
    phase = matches[0];
  }
  if (!phase) {
    throw new CairnError("NOT_FOUND", `no tracker phase matching '${phaseRef}'`,
      "list phases with phase_list to find the right id or name");
  }

  const canonical = CANONICAL_RE.exec(phase.name);
  const status = projectStatus(projectDir);
  const number = canonical
    ? Number(canonical[1])
    : Math.max(0, ...status.phases.map((p) => p.number)) + 1;
  const name = canonical ? canonical[2] : phase.name;

  const dirName = phaseDirName(number, slugify(name));
  const existing = status.phases.find((p) => p.number === number);
  if (existing && existing.dir !== dirName) {
    throw new CairnError("CONFIG_INVALID",
      `phase number ${number} already exists as '${existing.dir}' (importing '${dirName}')`,
      "rename or remove the conflicting local phase first");
  }

  const proj = scaffoldProject(projectDir, basename(resolve(projectDir)));
  const ph = scaffoldPhase(projectDir, number, name);
  const issues = (await tracker.listIssues({ phase: phase.id })).map((i) => i.id);
  writePlanIssues(projectDir, ph.dir, issues);

  return {
    dir: ph.dir, number, name, trackerPhaseId: phase.id,
    issues, created: [...proj.created, ...ph.created],
  };
}
