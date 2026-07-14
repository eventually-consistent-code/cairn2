import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { plansRoot, readPlanIssues } from "./artifacts.js";

export interface PhaseInfo {
  number: number; dir: string; name: string;
  hasContext: boolean; hasResearch: boolean;
  hasPlan: boolean; hasVerification: boolean;
  issues: string[];
  parseError?: string;
}

const PHASE_DIR_RE = /^(\d{2})-([a-z0-9-]+)$/;

export function projectStatus(projectDir: string): {
  hasProject: boolean; hasRoadmap: boolean; phases: PhaseInfo[];
} {
  const root = plansRoot(projectDir);
  const hasProject = existsSync(join(root, "PROJECT.md"));
  const hasRoadmap = existsSync(join(root, "roadmap.md"));
  const phasesDir = join(root, "phases");
  const phases: PhaseInfo[] = [];
  if (existsSync(phasesDir)) {
    for (const entry of readdirSync(phasesDir)) {
      const m = PHASE_DIR_RE.exec(entry);
      if (!m) continue;
      const base = join(phasesDir, entry);
      let issues: string[] = [];
      let parseError: string | undefined;
      try {
        issues = readPlanIssues(projectDir, entry);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        parseError = `${entry}: ${message}`;
      }
      phases.push({
        number: Number(m[1]),
        dir: entry,
        name: m[2].replace(/-/g, " "),
        hasContext: existsSync(join(base, "CONTEXT.md")),
        hasResearch: existsSync(join(base, "RESEARCH.md")),
        hasPlan: existsSync(join(base, "PLAN.md")),
        hasVerification: existsSync(join(base, "VERIFICATION.md")),
        issues,
        ...(parseError ? { parseError } : {}),
      });
    }
  }
  phases.sort((a, b) => a.number - b.number);
  return { hasProject, hasRoadmap, phases };
}
