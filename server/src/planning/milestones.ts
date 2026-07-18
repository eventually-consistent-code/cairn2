import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import type { Milestone, Tracker } from "../tracker/types.js";
import { plansRoot } from "./artifacts.js";
import { projectStatus } from "./status.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

export interface RoadmapMeta { milestone: number; milestoneId?: string; lastResync?: string }

const roadmapPath = (projectDir: string) => join(plansRoot(projectDir), "roadmap.md");

function readRoadmapRaw(projectDir: string): {
  data: Record<string, string | string[]>; body: string;
} {
  const path = roadmapPath(projectDir);
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND", "no roadmap.md under .cairn/plans",
      "run plan_scaffold_project first");
  }
  return parseFrontmatter(readFileSync(path, "utf8"));
}

export function readRoadmapMeta(projectDir: string): RoadmapMeta {
  const { data } = readRoadmapRaw(projectDir);
  const n = data.milestone === undefined ? 1 : Number(data.milestone);
  if (!Number.isInteger(n) || n < 1) {
    throw new CairnError("CONFIG_INVALID", `roadmap.md milestone: must be an int >= 1, got '${data.milestone}'`);
  }
  const meta: RoadmapMeta = { milestone: n };
  if (typeof data.milestone_id === "string" && data.milestone_id) meta.milestoneId = data.milestone_id;
  if (typeof data.last_resync === "string" && data.last_resync) meta.lastResync = data.last_resync;
  return meta;
}

export function patchRoadmapMeta(projectDir: string,
  patch: { milestone?: number; milestoneId?: string | null; lastResync?: string }): void {
  const { data, body } = readRoadmapRaw(projectDir);
  if (patch.milestone !== undefined) data.milestone = String(patch.milestone);
  if (patch.milestoneId === null) delete data.milestone_id;
  else if (patch.milestoneId !== undefined) data.milestone_id = patch.milestoneId;
  if (patch.lastResync !== undefined) data.last_resync = patch.lastResync;
  writeFileSync(roadmapPath(projectDir), serializeFrontmatter(data, body));
}

export interface MilestoneCompleteReport {
  closedPhases: string[]; skippedPhases: Array<{ dir: string; reason: string }>;
  released?: Milestone; archivedTo: string; nextMilestone: number;
}

export async function milestoneComplete(tracker: Tracker, projectDir: string,
  summary: string): Promise<MilestoneCompleteReport> {
  const status = projectStatus(projectDir);
  if (status.phases.length === 0) {
    throw new CairnError("PRECONDITION_FAILED", "no live phases to complete",
      "scaffold and work phases before summit");
  }
  const unverified = status.phases.filter((p) => !p.hasVerification);
  if (unverified.length > 0) {
    throw new CairnError("PRECONDITION_FAILED",
      `unverified phases: ${unverified.map((p) => p.dir).join(", ")}`,
      "run /cairn verify <N> for each before summit");
  }
  const meta = readRoadmapMeta(projectDir);

  // -- tracker steps (collect errors; archive only runs when these fully succeed)
  const closedPhases: string[] = [];
  const skippedPhases: Array<{ dir: string; reason: string }> = [];
  const errors: string[] = [];
  const trackerPhases = await tracker.listPhases();
  for (const p of status.phases) {
    const match = trackerPhases.find((tp) => tp.name.startsWith(`Phase ${p.number}:`));
    if (!match) { skippedPhases.push({ dir: p.dir, reason: "no tracker phase object" }); continue; }
    if (match.state === "closed") { closedPhases.push(match.id); continue; }
    if (!tracker.capabilities.hasPhaseClose) {
      skippedPhases.push({ dir: p.dir, reason: "backend phase primitive has no closed state" });
      continue;
    }
    try {
      await tracker.closePhase(match.id);
      closedPhases.push(match.id);
    } catch (e) {
      errors.push(`closePhase(${match.id}): ${e}`);
    }
  }
  let released: Milestone | undefined;
  if (tracker.capabilities.hasMilestones && meta.milestoneId) {
    try {
      released = await tracker.completeMilestone(meta.milestoneId);
    } catch (e) {
      errors.push(`completeMilestone(${meta.milestoneId}): ${e}`);
    }
  }
  if (errors.length > 0) {
    throw new CairnError("TRACKER_DOWN",
      `milestone_complete tracker steps failed: ${errors.join("; ")}`,
      "fix and re-run — completed steps are idempotent, nothing was archived");
  }

  // -- archive (only after tracker steps fully succeeded)
  const dest = join(plansRoot(projectDir), "milestones", `v${meta.milestone}`);
  mkdirSync(dest, { recursive: true });
  for (const p of status.phases) {
    renameSync(join(plansRoot(projectDir), "phases", p.dir), join(dest, p.dir));
  }
  const { data, body } = readRoadmapRaw(projectDir);
  const archiveNote = `\n## Archived — v${meta.milestone}\n\n`
    + `${summary} — see milestones/v${meta.milestone}/\n`;
  data.milestone = String(meta.milestone + 1);
  delete data.milestone_id;
  writeFileSync(roadmapPath(projectDir), serializeFrontmatter(data, body + archiveNote));

  return {
    closedPhases, skippedPhases, released,
    archivedTo: join(".cairn", "plans", "milestones", `v${meta.milestone}`),
    nextMilestone: meta.milestone + 1,
  };
}

export async function milestoneCreate(tracker: Tracker, projectDir: string,
  name: string): Promise<{ milestone: number; native?: Milestone }> {
  const meta = readRoadmapMeta(projectDir);
  let native: Milestone | undefined;
  if (tracker.capabilities.hasMilestones) {
    native = await tracker.createMilestone(name);
    patchRoadmapMeta(projectDir, { milestoneId: native.id });
  }
  return { milestone: meta.milestone, native };
}

export async function milestoneList(tracker: Tracker, projectDir: string):
  Promise<{ current: number; currentId?: string; archived: string[]; native?: Milestone[] }> {
  const meta = readRoadmapMeta(projectDir);
  const msDir = join(plansRoot(projectDir), "milestones");
  const archived = existsSync(msDir)
    ? readdirSync(msDir).filter((d) => /^v\d+$/.test(d))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    : [];
  const out: { current: number; currentId?: string; archived: string[]; native?: Milestone[] } =
    { current: meta.milestone, archived };
  if (meta.milestoneId) out.currentId = meta.milestoneId;
  if (tracker.capabilities.hasMilestones) out.native = await tracker.listMilestones();
  return out;
}
