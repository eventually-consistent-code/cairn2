/**
 * Purpose: the audit record writer — the single place a review/audit pass
 * lands its findings (.cairn/audit/<scope>-<date>.md). Since phase 21 it
 * is also where a finding is JUDGED: every finding carries a typed
 * failure_scenario, critical/important findings carry a refutation panel
 * whose quorum is computed here (never model-asserted), REFUTED findings
 * stay in the record but never reach the tracker, and survivors credit
 * the raising seats' yield. The record is stamped with the commit it
 * judged. Since #215 a `sweep-<YYYY-MM-DD>` scope is a sweep MANIFEST:
 * it carries the cairn version, a leg index, and a delta against the
 * previous manifest (new / persisting / fixed / regressed) — computed
 * here, in the writer, never by a reader tool. parseAuditRecord reads any
 * record back.
 * Author(s): John Reed
 */
// Imports
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";
import { codeCommitsSince, revisionStamp } from "../planning/resync.js";
import { textsMatch } from "../seats/dedup.js";
import { recordYield } from "../seats/yield.js";
// Constants
const auditDir = (p) => join(p, ".cairn", "audit");
const today = () => new Date().toISOString().slice(0, 10);
const SEVERITIES = ["critical", "important", "minor"];
const VERDICTS = ["CONFIRMED", "PLAUSIBLE", "REFUTED"];
const SECURITY_SCOPE_RE = /^security(-|$)/;
/** A sweep manifest's scope — the only shape that gets the #215 treatment. */
export const SWEEP_SCOPE_RE = /^sweep-(\d{4}-\d{2}-\d{2})$/;
// The runtime cairn version (server/package.json) — the same file index.ts
// reads for the MCP handshake. Resolves from src/audit and dist/audit alike.
const CAIRN_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
/** Panel votes a critical/important finding needs before the record accepts it. */
export function requiredVotes(scope, severity) {
    if (severity === "minor")
        return 0;
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
export function judgePanel(panel) {
    if (!panel || panel.length === 0)
        return "unpanelled";
    const refuted = panel.filter((v) => v.verdict === "REFUTED").length;
    const confirmed = panel.filter((v) => v.verdict === "CONFIRMED").length;
    if (refuted * 2 > panel.length)
        return "refuted";
    if (confirmed > refuted)
        return "confirmed";
    return "plausible";
}
/** All three claims stated true — the only shape that may be applied. */
export function patchClaimsHold(c) {
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
 * :param opts.legs: sweep scopes only — the leg records this manifest indexes
 * :returns: path, counts, per-finding outcomes, stamp (+ delta on a sweep)
 * :raises CairnError: UNSUPPORTED on shape errors; PRECONDITION_FAILED
 *   on verdict mismatch, a missing failure_scenario, or a missing panel
 */
export function writeAuditRecord(projectDir, scope, verdict, findings, opts = {}) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(scope)) {
        throw new CairnError("UNSUPPORTED", `audit scope '${scope}' is empty or not kebab-case`, "use a short kebab-case scope like uat-phase-1");
    }
    if (verdict === "pass" && findings.length > 0) {
        throw new CairnError("PRECONDITION_FAILED", "verdict 'pass' with findings attached — pick one", "verdict must be 'findings' when any finding exists");
    }
    for (const f of findings) {
        if (!SEVERITIES.includes(f.severity) || f.title.trim().length === 0) {
            throw new CairnError("UNSUPPORTED", "finding needs a severity (critical|important|minor) and a title", "");
        }
        // Typed failure_scenario — the structural form of "a finding without a
        // scenario is a hunch". Same PRECONDITION_FAILED shape as the
        // verdict/findings mismatch: the record refuses, the caller decides.
        if (typeof f.failure_scenario !== "string" || f.failure_scenario.trim().length === 0) {
            throw new CairnError("PRECONDITION_FAILED", `finding '${f.title}' has no failure_scenario — a finding without one is a hunch`, "state the concrete inputs/state → wrong output/crash, or downgrade the finding out of the record");
        }
        for (const v of f.panel ?? []) {
            if (!v.seat?.trim() || !VERDICTS.includes(v.verdict) || !v.evidence?.trim()) {
                throw new CairnError("UNSUPPORTED", `finding '${f.title}': every panel vote needs a seat, a verdict (CONFIRMED|PLAUSIBLE|REFUTED), and evidence`, "");
            }
        }
        if (f.patch) {
            const v = f.patch.verifier;
            const c = v?.claims;
            if (!f.patch.path?.trim() || !v?.seat?.trim() || !v.evidence?.trim() || !v.testsRun?.trim()
                || !c || [c.targeted, c.no_new_issue, c.behavior_unchanged].some((b) => typeof b !== "boolean")) {
                throw new CairnError("UNSUPPORTED", `finding '${f.title}': a staged patch needs a path and a verifier with seat, evidence, testsRun, and the three boolean claims (targeted, no_new_issue, behavior_unchanged)`, "");
            }
        }
        // Verify-before-tracker: the panel is not optional where it matters.
        const need = requiredVotes(scope, f.severity);
        const have = f.panel?.length ?? 0;
        if (have < need) {
            throw new CairnError("PRECONDITION_FAILED", `${f.severity} finding '${f.title}' has ${have} panel vote${have === 1 ? "" : "s"}; ` +
                `scope '${scope}' needs ${need} before it can be recorded`, "convene the verifier(s) over the finding first — a finding reaches the tracker only after it survives refutation");
        }
    }
    const sweep = SWEEP_SCOPE_RE.test(scope);
    const legs = opts.legs ?? [];
    if (legs.length > 0 && !sweep) {
        throw new CairnError("UNSUPPORTED", `legs are a sweep manifest's index — scope '${scope}' is not sweep-<YYYY-MM-DD>`, "write the per-mode records first, then one sweep-<date> manifest that lists them as legs");
    }
    for (const l of legs) {
        if (!l.scope?.trim() || !l.path?.trim()) {
            throw new CairnError("UNSUPPORTED", "every leg needs a scope and a record path", "");
        }
    }
    // Judge every finding — in code, once, here.
    const results = findings.map((f) => {
        const outcome = judgePanel(f.panel);
        const survived = outcome !== "refuted";
        const r = { title: f.title, severity: f.severity, outcome, survived };
        // Apply-eligibility is decided here, in code: a refuted finding has no
        // fix to apply, and a verifier who couldn't state all three claims
        // true leaves the patch staged — never applied.
        if (f.patch)
            r.applyEligible = survived && patchClaimsHold(f.patch.verifier.claims);
        return r;
    });
    mkdirSync(auditDir(projectDir), { recursive: true });
    const path = join(auditDir(projectDir), `${scope}-${today()}.md`);
    // Revision stamp (#195): which tree this record judged, captured by the
    // server at write time. Absent outside git — never invented.
    const stamp = revisionStamp(projectDir);
    // Sweep manifest (#215): attribute each finding to the leg that raised
    // it, and diff the survivors against the previous manifest.
    const sourceLeg = sweep ? attributeLegs(projectDir, legs, findings) : [];
    let delta = null;
    if (sweep) {
        const current = [];
        findings.forEach((f, i) => {
            if (!results[i].survived)
                return;
            current.push({ title: f.title, severity: f.severity, failure_scenario: f.failure_scenario.trim(),
                ...(sourceLeg[i] ? { leg: sourceLeg[i] } : {}) });
        });
        delta = sweepDelta(projectDir, scope, path, current);
    }
    const body = [`# Audit: ${scope}`, ""];
    if (sweep) {
        for (const l of legs)
            body.push(`leg: ${l.scope.trim()} => ${l.path.trim()}`);
        if (legs.length > 0)
            body.push("");
        body.push(...renderDelta(delta), "");
    }
    findings.forEach((f, i) => {
        body.push(`## finding — ${f.severity}`, f.title);
        body.push(`scenario: ${f.failure_scenario.trim()}`);
        if (sourceLeg[i])
            body.push(`source leg: ${sourceLeg[i]}`);
        if (f.seats && f.seats.length > 0)
            body.push(`raised by: ${f.seats.join(", ")}`);
        if (f.panel && f.panel.length > 0) {
            body.push(`outcome: ${results[i].outcome}`);
            for (const v of f.panel)
                body.push(`vote: ${v.seat} ${v.verdict} — ${v.evidence.trim()}`);
            if (!results[i].survived)
                body.push("refuted: true — not filed to the tracker");
        }
        if (f.patch) {
            const { seat, claims, evidence, testsRun } = f.patch.verifier;
            body.push(`patch: ${f.patch.path.trim()}`);
            body.push(`patch verifier: ${seat} — targeted=${claims.targeted} no_new_issue=${claims.no_new_issue} ` +
                `behavior_unchanged=${claims.behavior_unchanged}; tests: ${testsRun.trim()}; ${evidence.trim()}`);
            body.push(`apply: ${results[i].applyEligible ? "eligible — on the user's choice" : "blocked — claims not all true"}`);
        }
        if (f.issue)
            body.push(`issue: ${f.issue}`);
        if (f.detail)
            body.push("", f.detail.trimEnd());
        body.push("");
    });
    const frontmatter = { scope, verdict, created: today() };
    if (stamp) {
        frontmatter.commit = stamp.commit;
        frontmatter.dirty = String(stamp.dirty);
    }
    if (sweep)
        frontmatter.cairn = CAIRN_VERSION;
    writeFileSync(path, serializeFrontmatter(frontmatter, `${body.join("\n").trimEnd()}\n`));
    // Yield credit (#196): a raising seat earns findingsSurvived only for a
    // finding that went through a panel and came out alive — "survived"
    // now means survived verification, not survived triage. Advisory:
    // a yield-store problem never fails the record.
    const credit = new Map();
    findings.forEach((f, i) => {
        if (!results[i].survived || results[i].outcome === "unpanelled")
            return;
        for (const seat of f.seats ?? [])
            credit.set(seat, (credit.get(seat) ?? 0) + 1);
    });
    let note;
    if (credit.size > 0) {
        const deltas = [...credit].map(([seat, n]) => ({ seat, findingsSurvived: n }));
        try {
            note = recordYield(projectDir, deltas, opts.yieldBaseDir).note;
        }
        catch (e) {
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
        ...(sweep ? { delta } : {}),
    };
}
export function listAuditRecords(projectDir) {
    const dir = auditDir(projectDir);
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const entry of readdirSync(dir).sort()) {
        if (!entry.endsWith(".md"))
            continue;
        try {
            const { data } = parseFrontmatter(readFileSync(join(dir, entry), "utf8"));
            const rec = { scope: String(data.scope ?? ""),
                date: String(data.created ?? ""), verdict: String(data.verdict ?? ""),
                path: join(dir, entry) };
            if (typeof data.commit === "string" && data.commit) {
                rec.commit = data.commit;
                rec.dirty = data.dirty === "true";
            }
            out.push(rec);
        }
        catch { /* malformed record: skip, list must not brick (cards precedent) */ }
    }
    return out;
}
const FINDING_HEAD_RE = /^## finding — (critical|important|minor)\s*$/;
const DELTA_ITEM_RE = /^- (new|persisting|fixed|regressed) — (critical|important|minor): (.*)$/;
const OUTCOMES = ["confirmed", "plausible", "refuted", "unpanelled"];
/**
 * Reads a record back into frontmatter + findings. Tolerant of every
 * shape the writer has ever produced: a pre-phase-21 block with no
 * scenario is skipped with a note (it was a hunch then, and a delta can't
 * match on it now), never an error.
 *
 * :param path: the record file
 * :returns: frontmatter, findings, leg index, the record's own fixed list, notes
 * :raises CairnError: CONFIG_INVALID only on a broken frontmatter block
 */
