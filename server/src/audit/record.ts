/**
 * Purpose: the audit record writer — the single place a review/audit pass
 * lands its findings (.cairn/audit/<scope>-<date>.md). Since phase 21 it
 * is also where a finding is JUDGED: every finding carries a typed
 * failure_scenario, critical/important findings carry a refutation panel
 * whose quorum is computed here (never model-asserted), REFUTED findings
 * stay in the record but never reach the tracker, and survivors credit
 * the raising seats' yield. The record is stamped with the commit it
 * judged.
 * Author(s): John Reed
 */

// Imports
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";
import { revisionStamp } from "../planning/resync.js";
import { recordYield, type YieldDelta } from "../seats/yield.js";


// Types

export type AuditSeverity = "critical" | "important" | "minor";

/** One verifier's vote on one finding. */
export type PanelVerdict = "CONFIRMED" | "PLAUSIBLE" | "REFUTED";
export interface PanelVote {
  /** The lens the verifier read with (a roster seat name, or a peer). */
  seat: string;
  verdict: PanelVerdict;
  /** What the verifier actually checked — the evidence behind the vote. */
  evidence: string;
}

/** How the quorum landed for one finding. */
export type FindingOutcome = "confirmed" | "plausible" | "refuted" | "unpanelled";

/** The three claims a staged patch's independent verifier must state (#197). */
export interface PatchClaims {
  /** The patch changes only what the finding names. */
  targeted: boolean;
  /** The patch introduces no new finding of its own. */
  no_new_issue: boolean;
  /** Behavior outside the finding is unchanged (tests say so). */
  behavior_unchanged: boolean;
}

/** A staged fix for one finding — a patch FILE, never a working-tree edit. */
export interface StagedPatch {
  /** Where the patch file lives (under the project's scratch fix dir). */
  path: string;
  verifier: {
    seat: string;
    claims: PatchClaims;
    evidence: string;
    /** What was run to back the claims — suite names + counts, or "none". */
    testsRun: string;
  };
}

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
  /**
   * Refutation panel (#196). Required on critical/important findings —
   * at least one vote, two on a security scope; the quorum below decides
   * whether the finding survives to the tracker. Optional on minors.
   */
  panel?: PanelVote[];
  /** Seats that raised the finding (dedup's credit list) — yield attribution. */
  seats?: string[];
  /** Staged fix (#197) — present only when `--fix` produced a patch. */
  patch?: StagedPatch;
}

export interface FindingResult {
  title: string;
  severity: AuditSeverity;
  outcome: FindingOutcome;
  /** False only when the panel refuted it — the verb must not file it. */
  survived: boolean;
  /**
   * Present when a patch is staged: true only when the finding survived
   * AND the verifier stated all three claims true. The model asserts the
   * evidence; this bit decides whether the verb may offer "apply".
   */
  applyEligible?: boolean;
}

export interface AuditRecordResult {
  path: string;
  /** Total findings written, refuted ones included. */
  findings: number;
  /** Findings that may reach the tracker. */
  survived: number;
  /** Findings the panel killed — in the record, never in the tracker. */
  refuted: number;
  results: FindingResult[];
  commit?: string;
  dirty?: boolean;
  /** Advisory: the yield store couldn't be credited (never fails the write). */
  note?: string;
}


// Constants

const auditDir = (p: string) => join(p, ".cairn", "audit");
const today = () => new Date().toISOString().slice(0, 10);
const SEVERITIES: AuditSeverity[] = ["critical", "important", "minor"];
const VERDICTS: PanelVerdict[] = ["CONFIRMED", "PLAUSIBLE", "REFUTED"];
const SECURITY_SCOPE_RE = /^security(-|$)/;

/** Panel votes a critical/important finding needs before the record accepts it. */
export function requiredVotes(scope: string, severity: AuditSeverity): number {
  if (severity === "minor") return 0;
  return SECURITY_SCOPE_RE.test(scope) ? 2 : 1;
}


// Quorum

/**
 * The quorum rule, computed in code (CONTEXT.md, phase 21): a finding is
 * REFUTED only when REFUTED votes hold a strict majority; CONFIRMED when
 * confirmations outnumber refutations; otherwise PLAUSIBLE (ties, or a
 * panel that could neither prove nor disprove) — plausible survives,
 * marked. No panel at all is "unpanelled" and survives (legal on minors
 * only; the writer refuses it elsewhere).
 *
 * :param panel: the votes, possibly empty/undefined
 * :returns: the outcome
 */
export function judgePanel(panel: PanelVote[] | undefined): FindingOutcome {
  if (!panel || panel.length === 0) return "unpanelled";
  const refuted = panel.filter((v) => v.verdict === "REFUTED").length;
  const confirmed = panel.filter((v) => v.verdict === "CONFIRMED").length;
  if (refuted * 2 > panel.length) return "refuted";
  if (confirmed > refuted) return "confirmed";
  return "plausible";
}


/** All three claims stated true — the only shape that may be applied. */
export function patchClaimsHold(c: PatchClaims): boolean {
  return c.targeted === true && c.no_new_issue === true && c.behavior_unchanged === true;
}


// Writer

/**
 * Validates, judges, and writes the record; credits yield for survivors.
 *
 * :param projectDir: repository root (record path + revision stamp)
 * :param scope: kebab-case mode+target ("security-21", "review-working")
 * :param verdict: "pass" (no findings) or "findings"
 * :param findings: the full finding list, refuted-to-be included
 * :param opts.yieldBaseDir: yield store root override (test seam)
 * :returns: path, counts, per-finding outcomes, stamp
 * :raises CairnError: UNSUPPORTED on shape errors; PRECONDITION_FAILED
 *   on verdict mismatch, a missing failure_scenario, or a missing panel
 */
