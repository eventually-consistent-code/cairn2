import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";
import { revisionStamp } from "../planning/resync.js";

export type AuditSeverity = "critical" | "important" | "minor";
export interface AuditFinding {
  severity: AuditSeverity;
  title: string;
  /**
   * The concrete failure — "inputs/state → wrong output/crash". Required
   * since phase 21: a finding without one is a hunch, and the prose bar
   * ("name the scenario or cut it") is now enforced here, not asked for.
   */
  failure_scenario: string;
  detail?: string;
  issue?: string;
}

const auditDir = (p: string) => join(p, ".cairn", "audit");
const today = () => new Date().toISOString().slice(0, 10);
const SEVERITIES: AuditSeverity[] = ["critical", "important", "minor"];

export function writeAuditRecord(projectDir: string, scope: string,
  verdict: "pass" | "findings", findings: AuditFinding[]): { path: string; findings: number } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scope)) {
    throw new CairnError("UNSUPPORTED", `audit scope '${scope}' is empty or not kebab-case`,
      "use a short kebab-case scope like uat-phase-1");
  }
  if (verdict === "pass" && findings.length > 0) {
    throw new CairnError("PRECONDITION_FAILED",
      "verdict 'pass' with findings attached — pick one",
      "verdict must be 'findings' when any finding exists");
  }
  for (const f of findings) {
    if (!SEVERITIES.includes(f.severity) || f.title.trim().length === 0) {
      throw new CairnError("UNSUPPORTED", "finding needs a severity (critical|important|minor) and a title", "");
    }
    // Typed failure_scenario — the structural form of "a finding without a
    // scenario is a hunch". Same PRECONDITION_FAILED shape as the
    // verdict/findings mismatch: the record refuses, the caller decides.
    if (typeof f.failure_scenario !== "string" || f.failure_scenario.trim().length === 0) {
      throw new CairnError("PRECONDITION_FAILED",
        `finding '${f.title}' has no failure_scenario — a finding without one is a hunch`,
        "state the concrete inputs/state → wrong output/crash, or downgrade the finding out of the record");
    }
  }
  const body = [`# Audit: ${scope}`, ""];
  for (const f of findings) {
    body.push(`## finding — ${f.severity}`, f.title);
    body.push(`scenario: ${f.failure_scenario.trim()}`);
    if (f.issue) body.push(`issue: ${f.issue}`);
    if (f.detail) body.push("", f.detail.trimEnd());
    body.push("");
  }
  mkdirSync(auditDir(projectDir), { recursive: true });
  const path = join(auditDir(projectDir), `${scope}-${today()}.md`);
  // Revision stamp (#195): which tree this record judged, captured by the
  // server at write time. Absent outside git — never invented.
  const stamp = revisionStamp(projectDir);
  const frontmatter: Record<string, string> = { scope, verdict, created: today() };
  if (stamp) { frontmatter.commit = stamp.commit; frontmatter.dirty = String(stamp.dirty); }
  writeFileSync(path, serializeFrontmatter(frontmatter, `${body.join("\n").trimEnd()}\n`));
  return { path, findings: findings.length, ...(stamp ? { commit: stamp.commit, dirty: stamp.dirty } : {}) };
}

export interface AuditRecordSummary {
  scope: string; date: string; verdict: string; path: string;
  /** Revision stamp — undefined on records written before phase 21 or outside git. */
  commit?: string; dirty?: boolean;
}

export function listAuditRecords(projectDir: string): AuditRecordSummary[] {
  const dir = auditDir(projectDir);
  if (!existsSync(dir)) return [];
  const out: AuditRecordSummary[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    try {
      const { data } = parseFrontmatter(readFileSync(join(dir, entry), "utf8"));
      const rec: AuditRecordSummary = { scope: String(data.scope ?? ""),
        date: String(data.created ?? ""), verdict: String(data.verdict ?? ""),
        path: join(dir, entry) };
      if (typeof data.commit === "string" && data.commit) {
        rec.commit = data.commit;
        rec.dirty = data.dirty === "true";
      }
      out.push(rec);
    } catch { /* malformed record: skip, list must not brick (cards precedent) */ }
  }
  return out;
}
