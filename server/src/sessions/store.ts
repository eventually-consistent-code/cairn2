import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";

export type SessionKind = "trace" | "probe" | "draft" | "thread";
export interface KindSpec {
  kind: SessionKind;
  entryKinds: readonly string[];
  closeGate: string;
  /**
   * Entry kinds that must be present (with at least this many non-empty
   * entries) BEFORE the close gate is even consulted — the method as a
   * data shape (phase 23). Trace: one evidence and one test, the first
   * test being the repro (command + observed failing output); an
   * evidence-free trace cannot close no matter how confident its verdict.
   */
  requiredEntries?: Readonly<Record<string, number>>;
}

export const KIND_SPECS: Record<SessionKind, KindSpec> = {
  trace: {
    kind: "trace", entryKinds: ["evidence", "hypothesis", "test", "verdict"], closeGate: "verdict",
    requiredEntries: { evidence: 1, test: 1 },
  },
  probe: { kind: "probe", entryKinds: ["experiment", "result", "requirement", "verdict"], closeGate: "verdict" },
  draft: { kind: "draft", entryKinds: ["variant", "decision", "note"], closeGate: "decision" },
  thread: { kind: "thread", entryKinds: ["note", "link", "decision", "wrap"], closeGate: "wrap" },
};

export interface SessionInfo {
  kind: SessionKind; id: string; status: "open" | "resolved"; issue: string;
  created: string; resolved?: string; phase?: string;
  entryCounts: Record<string, number>; description: string;
}

const TITLE_RE = /^# (?:Trace|Probe|Draft|Thread): (.*)$/m;
const titlePrefix = (kind: SessionKind) =>
  kind === "trace" ? "Trace" : kind === "probe" ? "Probe" : kind === "draft" ? "Draft" : "Thread";
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
  thread: "list sessions with session_landscape",
};

const requiredHint: Record<SessionKind, string> = {
  trace: "trace_log the evidence you reproduced and a test entry — the first test is the repro: the command you ran and the failing output you saw — then the verdict",
  probe: "log the required entries, then close",
  draft: "log the required entries, then close",
  thread: "log the required entries, then close",
};

const closeHint: Record<SessionKind, string> = {
  trace: "trace_log a verdict (cause + fix + commit), then close",
  probe: "probe_log a verdict (VALIDATED|INVALIDATED|PARTIAL + why), then close",
  draft: "draft_log a decision, then close",
  thread: "thread_log a wrap (where this thread landed), then close",
};

const archiveHint: Record<SessionKind, string> = {
  trace: "start a new trace if the bug is back",
  probe: "start a new probe if the question is back",
  draft: "start a new draft if the design question is back",
  thread: "start a new thread if the topic comes back",
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
        archiveHint[kind]);
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
  /** First non-empty entry per REQUIRED kind (e.g. trace's repro under `test`). */
  firstRequired: Record<string, string>;
} {
  const spec = KIND_SPECS[kind];
  const path = livePath(projectDir, kind, id);
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND", `no open ${kind} '${id}'`, listHint[kind]);
  }
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  // Non-empty entry texts per kind, in file order — the gate and the
  // required-entries check both read from here.
  const texts: Record<string, string[]> = {};
  for (const block of body.split(/^## /m).slice(1)) {
    const sep = block.indexOf(" — ");
    if (sep === -1) continue;
    const entryKind = block.slice(0, sep);
    if (!spec.entryKinds.includes(entryKind)) continue;
    const text = block.split("\n").slice(1).join("\n").trim();
    if (text.length > 0) (texts[entryKind] ??= []).push(text);
  }
  // Required entries first (phase 23): the method is a data shape. A trace
  // with a verdict but no reproduced failure is a hunch with a conclusion.
  const missing: string[] = [];
  const firstRequired: Record<string, string> = {};
  for (const [entryKind, n] of Object.entries(spec.requiredEntries ?? {})) {
    const have = texts[entryKind]?.length ?? 0;
    if (have < n) missing.push(`${entryKind} (${have}/${n})`);
    else firstRequired[entryKind] = texts[entryKind][0];
  }
  if (missing.length > 0) {
    throw new CairnError("PRECONDITION_FAILED",
      `${kind} '${id}' cannot close — missing required entries: ${missing.join(", ")}`,
      requiredHint[kind]);
  }
  const gateTexts = texts[spec.closeGate] ?? [];
  if (gateTexts.length === 0) {
    throw new CairnError("PRECONDITION_FAILED",
      `${kind} '${id}' has no ${spec.closeGate} entry — close needs a ${spec.closeGate}`,
      closeHint[kind]);
  }
  data.status = "resolved";
  data.resolved = today();
  const archivePath = join(archiveDir(projectDir, kind), `${id}.md`);
  mkdirSync(archiveDir(projectDir, kind), { recursive: true });
  writeFileSync(path, serializeFrontmatter(data,
    `${body.trimEnd()}\n\n## resolution — ${today()}\n${resolution.trimEnd()}\n`));
  renameSync(path, archivePath);
  return {
    id, issue: String(data.issue ?? ""), description: TITLE_RE.exec(body)?.[1] ?? "",
    gateTexts, archivePath, firstRequired,
  };
}

export function sessionResolution(projectDir: string, kind: SessionKind, id: string): string | null {
  const path = join(archiveDir(projectDir, kind), `${id}.md`);
  if (!existsSync(path)) return null;
  const { body } = parseFrontmatter(readFileSync(path, "utf8"));
  const m = /^## resolution — .*\n([\s\S]*?)(?=\n## |\n*$)/m.exec(body);
  return m ? m[1].trim() : null;
}

const KIND_ORDER: SessionKind[] = ["trace", "probe", "draft", "thread"];

export interface Landscape {
  sessions: Array<SessionInfo & { resolution?: string }>;
  openByKind: Record<SessionKind, number>;
  phases: Array<{ phase: string; sessions: string[] }>;
}

/**
 * Deterministic cross-kind session join: sorted kind (trace, probe, draft, thread)
 * then id; archived sessions carry their resolution text -- this is the
 * "already probed, verdict was stop" memory frontier mode must never lose.
 */
export function sessionLandscape(projectDir: string): Landscape {
  const sessions: Landscape["sessions"] = [];
  const openByKind = { trace: 0, probe: 0, draft: 0, thread: 0 } as Record<SessionKind, number>;
  for (const kind of KIND_ORDER) {
    for (const s of listSessions(projectDir, kind)) {
      const entry: Landscape["sessions"][number] = { ...s };
      if (s.status === "resolved") {
        const res = sessionResolution(projectDir, kind, s.id);
        if (res !== null) entry.resolution = res;
      } else {
        openByKind[kind]++;
      }
      sessions.push(entry);
    }
  }
  const byPhase = new Map<string, string[]>();
  for (const s of sessions) {
    if (s.phase === undefined) continue;
    byPhase.set(s.phase, [...(byPhase.get(s.phase) ?? []), s.id]);
  }
  const phases = [...byPhase.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([phase, ids]) => ({ phase, sessions: ids }));
  return { sessions, openByKind, phases };
}
