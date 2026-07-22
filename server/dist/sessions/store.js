import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";
export const KIND_SPECS = {
    trace: { kind: "trace", entryKinds: ["evidence", "hypothesis", "test", "verdict"], closeGate: "verdict" },
    probe: { kind: "probe", entryKinds: ["experiment", "result", "requirement", "verdict"], closeGate: "verdict" },
    draft: { kind: "draft", entryKinds: ["variant", "decision", "note"], closeGate: "decision" },
    thread: { kind: "thread", entryKinds: ["note", "link", "decision", "wrap"], closeGate: "wrap" },
};
const TITLE_RE = /^# (?:Trace|Probe|Draft|Thread): (.*)$/m;
const titlePrefix = (kind) => kind === "trace" ? "Trace" : kind === "probe" ? "Probe" : kind === "draft" ? "Draft" : "Thread";
const entryRe = (spec) => new RegExp(`^## (${spec.entryKinds.join("|")}) — `, "gm");
const kindDir = (p, kind) => join(p, ".cairn", kind);
const archiveDir = (p, kind) => join(kindDir(p, kind), "archive");
const livePath = (p, kind, id) => join(kindDir(p, kind), `${id}.md`);
const today = () => new Date().toISOString().slice(0, 10);
const listHint = {
    trace: "list open traces with trace_list",
    probe: "list sessions with session_landscape",
    draft: "list sessions with session_landscape",
    thread: "list sessions with session_landscape",
};
const closeHint = {
    trace: "trace_log a verdict (cause + fix + commit), then close",
    probe: "probe_log a verdict (VALIDATED|INVALIDATED|PARTIAL + why), then close",
    draft: "draft_log a decision, then close",
    thread: "thread_log a wrap (where this thread landed), then close",
};
const archiveHint = {
    trace: "start a new trace if the bug is back",
    probe: "start a new probe if the question is back",
    draft: "start a new draft if the design question is back",
    thread: "start a new thread if the topic comes back",
};
export function sessionId(kind, description) {
    return `${kind}-${createHash("sha256").update(description).digest("hex").slice(0, 8)}`;
}
export function startSession(projectDir, kind, description, issueId, phase) {
    const id = sessionId(kind, description);
    const path = livePath(projectDir, kind, id);
    if (existsSync(path)) {
        throw new CairnError("PRECONDITION_FAILED", `${kind} '${id}' is already open for this description`, `resume it: ${kind}_log / ${kind}_close on ${id}`);
    }
    mkdirSync(kindDir(projectDir, kind), { recursive: true });
    const fm = { status: "open", issue: issueId, created: today() };
    if (phase !== undefined && kind !== "trace")
        fm.phase = phase;
    writeFileSync(path, serializeFrontmatter(fm, `# ${titlePrefix(kind)}: ${description}\n`));
    return { id, path };
}
export function lastSessionEntry(projectDir, kind, id) {
    const path = livePath(projectDir, kind, id);
    if (!existsSync(path))
        return null;
    const matches = [...readFileSync(path, "utf8").matchAll(entryRe(KIND_SPECS[kind]))];
    return matches.length ? matches[matches.length - 1][1] : null;
}
export function appendSession(projectDir, kind, id, entryKind, text) {
    const spec = KIND_SPECS[kind];
    if (!spec.entryKinds.includes(entryKind)) {
        throw new CairnError("UNSUPPORTED", `'${entryKind}' is not a ${kind} entry kind`, `use one of: ${spec.entryKinds.join(", ")}`);
    }
    const path = livePath(projectDir, kind, id);
    if (!existsSync(path)) {
        if (existsSync(join(archiveDir(projectDir, kind), `${id}.md`))) {
            throw new CairnError("PRECONDITION_FAILED", `${kind} '${id}' is resolved — archived sessions are immutable`, archiveHint[kind]);
        }
        throw new CairnError("NOT_FOUND", `no ${kind} '${id}'`, listHint[kind]);
    }
    appendFileSync(path, `\n## ${entryKind} — ${today()}\n${text.trimEnd()}\n`);
    return { path };
}
function parseSession(path, kind, id) {
    const spec = KIND_SPECS[kind];
    const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const entryCounts = Object.fromEntries(spec.entryKinds.map((k) => [k, 0]));
    for (const m of body.matchAll(entryRe(spec)))
        entryCounts[m[1]]++;
    const info = {
        kind, id,
        status: data.status === "resolved" ? "resolved" : "open",
        issue: String(data.issue ?? ""), created: String(data.created ?? ""),
        entryCounts, description: TITLE_RE.exec(body)?.[1] ?? "",
    };
    if (typeof data.resolved === "string")
        info.resolved = data.resolved;
    if (data.phase !== undefined)
        info.phase = String(data.phase);
    return info;
}
export function listSessions(projectDir, kind, status) {
    const out = [];
    const scan = (dir) => {
        if (!existsSync(dir))
            return;
        for (const entry of readdirSync(dir)) {
            if (!entry.endsWith(".md"))
                continue;
            try {
                out.push(parseSession(join(dir, entry), kind, entry.slice(0, -3)));
            }
            catch { /* malformed session: skip rather than brick the list (C1 precedent) */ }
        }
    };
    if (status !== "resolved")
        scan(kindDir(projectDir, kind));
    if (status !== "open")
        scan(archiveDir(projectDir, kind));
    return out
        .filter((s) => (status ? s.status === status : true))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function closeSession(projectDir, kind, id, resolution) {
    const spec = KIND_SPECS[kind];
    const path = livePath(projectDir, kind, id);
    if (!existsSync(path)) {
        throw new CairnError("NOT_FOUND", `no open ${kind} '${id}'`, listHint[kind]);
    }
    const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const gateTexts = [];
    for (const block of body.split(/^## /m).slice(1)) {
        if (block.startsWith(`${spec.closeGate} — `)) {
            const text = block.split("\n").slice(1).join("\n").trim();
            if (text.length > 0)
                gateTexts.push(text);
        }
    }
    if (gateTexts.length === 0) {
        throw new CairnError("PRECONDITION_FAILED", `${kind} '${id}' has no ${spec.closeGate} entry — close needs a ${spec.closeGate}`, closeHint[kind]);
    }
    data.status = "resolved";
    data.resolved = today();
    const archivePath = join(archiveDir(projectDir, kind), `${id}.md`);
    mkdirSync(archiveDir(projectDir, kind), { recursive: true });
    writeFileSync(path, serializeFrontmatter(data, `${body.trimEnd()}\n\n## resolution — ${today()}\n${resolution.trimEnd()}\n`));
    renameSync(path, archivePath);
    return { id, issue: String(data.issue ?? ""), description: TITLE_RE.exec(body)?.[1] ?? "", gateTexts, archivePath };
}
export function sessionResolution(projectDir, kind, id) {
    const path = join(archiveDir(projectDir, kind), `${id}.md`);
    if (!existsSync(path))
        return null;
    const { body } = parseFrontmatter(readFileSync(path, "utf8"));
    const m = /^## resolution — .*\n([\s\S]*?)(?=\n## |\n*$)/m.exec(body);
    return m ? m[1].trim() : null;
}
const KIND_ORDER = ["trace", "probe", "draft", "thread"];
/**
 * Deterministic cross-kind session join: sorted kind (trace, probe, draft, thread)
 * then id; archived sessions carry their resolution text -- this is the
 * "already probed, verdict was stop" memory frontier mode must never lose.
 */
export function sessionLandscape(projectDir) {
    const sessions = [];
    const openByKind = { trace: 0, probe: 0, draft: 0, thread: 0 };
    for (const kind of KIND_ORDER) {
        for (const s of listSessions(projectDir, kind)) {
            const entry = { ...s };
            if (s.status === "resolved") {
                const res = sessionResolution(projectDir, kind, s.id);
                if (res !== null)
                    entry.resolution = res;
            }
            else {
                openByKind[kind]++;
            }
            sessions.push(entry);
        }
    }
    const byPhase = new Map();
    for (const s of sessions) {
        if (s.phase === undefined)
            continue;
        byPhase.set(s.phase, [...(byPhase.get(s.phase) ?? []), s.id]);
    }
    const phases = [...byPhase.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([phase, ids]) => ({ phase, sessions: ids }));
    return { sessions, openByKind, phases };
}