export function parseAuditRecord(path) {
    const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const out = { frontmatter: data, findings: [], legs: [], deltaFixed: [], notes: [] };
    let section = "head";
    let cur = null;
    let deltaItem = null;
    const flush = () => {
        if (!cur)
            return;
        const title = cur.title?.trim() ?? "";
        if (!title || !cur.scenario) {
            out.notes.push(`skipped ${cur.severity} finding '${title || "(untitled)"}' — no scenario (pre-phase-21 body)`);
        }
        else {
            out.findings.push({ title, severity: cur.severity, failure_scenario: cur.scenario,
                outcome: cur.refuted ? "refuted" : (cur.outcome ?? "unpanelled"),
                ...(cur.leg ? { leg: cur.leg } : {}) });
        }
        cur = null;
    };
    for (const line of body.split("\n")) {
        const head = FINDING_HEAD_RE.exec(line);
        if (head) {
            flush();
            section = "finding";
            cur = { severity: head[1], keys: true };
            continue;
        }
        if (line.startsWith("## ")) {
            flush();
            section = line.startsWith("## delta") ? "delta" : "other";
            continue;
        }
        // Leg index — the lines between the title and the first section.
        if (section === "head") {
            const m = /^leg: (.+?) => (.+)$/.exec(line);
            if (m)
                out.legs.push({ scope: m[1].trim(), path: m[2].trim() });
            continue;
        }
        // Delta items — only the fixed list matters to the next sweep.
        if (section === "delta") {
            const m = DELTA_ITEM_RE.exec(line);
            if (m) {
                deltaItem = m[1] === "fixed"
                    ? { title: m[3].trim(), severity: m[2], failure_scenario: "" } : null;
                if (deltaItem)
                    out.deltaFixed.push(deltaItem);
                continue;
            }
            const sc = /^ {2}scenario: (.*)$/.exec(line);
            if (sc && deltaItem)
                deltaItem.failure_scenario = sc[1].trim();
            const lg = /^ {2}leg: (.*)$/.exec(line);
            if (lg && deltaItem)
                deltaItem.leg = lg[1].trim();
            continue;
        }
        // Finding key lines run from the title to the first blank line;
        // anything after that is free-text detail and is not parsed.
        if (section !== "finding" || !cur || !cur.keys)
            continue;
        if (line.trim() === "") {
            if (cur.title !== undefined)
                cur.keys = false;
            continue;
        }
        if (cur.title === undefined) {
            cur.title = line;
            continue;
        }
        const kv = /^([a-z ]+): (.*)$/.exec(line);
        if (!kv)
            continue;
        const key = kv[1];
        const val = kv[2].trim();
        if (key === "scenario")
            cur.scenario = val;
        else if (key === "outcome" && OUTCOMES.includes(val))
            cur.outcome = val;
        else if (key === "refuted" && val.startsWith("true"))
            cur.refuted = true;
        else if (key === "source leg")
            cur.leg = val;
    }
    flush();
    return out;
}
// Sweep delta
/**
 * Same finding? Exact title is the fast path; otherwise the dedup
 * engine's scenario-similarity rule (normalized-token Jaccard >= 0.5).
 * No file:line survives into records, so the scenario is the identity.
 *
 * :param a: one finding
 * :param b: the other
 * :returns: true when they describe the same failure
 */