export function writeAuditRecord(projectDir: string, scope: string,
  verdict: "pass" | "findings", findings: AuditFinding[],
  opts: { yieldBaseDir?: string } = {}): AuditRecordResult {
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
    for (const v of f.panel ?? []) {
      if (!v.seat?.trim() || !VERDICTS.includes(v.verdict) || !v.evidence?.trim()) {
        throw new CairnError("UNSUPPORTED",
          `finding '${f.title}': every panel vote needs a seat, a verdict (CONFIRMED|PLAUSIBLE|REFUTED), and evidence`, "");
      }
    }
    if (f.patch) {
      const v = f.patch.verifier;
      const c = v?.claims;
      if (!f.patch.path?.trim() || !v?.seat?.trim() || !v.evidence?.trim() || !v.testsRun?.trim()
        || !c || [c.targeted, c.no_new_issue, c.behavior_unchanged].some((b) => typeof b !== "boolean")) {
        throw new CairnError("UNSUPPORTED",
          `finding '${f.title}': a staged patch needs a path and a verifier with seat, evidence, testsRun, and the three boolean claims (targeted, no_new_issue, behavior_unchanged)`, "");
      }
    }
    // Verify-before-tracker: the panel is not optional where it matters.
    const need = requiredVotes(scope, f.severity);
    const have = f.panel?.length ?? 0;
    if (have < need) {
      throw new CairnError("PRECONDITION_FAILED",
        `${f.severity} finding '${f.title}' has ${have} panel vote${have === 1 ? "" : "s"}; ` +
        `scope '${scope}' needs ${need} before it can be recorded`,
        "convene the verifier(s) over the finding first — a finding reaches the tracker only after it survives refutation");
    }
  }

  // Judge every finding — in code, once, here.
  const results: FindingResult[] = findings.map((f) => {
    const outcome = judgePanel(f.panel);
    const survived = outcome !== "refuted";
    const r: FindingResult = { title: f.title, severity: f.severity, outcome, survived };
    // Apply-eligibility is decided here, in code: a refuted finding has no
    // fix to apply, and a verifier who couldn't state all three claims
    // true leaves the patch staged — never applied.
    if (f.patch) r.applyEligible = survived && patchClaimsHold(f.patch.verifier.claims);
    return r;
  });

  const body = [`# Audit: ${scope}`, ""];
  findings.forEach((f, i) => {
    body.push(`## finding — ${f.severity}`, f.title);
    body.push(`scenario: ${f.failure_scenario.trim()}`);
    if (f.seats && f.seats.length > 0) body.push(`raised by: ${f.seats.join(", ")}`);
    if (f.panel && f.panel.length > 0) {
      body.push(`outcome: ${results[i].outcome}`);
      for (const v of f.panel) body.push(`vote: ${v.seat} ${v.verdict} — ${v.evidence.trim()}`);
      if (!results[i].survived) body.push("refuted: true — not filed to the tracker");
    }
    if (f.patch) {
      const { seat, claims, evidence, testsRun } = f.patch.verifier;
      body.push(`patch: ${f.patch.path.trim()}`);
      body.push(`patch verifier: ${seat} — targeted=${claims.targeted} no_new_issue=${claims.no_new_issue} ` +
        `behavior_unchanged=${claims.behavior_unchanged}; tests: ${testsRun.trim()}; ${evidence.trim()}`);
      body.push(`apply: ${results[i].applyEligible ? "eligible — on the user's choice" : "blocked — claims not all true"}`);
    }
    if (f.issue) body.push(`issue: ${f.issue}`);
    if (f.detail) body.push("", f.detail.trimEnd());
    body.push("");
  });

  mkdirSync(auditDir(projectDir), { recursive: true });
  const path = join(auditDir(projectDir), `${scope}-${today()}.md`);
  // Revision stamp (#195): which tree this record judged, captured by the
  // server at write time. Absent outside git — never invented.
  const stamp = revisionStamp(projectDir);
  const frontmatter: Record<string, string> = { scope, verdict, created: today() };
  if (stamp) { frontmatter.commit = stamp.commit; frontmatter.dirty = String(stamp.dirty); }
  writeFileSync(path, serializeFrontmatter(frontmatter, `${body.join("\n").trimEnd()}\n`));

  // Yield credit (#196): a raising seat earns findingsSurvived only for a
  // finding that went through a panel and came out alive — "survived"
  // now means survived verification, not survived triage. Advisory:
  // a yield-store problem never fails the record.
  const credit = new Map<string, number>();
  findings.forEach((f, i) => {
    if (!results[i].survived || results[i].outcome === "unpanelled") return;
    for (const seat of f.seats ?? []) credit.set(seat, (credit.get(seat) ?? 0) + 1);
  });
  let note: string | undefined;
  if (credit.size > 0) {
    const deltas: YieldDelta[] = [...credit].map(([seat, n]) => ({ seat, findingsSurvived: n }));
    try {
      note = recordYield(projectDir, deltas, opts.yieldBaseDir).note;
    } catch (e) {
      note = `yield store not credited: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    path,
    findings: findings.length,
    survived: results.filter((r) => r.survived).length,
    refuted: results.filter((r) => !r.survived).length,
    results,
    ...(stamp ? { commit: stamp.commit, dirty: stamp.dirty } : {}),
    ...(note ? { note } : {}),
  };
}


// Listing

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
