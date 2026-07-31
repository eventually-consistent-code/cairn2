import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePhaseDirName, plansRoot, readPlanIssues } from "./artifacts.js";
export function projectStatus(projectDir) {
    const root = plansRoot(projectDir);
    const hasProject = existsSync(join(root, "PROJECT.md"));
    const hasRoadmap = existsSync(join(root, "roadmap.md"));
    const phasesDir = join(root, "phases");
    const phases = [];
    if (existsSync(phasesDir)) {
        for (const entry of readdirSync(phasesDir)) {
            const parsed = parsePhaseDirName(entry);
            if (!parsed)
                continue;
            const base = join(phasesDir, entry);
            let issues = [];
            let parseError;
            try {
                issues = readPlanIssues(projectDir, entry);
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                parseError = `${entry}: ${message}`;
            }
            phases.push({
                number: parsed.number,
                dir: entry,
                name: parsed.slug.replace(/-/g, " "),
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