function sameFinding(a, b) {
    if (a.title.trim() === b.title.trim())
        return true;
    return textsMatch(a.failure_scenario, b.failure_scenario);
}
/**
 * One-to-one matching: every current finding claims at most one prior,
 * titles first (so an exact title is never stolen by a fuzzy scenario
 * match), then scenarios.
 *
 * :param current: this sweep's findings
 * :param prior: the baseline's findings
 * :returns: prior index per current index (-1 when unmatched)
 */
function matchFindings(current, prior) {
    const taken = new Set();
    const pair = current.map(() => -1);
    current.forEach((c, i) => {
        const j = prior.findIndex((p, k) => !taken.has(k) && p.title.trim() === c.title.trim());
        if (j >= 0) {
            pair[i] = j;
            taken.add(j);
        }
    });
    current.forEach((c, i) => {
        if (pair[i] >= 0)
            return;
        const j = prior.findIndex((p, k) => !taken.has(k) && sameFinding(p, c));
        if (j >= 0) {
            pair[i] = j;
            taken.add(j);
        }
    });
    return pair;
}
/**
 * The latest prior sweep manifest — sweep-* scope, not the file being
 * written now, dated (by scope) no later than this sweep.
 *
 * :param projectDir: repository root
 * :param scope: this sweep's scope
 * :param path: this sweep's record path (excluded — a same-day rerun overwrites it)
 * :returns: the baseline's path, or null on the first sweep
 */
