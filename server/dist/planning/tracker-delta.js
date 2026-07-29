import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CairnError } from "../errors.js";
export const markerPath = (projectDir) => join(projectDir, ".cairn", "tracker-marker.json");
const bodyHash = (body) => createHash("sha256").update(body).digest("hex").slice(0, 16);
const snap = (i) => ({
    title: i.title, bodyHash: bodyHash(i.body), labels: [...i.labels].sort(),
    assignee: i.assignee, state: i.category, updatedAt: i.updatedAt,
});
const readMarker = (projectDir) => {
    const p = markerPath(projectDir);
    if (!existsSync(p))
        return null;
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    }
    catch (e) {
        throw new CairnError("CONFIG_INVALID", `tracker marker at ${p} is not valid JSON: ${e}`, "delete the marker file to re-initialize");
    }
};
const writeMarker = (projectDir, m) => {
    const p = markerPath(projectDir);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
    renameSync(tmp, p);
};
/** Absorb a cairn-side mutation so it never echoes as an external change.
 *  Silent no-op before the first scan initializes the marker or if marker is corrupt. */
export function snapshotNote(projectDir, issue) {
    let m;
    try {
        m = readMarker(projectDir);
    }
    catch {
        return; // silent no-op on corrupt marker
    }
    if (!m)
        return;
    m.issues[issue.id] = snap(issue);
    writeMarker(projectDir, m);
}
export async function trackerDelta(projectDir, tracker, opts = {}) {
    const [issues, phases] = await Promise.all([
        tracker.listIssues(),
        tracker.capabilities.hasPhases ? tracker.listPhases() : Promise.resolve([]),
    ]);
    const next = {
        lastScan: new Date().toISOString(),
        issues: Object.fromEntries(issues.map((i) => [i.id, snap(i)])),
        phases: Object.fromEntries(phases.map((p) => [p.id, p.name])),
    };
    const prev = readMarker(projectDir);
    if (!prev) {
        writeMarker(projectDir, next);
        return { initialized: true, new: [], newPhases: [], edited: [], stateChanged: [] };
    }
    const added = [];
    const edited = [];
    const stateChanged = [];
    for (const i of issues) {
        const old = prev.issues[i.id];
        if (!old) {
            added.push(i);
            continue;
        }
        if (old.state !== i.state)
            stateChanged.push({ issue: i, from: old.state, to: i.state });
        const changes = [];
        if (old.title !== i.title)
            changes.push({ field: "title", from: old.title, to: i.title });
        if (old.bodyHash !== bodyHash(i.body))
            changes.push({ field: "body" });
        if (JSON.stringify(old.labels) !== JSON.stringify([...i.labels].sort()))
            changes.push({ field: "labels", from: old.labels.join(", "), to: [...i.labels].sort().join(", ") });
        if ((old.assignee ?? "") !== (i.assignee ?? ""))
            changes.push({ field: "assignee", from: old.assignee, to: i.assignee });
        if (changes.length)
            edited.push({ issue: i, changes });
    }
    const newPhases = phases.filter((p) => !(p.id in prev.phases));
    if (opts.ack)
        writeMarker(projectDir, next);
    return { initialized: false, new: added, newPhases, edited, stateChanged };
}
