import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CairnError } from "../errors.js";
import { findWorkspace } from "./context.js";
const StatusSchema = z.enum(["queued", "active", "blocked", "done"]);
const boardPath = (root) => join(root, ".cairn", "basecamp", "board.json");
/** Missing file reads as an empty board: `{ workstreams: {} }`. */
function readBoard(root) {
    const path = boardPath(root);
    if (!existsSync(path))
        return { workstreams: {} };
    return JSON.parse(readFileSync(path, "utf8"));
}
function writeBoard(root, board) {
    const path = boardPath(root);
    mkdirSync(join(root, ".cairn", "basecamp"), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`);
    renameSync(tmp, path);
}
const today = () => new Date().toISOString().slice(0, 10);
/** The board is workspace-scoped state -- no workspace, no board. */
function requireWorkspace(launchDir) {
    const info = findWorkspace(launchDir);
    if (!info) {
        throw new CairnError("PRECONDITION_FAILED", `no workspace found from ${launchDir}`, "run basecamp init");
    }
    return info;
}
/**
 * Single-writer merge-patch, config_set-style: workstreams merge by id
 * (patch fields over existing; `null` deletes). `title` + `project` are
 * required on CREATE (optional on update, where they carry over from the
 * existing entry); `status` defaults to "queued" on create. `project` must
 * name a workspace member, `status` must be a known enum value, and both
 * are checked -- along with the required-on-create fields -- before ANY
 * write happens, so a rejected patch leaves the board file untouched.
 * `updated` is always stamped server-side, never taken from the patch.
 */
export function boardUpdate(launchDir, patch) {
    const info = requireWorkspace(launchDir);
    const memberNames = new Set(info.members.map((m) => m.name));
    const current = readBoard(info.root);
    const workstreams = { ...current.workstreams };
    for (const [id, value] of Object.entries(patch)) {
        if (value === null) {
            delete workstreams[id];
            continue;
        }
        const existing = workstreams[id];
        const title = value.title ?? existing?.title;
        const project = value.project ?? existing?.project;
        if (title === undefined || project === undefined) {
            throw new CairnError("UNSUPPORTED", `workstream '${id}' requires 'title' and 'project' on create`, "pass both fields when creating a new workstream");
        }
        if (typeof title === "string" && title.trim() === "") {
            throw new CairnError("UNSUPPORTED", `workstream '${id}' requires a non-empty title`, "give the workstream a real title");
        }
        const status = value.status ?? existing?.status ?? "queued";
        const parsedStatus = StatusSchema.safeParse(status);
        if (!parsedStatus.success) {
            throw new CairnError("UNSUPPORTED", `workstream '${id}' has an invalid status: ${parsedStatus.error.issues.map((i) => i.message).join("; ")}`, `use one of: ${StatusSchema.options.join(", ")}`);
        }
        if (!memberNames.has(project)) {
            throw new CairnError("UNSUPPORTED", `workstream '${id}' has project '${project}' which is not a member of workspace '${info.workspace}'`, `known members: ${info.members.map((m) => m.name).join(", ") || "(none)"}`);
        }
        workstreams[id] = {
            title, project, status: parsedStatus.data,
            issue: value.issue ?? existing?.issue,
            session: value.session ?? existing?.session,
            note: value.note ?? existing?.note,
            updated: today(),
        };
    }
    writeBoard(info.root, { workstreams });
    return { workstreams: Object.keys(workstreams).length };
}
/** Missing board file -> empty board with zeroed counts. Ids sorted, counts derived, deterministic. */
export function boardGet(launchDir) {
    const info = requireWorkspace(launchDir);
    const board = readBoard(info.root);
    const workstreams = {};
    for (const id of Object.keys(board.workstreams).sort())
        workstreams[id] = board.workstreams[id];
    const counts = { queued: 0, active: 0, blocked: 0, done: 0 };
    for (const ws of Object.values(workstreams))
        counts[ws.status]++;
    return { workstreams, counts };
}