function previousManifest(projectDir, scope, path) {
    const mine = SWEEP_SCOPE_RE.exec(scope)?.[1] ?? "";
    const prior = listAuditRecords(projectDir)
        .map((r) => ({ r, date: SWEEP_SCOPE_RE.exec(r.scope)?.[1] ?? "" }))
        .filter((x) => x.date !== "" && x.r.path !== path && x.date <= mine)
        .sort((a, b) => a.date.localeCompare(b.date) || a.r.date.localeCompare(b.r.date)
        || a.r.path.localeCompare(b.r.path));
    return prior.at(-1)?.r.path ?? null;
}
/**
 * Classifies this sweep's survivors against the previous manifest:
 * persisting (matched a prior survivor), regressed (unmatched, but the
 * previous manifest's own delta had called it fixed), new (otherwise),
 * fixed (a prior survivor nothing matches now). Null on the first sweep,
 * or when the baseline can't be read.
 *
 * :param projectDir: repository root
 * :param scope: this sweep's scope
 * :param path: this sweep's record path
 * :param current: this sweep's surviving findings
 * :returns: the delta, or null when there is no baseline
 */
function sweepDelta(projectDir, scope, path, current) {
    const basePath = previousManifest(projectDir, scope, path);
    if (!basePath)
        return null;
    let base;
    try {
        base = parseAuditRecord(basePath);
    }
    catch {
        return null;
    }
    const str = (v) => (typeof v === "string" && v ? v : undefined);
    const commit = str(base.frontmatter.commit);
    const cairn = str(base.frontmatter.cairn);
    const created = str(base.frontmatter.created);
    const prior = base.findings
        .filter((f) => f.outcome !== "refuted")
        .map((f) => ({ title: f.title, severity: f.severity, failure_scenario: f.failure_scenario,
        ...(f.leg ? { leg: f.leg } : {}) }));
    const delta = {
        baseline: { path: basePath, ...(commit ? { commit } : {}), ...(cairn ? { cairn } : {}),
            ...(created ? { created } : {}) },
        codeCommitsSince: commit ? codeCommitsSince(projectDir, commit) : null,
        new: [], persisting: [], fixed: [], regressed: [],
    };
    const pair = matchFindings(current, prior);
    const unmatched = [];
    current.forEach((c, i) => { (pair[i] >= 0 ? delta.persisting : unmatched).push(c); });
    const fixedPair = matchFindings(unmatched, base.deltaFixed);
    unmatched.forEach((c, i) => { (fixedPair[i] >= 0 ? delta.regressed : delta.new).push(c); });
    const claimed = new Set(pair.filter((j) => j >= 0));
    prior.forEach((p, j) => { if (!claimed.has(j))
        delta.fixed.push(p); });
    return delta;
}
/**
 * The record's delta section — heading, baseline, counts, then one item
 * per finding with its scenario (and leg) indented below, so the next
 * sweep can read this one's fixed list back.
 *
 * :param delta: the computed delta, or null on the first sweep
 * :returns: body lines
 */
