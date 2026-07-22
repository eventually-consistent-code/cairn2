import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";

export type TraceKind = "evidence" | "hypothesis" | "test" | "verdict";
export interface TraceInfo {
  id: string; status: "open" | "resolved"; issue: string;
  created: string; resolved?: string;
  entryCounts: Record<TraceKind, number>;
  description: string;
}

const KINDS: TraceKind[] = ["evidence", "hypothesis", "test", "verdict"];
const ENTRY_RE = /^## (evidence|hypothesis|test|verdict) — /gm;
const TITLE_RE = /^# Trace: (.*)$/m;

const traceDir = (p: string) => join(p, ".cairn", "trace");
const archiveDir = (p: string) => join(traceDir(p), "archive");
const today = () => new Date().toISOString().slice(0, 10);

export function traceId(description: string): string {
  return `trace-${createHash("sha256").update(description).digest("hex").slice(0, 8)}`;
}

export function startTrace(projectDir: string, description: string,
  issueId: string): { id: string; path: string } {
  const id = traceId(description);
  const path = join(traceDir(projectDir), `${id}.md`);
  if (existsSync(path)) {
    throw new CairnError("PRECONDITION_FAILED",
      `trace '${id}' is already open for this description`,
      `resume it: trace_log / trace_close on ${id}`);
  }
  mkdirSync(traceDir(projectDir), { recursive: true });
  writeFileSync(path, serializeFrontmatter(
    { status: "open", issue: issueId, created: today() },
    `# Trace: ${description}\n`));
  return { id, path };
}

function livePath(projectDir: string, id: string): string {
  return join(traceDir(projectDir), `${id}.md`);
}

/** The kind of the final entry block in the trace file (file order), or null if none/missing. */
export function lastEntryKind(projectDir: string, id: string): TraceKind | null {
  const path = livePath(projectDir, id);
  if (!existsSync(path)) return null;
  const matches = [...readFileSync(path, "utf8").matchAll(ENTRY_RE)];
  return matches.length ? (matches[matches.length - 1][1] as TraceKind) : null;
}

export function appendTrace(projectDir: string, id: string, kind: TraceKind,
  text: string): { path: string } {
  const path = livePath(projectDir, id);
  if (!existsSync(path)) {
    if (existsSync(join(archiveDir(projectDir), `${id}.md`))) {
      throw new CairnError("PRECONDITION_FAILED",
        `trace '${id}' is resolved — archived traces are immutable`,
        "start a new trace if the bug is back");
    }
    throw new CairnError("NOT_FOUND", `no trace '${id}'`,
      "list open traces with trace_list");
  }
  appendFileSync(path, `\n## ${kind} — ${today()}\n${text.trimEnd()}\n`);
  return { path };
}

function parseTrace(path: string, id: string): TraceInfo {
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  const entryCounts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<TraceKind, number>;
  for (const m of body.matchAll(ENTRY_RE)) entryCounts[m[1] as TraceKind]++;
  const info: TraceInfo = {
    id,
    status: data.status === "resolved" ? "resolved" : "open",
    issue: String(data.issue ?? ""),
    created: String(data.created ?? ""),
    entryCounts,
    description: TITLE_RE.exec(body)?.[1] ?? "",
  };
  if (typeof data.resolved === "string") info.resolved = data.resolved;
  return info;
}

export function listTraces(projectDir: string,
  status?: "open" | "resolved"): TraceInfo[] {
  const out: TraceInfo[] = [];
  const scan = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      try {
        out.push(parseTrace(join(dir, entry), entry.slice(0, -3)));
      } catch {
        // malformed trace: skip rather than brick the list (cards precedent)
      }
    }
  };
  if (status !== "resolved") scan(traceDir(projectDir));
  if (status !== "open") scan(archiveDir(projectDir));
  return out
    .filter((t) => (status ? t.status === status : true))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function closeTrace(projectDir: string, id: string, resolution: string): {
  id: string; issue: string; description: string; verdicts: string[]; archivePath: string;
} {
  const path = livePath(projectDir, id);
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND", `no open trace '${id}'`,
      "list open traces with trace_list");
  }
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  const verdicts: string[] = [];
  const blocks = body.split(/^## /m).slice(1);
  for (const block of blocks) {
    if (block.startsWith("verdict — ")) {
      const text = block.split("\n").slice(1).join("\n").trim();
      if (text.length > 0) verdicts.push(text);
    }
  }
  if (verdicts.length === 0) {
    throw new CairnError("PRECONDITION_FAILED",
      `trace '${id}' has no verdict entry — close needs a verdict`,
      "trace_log a verdict (cause + fix + commit), then close");
  }
  data.status = "resolved";
  data.resolved = today();
  const archivePath = join(archiveDir(projectDir), `${id}.md`);
  mkdirSync(archiveDir(projectDir), { recursive: true });
  writeFileSync(path, serializeFrontmatter(data,
    `${body.trimEnd()}\n\n## resolution — ${today()}\n${resolution.trimEnd()}\n`));
  renameSync(path, archivePath);
  return {
    id, issue: String(data.issue ?? ""),
    description: TITLE_RE.exec(body)?.[1] ?? "",
    verdicts, archivePath,
  };
}
