import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { plansRoot, readPlanIssues } from "./artifacts.js";
const PHASE_DIR_RE = /^(\d{2})-([a-z0-9-]+)$/;
export function projectStatus(projectDir) {
    const root = plansRoot(projectDir);
    const hasProject = existsSync(join(root, "PROJECT.md"));
    const hasRoadmap = existsSync(join(root, "roadmap.md"));
    const phasesDir = join(root, "phases");
    const phases = [];
    if (existsSync(phasesDir)) {
        for (const entry of readdirSync(phasesDir)) {
            const m = PHASE_DIR_RE.exec(entry);
            if (!m)
                continue;
            const base = join(phasesDir, entry);
            phases.push({
                number: Number(m[1]),
                dir: entry,
                name: m[2].replace(/-/g, " "),
                hasContext: existsSync(join(base, "CONTEXT.md")),
                hasResearch: existsSync(join(base, "RESEARCH.md")),
                hasPlan: existsSync(join(base, "PLAN.md")),
                hasVerification: existsSync(join(base, "VERIFICATION.md")),
                issues: readPlanIssues(projectDir, entry),
            });
        }
    }
    phases.sort((a, b) => a.number - b.number);
    return { hasProject, hasRoadmap, phases };
}
