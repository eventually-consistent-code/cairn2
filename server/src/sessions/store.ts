import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";

export type SessionKind = "trace" | "probe" | "draft";
export interface KindSpec {
  kind: SessionKind;
  entryKinds: readonly string[];
  closeGate: string;
}

export const KIND_SPECS: Record<SessionKind, KindSpec> = {
  trace: { kind: "trace", entryKinds: ["evidence", "hypothesis", "test", "verdict"], closeGate: "verdict" },
  probe: { kind: "probe", entryKinds: ["experiment", "result", "requirement", "verdict"], closeGate: "verdict" },
  draft: { kind: "draft", entryKinds: ["variant", "decision", "note"], closeGate: "decision" },
};

export interface SessionInfo {
  kind: SessionKind; id: string; status: "open" | "resolved"; issue: string;
  created: string; resolved?: string; phase?: string;
  entryCounts: Record<string, number>; description: string;
}

const TITLE_RE = /^# (?:Trace|Probe|Draft): (.*)$/m;
const titlePrefix = (kind: SessionKind) =>
  kind === "trace" ? "Trace" : kind === "probe" ? "Probe" : "Draft";
const entryRe = (spec: KindSpec) =>
  new RegExp(`^## (${spec.entryKinds.join("|")}) — `, "gm");

const kindDir = (p: string, kind: SessionKind) => join(p, ".cairn", kind);
const archiveDir = (p: string, kind: SessionKind) => join(kindDir(p, kind), "archive");
const livePath = (p: string, kind: SessionKind, id: string) => join(kindDir(p, kind), `${id}.md`);
const today = () => new Date().toISOString().slice(0, 10);

const listHint: Record<SessionKind, string> = {
  trace: "list open traces with trace_list",
  probe: "list sessions with session_landscape",
  draft: "list sessions with session_landscape",
};

export function sessionId(kind: SessionKind, description: string): string {
  return `${kind}-${createHash("sha256").update(description).digest("hex").slice(0, 8)}`;
}

export function startSession(projectDir: string, kind: SessionKind, description: string,
  issueId: string, phase?: string): { id: string; path: string } {
  const id = sessionId(kind, description);
  const path = livePath(projectDir, kind, id);
  if (existsSync(path)) {
    throw new CairnError("PRECONDITION_FAILED",
      `${kind} '${id}' is already open for this description`,
      `resume it: ${kind}_log / ${kind}_close on ${id}`);
  }
  mkdirSync(kindDir(projectDir, kind), { recursive: true });
  const fm: Record<string, string> = { status: "open", issue: issueId, created: today() };
  if (phase !== undefined && kind !== "trace") fm.phase = phase;
  writeFileSync(path, serializeFrontmatter(fm, `# ${titlePrefix(kind)}: ${description}\n`));
  return { id, path };
}

export function lastSessionEntry(projectDir: string, kind: SessionKind, id: string): string | null {
  const path = livePath(projectDir, kind, id);
  if (!existsSync(path)) return null;
  const matches = [...readFileSync(path, "utf8").matchAll(entryRe(KIND_SPECS[kind]))];
  return matches.length ? matches[matches.length - 1][1] : null;
}

export function appendSession(projectDir: string, kind: SessionKind, id: string,
  entryKind: string, text: string): { path: string } {
  const spec = KIND_SPECS[kind];
  if (!spec.entryKinds.includes(entryKind)) {
    throw new CairnError("UNSUPPORTED", `'${entryKind}' is not a ${kind} entry kind`,
      `use one of: ${spec.entryKinds.join(", ")}`);
  }
  const path = livePath(projectDir, kind, id);
  if (!existsSync(path)) {
    if (existsSync(join(archiveDir(projectDir, kind), `${id}.md`))) {
      throw new CairnError("PRECONDITION_FAILED",
        `${kind} '${id}' is resolved — archived sessions are immutable`,
        `start a new ${kind} session if it's back`);
    }
    throw new CairnError("NOT_FOUND", `no ${kind} '${id}'`, listHint[kind]);
  }
  appendFileSync(path, `\n## ${entryKind} — ${today()}\n${text.trimEnd()}\n`);
  return { path };
}

function parseSession(path: string, kind: SessionKind, id: string): SessionInfo {
  const spec = KIND_SPECS[kind];
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  const entryCounts = Object.fromEntries(spec.entryKinds.map((k) => [k, 0]));
  for (const m of body.matchAll(entryRe(spec))) entryCounts[m[1]]++;
  const info: SessionInfo = {
    kind, id,
    status: data.status === "resolved" ? "resolved" : "open",
    issue: String(data.issue ?? ""), created: String(data.created ?? ""),
    entryCounts, description: TITLE_RE.exec(body)?.[1] ?? "",
  };
  if (typeof data.resolved === "string") info.resolved = data.resolved;
  if (data.phase !== undefined) info.phase = String(data.phase);
  return info;
}

export function listSessions(projectDir: string, kind: SessionKind,
  status?: "open" | "resolved"): SessionInfo[] {
  const out: SessionInfo[] = [];
  const scan = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      try { out.push(parseSession(join(dir, entry), kind, entry.slice(0, -3))); }
      catch { /* malformed session: skip rather than brick the list (C1 precedent) */ }
    }
  };
  if (status !== "resolved") scan(kindDir(projectDir, kind));
  if (status !== "open") scan(archiveDir(projectDir, kind));
  return out
    .filter((s) => (status ? s.status === status : true))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function closeSession(projectDir: string, kind: SessionKind, id: string, resolution: string): {
  id: string; issue: string; description: string; gateTexts: string[]; archivePath: string;
} {
  const spec = KIND_SPECS[kind];
  const path = livePath(projectDir, kind, id);
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND", `no open ${kind} '${id}'`, listHint[kind]);
  }
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  const gateTexts: string[] = [];
  for (const block of body.split(/^## /m).slice(1)) {
    if (block.startsWith(`${spec.closeGate} — `)) {
      const text = block.split("\n").slice(1).join("\n").trim();
      if (text.length > 0) gateTexts.push(text);
    }
  }
  if (gateTexts.length === 0) {
    throw new CairnError("PRECONDITION_FAILED",
      `${kind} '${id}' has no ${spec.closeGate} entry — close needs one`,
      `${kind}_log a ${spec.closeGate}, then close`);
  }
  data.status = "resolved";
  data.resolved = today();
  const archivePath = join(archiveDir(projectDir, kind), `${id}.md`);
  mkdirSync(archiveDir(projectDir, kind), { recursive: true });
  writeFileSync(path, serializeFrontmatter(data,
    `${body.trimEnd()}\n\n## resolution — ${today()}\n${resolution.trimEnd()}\n`));
  renameSync(path, archivePath);
  return { id, issue: String(data.issue ?? ""), description: TITLE_RE.exec(body)?.[1] ?? "", gateTexts, archivePath };
}

export function sessionResolution(projectDir: string, kind: SessionKind, id: string): string | null {
  const path = join(archiveDir(projectDir, kind), `${id}.md`);
  if (!existsSync(path)) return null;
  const { body } = parseFrontmatter(readFileSync(path, "utf8"));
  const m = /^## resolution — .*\n([\s\S]*?)(?=\n## |\n*$)/m.exec(body);
  return m ? m[1].trim() : null;
}
