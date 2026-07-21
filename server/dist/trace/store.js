import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";
const KINDS = ["evidence", "hypothesis", "test", "verdict"];
const ENTRY_RE = /^## (evidence|hypothesis|test|verdict) — /gm;
const TITLE_RE = /^# Trace: (.*)$/m;
const traceDir = (p) => join(p, ".cairn", "trace");
const archiveDir = (p) => join(traceDir(p), "archive");
const today = () => new Date().toISOString().slice(0, 10);
export function traceId(description) {
    return `trace-${createHash("sha256").update(description).digest("hex").slice(0, 8)}`;
}
export function startTrace(projectDir, description, issueId) {
    const id = traceId(description);
    const path = join(traceDir(projectDir), `${id}.md`);
    if (existsSync(path)) {
        throw new CairnError("PRECONDITION_FAILED", `trace '${id}' is already open for this description`, `resume it: trace_log / trace_close on ${id}`);
    }
    mkdirSync(traceDir(projectDir), { recursive: true });
    writeFileSync(path, serializeFrontmatter({ status: "open", issue: issueId, created: today() }, `# Trace: ${description}\n`));
    return { id, path };
}
function livePath(projectDir, id) {
    return join(traceDir(projectDir), `${id}.md`);
}
/** The kind of the final entry block in the trace file (file order), or null if none/missing. */
export function lastEntryKind(projectDir, id) {
    const path = livePath(projectDir, id);
    if (!existsSync(path))
        return null;
    const matches = [...readFileSync(path, "utf8").matchAll(ENTRY_RE)];
    return matches.length ? matches[matches.length - 1][1] : null;
}
export function appendTrace(projectDir, id, kind, text) {
    const path = livePath(projectDir, id);
    if (!existsSync(path)) {
        if (existsSync(join(archiveDir(projectDir), `${id}.md`))) {
            throw new CairnError("PRECONDITION_FAILED", `trace '${id}' is resolved — archived traces are immutable`, "start a new trace if the bug is back");
        }
        throw new CairnError("NOT_FOUND", `no trace '${id}'`, "list open traces with trace_list");
    }
    appendFileSync(path, `\n## ${kind} — ${today()}\n${text.trimEnd()}\n`);
    return { path };
}
function parseTrace(path, id) {
    const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const entryCounts = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const m of body.matchAll(ENTRY_RE))
        entryCounts[m[1]]++;
    const info = {
        id,
        status: data.status === "resolved" ? "resolved" : "open",
        issue: String(data.issue ?? ""),
        created: String(data.created ?? ""),
        entryCounts,
        description: TITLE_RE.exec(body)?.[1] ?? "",
    };
    if (typeof data.resolved === "string")
        info.resolved = data.resolved;
    return info;
}
export function listTraces(projectDir, status) {
    const out = [];
    const scan = (dir) => {
        if (!existsSync(dir))
            return;
        for (const entry of readdirSync(dir)) {
            if (!entry.endsWith(".md"))
                continue;
            try {
                out.push(parseTrace(join(dir, entry), entry.slice(0, -3)));
            }
            catch {
                // malformed trace: skip rather than brick the list (cards precedent)
            }
        }
    };
    if (status !== "resolved")
        scan(traceDir(projectDir));
    if (status !== "open")
        scan(archiveDir(projectDir));
    return out
        .filter((t) => (status ? t.status === status : true))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function closeTrace(projectDir, id, resolution) {
    const path = livePath(projectDir, id);
    if (!existsSync(path)) {
        throw new CairnError("NOT_FOUND", `no open trace '${id}'`, "list open traces with trace_list");
    }
    const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const verdicts = [];
    const blocks = body.split(/^## /m).slice(1);
    for (const block of blocks) {
        if (block.startsWith("verdict — ")) {
            verdicts.push(block.split("\n").slice(1).join("\n").trim());
        }
    }
    if (verdicts.length === 0) {
        throw new CairnError("PRECONDITION_FAILED", `trace '${id}' has no verdict entry — close needs a verdict`, "trace_log a verdict (cause + fix + commit), then close");
    }
    data.status = "resolved";
    data.resolved = today();
    const archivePath = join(archiveDir(projectDir), `${id}.md`);
    mkdirSync(archiveDir(projectDir), { recursive: true });
    writeFileSync(path, serializeFrontmatter(data, `${body.trimEnd()}\n\n## resolution — ${today()}\n${resolution.trimEnd()}\n`));
    renameSync(path, archivePath);
    return {
        id, issue: String(data.issue ?? ""),
        description: TITLE_RE.exec(body)?.[1] ?? "",
        verdicts, archivePath,
    };
}
