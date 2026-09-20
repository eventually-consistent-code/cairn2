import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { projectStatus } from "./status.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
const roadmapPath = (projectDir) => join(plansRoot(projectDir), "roadmap.md");
function readRoadmapRaw(projectDir) {
    const path = roadmapPath(projectDir);
    if (!existsSync(path)) {
        throw new CairnError("NOT_FOUND", "no roadmap.md under .cairn/plans", "run plan_scaffold_project first");
    }
    return parseFrontmatter(readFileSync(path, "utf8"));
}
export function readRoadmapMeta(projectDir) {
    const { data } = readRoadmapRaw(projectDir);
    const n = data.milestone === undefined ? 1 : Number(data.milestone);
    if (!Number.isInteger(n) || n < 1) {
        throw new CairnError("CONFIG_INVALID", `roadmap.md milestone: must be an int >= 1, got '${data.milestone}'`);
    }
    const meta = { milestone: n };
    if (typeof data.milestone_id === "string" && data.milestone_id)
        meta.milestoneId = data.milestone_id;
    if (typeof data.last_resync === "string" && data.last_resync)
        meta.lastResync = data.last_resync;
    return meta;
}
export function patchRoadmapMeta(projectDir, patch) {
    const { data, body } = readRoadmapRaw(projectDir);
    if (patch.milestone !== undefined)
        data.milestone = String(patch.milestone);
    if (patch.milestoneId === null)
        delete data.milestone_id;
    else if (patch.milestoneId !== undefined)
        data.milestone_id = patch.milestoneId;
    if (patch.lastResync !== undefined)
        data.last_resync = patch.lastResync;
    writeRoadmap(projectDir, data, body);
}
/**
 * Single writer for roadmap.md. A roadmap carrying no frontmatter (a
 * freshly scaffolded one) keeps carrying none -- serializeFrontmatter
 * would otherwise stamp an empty `---\n---` block onto a human's file
 * just because something touched a table row.
 */
function writeRoadmap(projectDir, data, body) {
    writeFileSync(roadmapPath(projectDir), Object.keys(data).length > 0 ? serializeFrontmatter(data, body) : body);
}
const PHASE_CELL_RE = /^\d+(?:\.\d+)?$/;
/** Leading whitespace, content, trailing whitespace of one table cell. */
const CELL_RE = /^(\s*)(.*?)(\s*)$/;
/**
 * The three cells of a `| a | b | c |` line with their padding intact, or
 * null for anything that is not a three-cell row: prose, the header, the
 * separator -- and a struck-through row from `route remove` (`~~7~~`),
 * which a status patch must never resurrect.
 */
function rowCells(line) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|"))
        return null;
    const cells = trimmed.split("|").slice(1, -1);
    return cells.length === 3 ? cells : null;
}
/** Every phase row of a roadmap body, in document order. */
export function parseRoadmapRows(body) {
    const rows = [];
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
        const cells = rowCells(lines[i]);
        if (!cells)
            continue;
        const phase = cells[0].trim();
        if (!PHASE_CELL_RE.test(phase))
            continue;
        rows.push({
            number: Number(phase), name: cells[1].trim(), status: cells[2].trim(), line: i,
        });
    }
    return rows;
}
/**
 * Rewrites the Status cell of every row `wanted` names whose current value
 * differs, preserving that cell's own padding so a patched row still lines
 * up with the hand-authored table around it. A row already saying the
 * right thing is not rewritten at all -- that is what makes the calling
 * scan idempotent, and silent in the steady state.
 *
 * :param body: roadmap body, frontmatter already stripped
 * :param wanted: phase number -> the Status that row should carry
 * :returns: the new body, and one entry per cell actually changed
 */
export function applyRoadmapRows(body, wanted) {
    const applied = [];
    const lines = body.split("\n");
    for (const row of parseRoadmapRows(body)) {
        const to = wanted.get(row.number);
        if (to === undefined || to === row.status)
            continue;
        const cells = rowCells(lines[row.line]);
        if (!cells)
            continue; // unreachable: parseRoadmapRows read this same line
        const [, lead, , trail] = CELL_RE.exec(cells[2]) ?? ["", " ", "", " "];
        cells[2] = `${lead}${to}${trail}`;
        lines[row.line] = `|${cells.join("|")}|`;
        applied.push({ number: row.number, from: row.status, to });
    }
    return { body: applied.length > 0 ? lines.join("\n") : body, applied };
}
/** The roadmap's phase rows, or none at all when there is no roadmap yet. */
export function readRoadmapRows(projectDir) {
    if (!existsSync(roadmapPath(projectDir)))
        return [];
    return parseRoadmapRows(readRoadmapRaw(projectDir).body);
}
/**
 * Patches Status cells in place and reports what moved. A project with no
 * roadmap.md is not an error here: the scans that call this run on every
 * status check, and a project mid-scaffold has nothing to say.
 *
 * :param projectDir: repository root
 * :param wanted: phase number -> the Status that row should carry
 * :returns: one entry per cell actually changed (empty = nothing to do)
 */
