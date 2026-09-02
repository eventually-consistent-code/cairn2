import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parsePhaseDirName, plansRoot } from "./artifacts.js";
import { projectStatus } from "./status.js";
const DOC_EXT_RE = /\.(md|mdx|markdown)$/;
function verifiedPhases(projectDir) {
    const root = plansRoot(projectDir);
    const out = [];
    for (const p of projectStatus(projectDir).phases) {
        if (!p.hasVerification)
            continue;
        out.push({
            id: p.dir, number: p.number, name: p.name,
            ledgerRel: join(".cairn", "plans", "phases", p.dir, "LEDGER.md"),
        });
    }
    // Archived phases -- summit moves verified phase dirs under
    // milestones/vN (see milestoneComplete); the docs still owe them entries.
    const msDir = join(root, "milestones");
    if (existsSync(msDir)) {
        for (const v of readdirSync(msDir).filter((d) => /^v\d+$/.test(d))
            .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
            for (const entry of readdirSync(join(msDir, v))) {
                const parsed = parsePhaseDirName(entry);
                if (!parsed)
                    continue;
                if (!existsSync(join(msDir, v, entry, "VERIFICATION.md")))
                    continue;
                out.push({
                    id: join("milestones", v, entry),
                    number: parsed.number,
                    name: parsed.slug.replace(/-/g, " "),
                    ledgerRel: join(".cairn", "plans", "milestones", v, entry, "LEDGER.md"),
                });
            }
        }
    }
    out.sort((a, b) => a.number - b.number);
    return out;
}
// Committer timestamp (%ct) of the newest commit touching any of `paths`,
// or undefined when git can't answer (no repo, no commits, path never
// committed). Git data only -- no wall clock, so the report is deterministic
// for a given repo state.
function gitTimestamp(projectDir, paths) {
    try {
        const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", ...paths], { cwd: projectDir, encoding: "utf8" }).trim();
        return out ? Number(out) : undefined;
    }
    catch {
        return undefined;
    }
}
// Lowercased contents of CHANGELOG.md plus every markdown file under docs/.
function docsCorpus(projectDir) {
    const corpus = [];
    const changelog = join(projectDir, "CHANGELOG.md");
    if (existsSync(changelog))
        corpus.push(readFileSync(changelog, "utf8").toLowerCase());
    const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (DOC_EXT_RE.test(entry))
                corpus.push(readFileSync(path, "utf8").toLowerCase());
        }
    };
    const docsDir = join(projectDir, "docs");
    if (existsSync(docsDir))
        walk(docsDir);
    return corpus;
}
/**
 * Deterministic docs-drift report -- which verified phases (live AND
 * archived) the public docs have not caught up with. Two signals per phase,
 * either miss flags it:
 *   (a) no file in CHANGELOG.md + the docs/ tree mentions the phase
 *       (by "phase N" label or by name);
 *   (b) the newest git commit touching docs/CHANGELOG.md predates the
 *       phase's last LEDGER.md commit.
 * Pure filesystem + git reads -- no tracker, no LLM judgment, no Date.now.
 */
export function docsDriftReport(projectDir) {
    const flagged = [];
    const ok = [];
    const corpus = docsCorpus(projectDir);
    const docsTime = gitTimestamp(projectDir, ["docs", "CHANGELOG.md"]);
    for (const phase of verifiedPhases(projectDir)) {
        const reasons = [];
        // (a) stamp check -- the canonical "Phase N" label or the phase's plain
        // name (ledger headers, changelog entries, and milestone groupings all
        // carry one of the two).
        const needles = [`phase ${phase.number}`, phase.name.toLowerCase()];
        if (!corpus.some((text) => needles.some((n) => text.includes(n)))) {
            reasons.push("no CHANGELOG.md or docs/ entry mentions this phase");
        }
        // (b) recency check -- only when the ledger has git history to compare
        // against (an uncommitted or absent ledger has no timestamp to owe).
        const ledgerTime = gitTimestamp(projectDir, [phase.ledgerRel]);
        if (ledgerTime !== undefined && (docsTime === undefined || docsTime < ledgerTime)) {
            reasons.push("newest docs/CHANGELOG.md commit predates the phase's last LEDGER.md commit");
        }
        if (reasons.length > 0) {
            flagged.push({ phase: phase.id, reason: reasons.join("; ") });
        }
        else {
            ok.push(phase.id);
        }
    }
    return { flagged, ok };
}