function renderDelta(delta) {
    if (!delta)
        return ["## delta", "first baseline — no earlier sweep manifest to compare against"];
    const b = delta.baseline;
    const name = b.path.split(/[\\/]/).at(-1)?.replace(/\.md$/, "") ?? b.path;
    const out = [`## delta vs ${name}`,
        `baseline: ${b.path}${b.commit ? ` @ ${b.commit.slice(0, 7)}` : ""}` +
            `${b.cairn ? ` (cairn ${b.cairn})` : ""}${b.created ? `, ${b.created}` : ""}`,
        `code commits since: ${delta.codeCommitsSince ?? "unknown"}`,
        `counts: new ${delta.new.length}, persisting ${delta.persisting.length}, ` +
            `fixed ${delta.fixed.length}, regressed ${delta.regressed.length}`];
    for (const cls of ["regressed", "new", "persisting", "fixed"]) {
        for (const f of delta[cls]) {
            out.push(`- ${cls} — ${f.severity}: ${f.title}`, `  scenario: ${f.failure_scenario}`);
            if (f.leg)
                out.push(`  leg: ${f.leg}`);
        }
    }
    return out;
}
/**
 * Which leg raised each finding: read every leg record back and match by
 * the delta's identity rule. A leg whose record can't be read attributes
 * nothing — the manifest still writes.
 *
 * :param projectDir: repository root (relative leg paths resolve here)
 * :param legs: the leg index
 * :param findings: the manifest's findings
 * :returns: leg scope per finding index (undefined when unattributed)
 */
function attributeLegs(projectDir, legs, findings) {
    const legFindings = legs.map((l) => {
        const p = isAbsolute(l.path.trim()) ? l.path.trim() : join(projectDir, l.path.trim());
        try {
            return parseAuditRecord(p).findings;
        }
        catch {
            return [];
        }
    });
    return findings.map((f) => {
        // An exact title in any leg wins over a fuzzy scenario match in an earlier one.
        let k = legFindings.findIndex((fs) => fs.some((x) => x.title.trim() === f.title.trim()));
        if (k < 0)
            k = legFindings.findIndex((fs) => fs.some((x) => sameFinding(x, f)));
        return k >= 0 ? legs[k].scope.trim() : undefined;
    });
}