export function patchRoadmapRows(projectDir, wanted) {
    if (!existsSync(roadmapPath(projectDir)))
        return [];
    const { data, body } = readRoadmapRaw(projectDir);
    const { body: next, applied } = applyRoadmapRows(body, wanted);
    if (applied.length > 0)
        writeRoadmap(projectDir, data, next);
    return applied;
}
export async function milestoneComplete(tracker, projectDir, summary) {
    const status = projectStatus(projectDir);
    if (status.phases.length === 0) {
        throw new CairnError("PRECONDITION_FAILED", "no live phases to complete", "scaffold and work phases before summit");
    }
    const unverified = status.phases.filter((p) => !p.hasVerification);
    if (unverified.length > 0) {
        throw new CairnError("PRECONDITION_FAILED", `unverified phases: ${unverified.map((p) => p.dir).join(", ")}`, "run /cairn verify <N> for each before summit");
    }
    const meta = readRoadmapMeta(projectDir);
    // -- tracker steps (collect errors; archive only runs when these fully succeed)
    const closedPhases = [];
    const skippedPhases = [];
    const errors = [];
    const trackerPhases = await tracker.listPhases();
    for (const p of status.phases) {
        const match = trackerPhases.find((tp) => tp.name.startsWith(`Phase ${p.number}:`));
        if (!match) {
            skippedPhases.push({ dir: p.dir, reason: "no tracker phase object" });
            continue;
        }
        if (match.state === "closed") {
            closedPhases.push(match.id);
            continue;
        }
        if (!tracker.capabilities.hasPhaseClose) {
            skippedPhases.push({ dir: p.dir, reason: "backend phase primitive has no closed state" });
            continue;
        }
        try {
            await tracker.closePhase(match.id);
            closedPhases.push(match.id);
        }
        catch (e) {
            errors.push(`closePhase(${match.id}): ${e}`);
        }
    }
    let released;
    if (tracker.capabilities.hasMilestones && meta.milestoneId) {
        try {
            released = await tracker.completeMilestone(meta.milestoneId);
        }
        catch (e) {
            errors.push(`completeMilestone(${meta.milestoneId}): ${e}`);
        }
    }
    if (errors.length > 0) {
        throw new CairnError("TRACKER_DOWN", `milestone_complete tracker steps failed: ${errors.join("; ")}`, "fix and re-run — completed steps are idempotent, nothing was archived");
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
    // The rows this milestone shipped are set by the SAME event that
    // archived their phase dirs -- one read, one write, no convention left
    // to remember (#185). Phases the table never listed stay unlisted:
    // adding rows is route's job, not summit's.
    const shipped = `shipped (v${meta.milestone})`;
    const { body: patchedBody, applied: roadmapRows } = applyRoadmapRows(body, new Map(status.phases.map((p) => [p.number, shipped])));
    data.milestone = String(meta.milestone + 1);
    delete data.milestone_id;
    writeRoadmap(projectDir, data, patchedBody + archiveNote);
    return {
        closedPhases, skippedPhases, released, roadmapRows,
        archivedTo: join(".cairn", "plans", "milestones", `v${meta.milestone}`),
        nextMilestone: meta.milestone + 1,
    };
}
export async function milestoneCreate(tracker, projectDir, name) {
    const meta = readRoadmapMeta(projectDir);
    let native;
    if (tracker.capabilities.hasMilestones) {
        native = await tracker.createMilestone(name);
        patchRoadmapMeta(projectDir, { milestoneId: native.id });
    }
    return { milestone: meta.milestone, native };
}
export async function milestoneList(tracker, projectDir) {
    const meta = readRoadmapMeta(projectDir);
    const msDir = join(plansRoot(projectDir), "milestones");
    const archived = existsSync(msDir)
        ? readdirSync(msDir).filter((d) => /^v\d+$/.test(d))
            .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        : [];
    const out = { current: meta.milestone, archived };
    if (meta.milestoneId)
        out.currentId = meta.milestoneId;
    if (tracker.capabilities.hasMilestones)
        out.native = await tracker.listMilestones();
    return out;
}
