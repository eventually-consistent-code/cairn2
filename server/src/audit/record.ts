import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";

export type AuditSeverity = "critical" | "important" | "minor";
export interface AuditFinding { severity: AuditSeverity; title: string; detail?: string; issue?: string; }

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
  }
  const body = [`# Audit: ${scope}`, ""];
  for (const f of findings) {
    body.push(`## finding — ${f.severity}`, f.title);
    if (f.issue) body.push(`issue: ${f.issue}`);
    if (f.detail) body.push("", f.detail.trimEnd());
    body.push("");
  }
  mkdirSync(auditDir(projectDir), { recursive: true });
  const path = join(auditDir(projectDir), `${scope}-${today()}.md`);
  writeFileSync(path, serializeFrontmatter(
    { scope, verdict, created: today() }, `${body.join("\n").trimEnd()}\n`));
  return { path, findings: findings.length };
}

export function listAuditRecords(projectDir: string):
  Array<{ scope: string; date: string; verdict: string; path: string }> {
  const dir = auditDir(projectDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    try {
      const { data } = parseFrontmatter(readFileSync(join(dir, entry), "utf8"));
      out.push({ scope: String(data.scope ?? ""), date: String(data.created ?? ""),
        verdict: String(data.verdict ?? ""), path: join(dir, entry) });
    } catch { /* malformed record: skip, list must not brick (cards precedent) */ }
  }
  return out;
}
