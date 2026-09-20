import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { projectStatus } from "./status.js";
/** Short-SHA form used in the ledger line -- matches `git log --abbrev=7` convention. */
function shortSha(commit) {
    return commit.slice(0, 7);
}
/** Collapses embedded newlines (and the whitespace around them) to a single space, so a
 *  multi-line field (e.g. a pasted commit-message summary) can never break the ledger's
 *  one-line-per-entry invariant. */
function sanitize(field) {
    return field.replace(/\s*\n\s*/g, " ").trim();
}
/** Evidence text additionally loses em dashes — " — " is the ledger line's
 *  field separator, so one inside a command or result would shift every
 *  field after it for the readers (distill-manifest, resync). */
function sanitizeSegment(field) {
    return sanitize(field).replace(/—/g, "-");
}
/**
 * The evidence segment: `evidence <command> => <result> — ` or
 * `waived <reason> — `, placed before `<issueId> closed` exactly like the
 * tdd segment. Refuses neither (PRECONDITION_FAILED — the gate) and both
 * (CONFIG_INVALID — a contradiction).
 */
function evidenceSegment(entry) {
    const has = entry.evidence !== undefined;
    const waived = entry.evidenceWaived !== undefined;
    if (has && waived) {
        throw new CairnError("CONFIG_INVALID", "evidence and evidenceWaived are mutually exclusive", "pass the evidence you have, or a waiver reason — not both");
    }
    if (has) {
        const cmd = sanitizeSegment(entry.evidence.command ?? "");
        const res = sanitizeSegment(entry.evidence.result ?? "");
        if (!cmd || !res) {
            throw new CairnError("PRECONDITION_FAILED", "close evidence needs both a command (what was run) and a result (what it showed)", "e.g. { command: \"npm test\", result: \"1408 passed\" }");
        }
        return `evidence ${cmd} => ${res} — `;
    }
    if (waived) {
        const reason = sanitizeSegment(entry.evidenceWaived);
        if (!reason) {
            throw new CairnError("PRECONDITION_FAILED", "an evidence waiver needs a reason", "say why this close needed no run — \"docs only\", \"plan text only\"");
        }
        return `waived ${reason} — `;
    }
    throw new CairnError("PRECONDITION_FAILED", "close evidence missing: state what was run and what it showed, or waive with a reason", "ledger_append(evidence: { command, result }) from the run that justified the close, "
        + "or evidenceWaived: \"<why no run was needed>\" for docs/planning-only issues");
}
function formatEntry(entry) {
    if ((entry.redCommit === undefined) !== (entry.greenCommit === undefined)) {
        throw new CairnError("CONFIG_INVALID", "redCommit/greenCommit: both or neither", "pass the failing-test commit AND the passing commit, or omit both");
    }
    const tdd = entry.redCommit
        ? `tdd ${shortSha(sanitize(entry.redCommit))}..${shortSha(sanitize(entry.greenCommit))} — `
        : "";
    const evidence = evidenceSegment(entry);
    return `- [x] ${sanitize(entry.taskRef)} — ${sanitize(entry.summary)} — commits `
        + `${shortSha(sanitize(entry.baseCommit))}..${shortSha(sanitize(entry.headCommit))} — `
        + `${tdd}${evidence}${sanitize(entry.issueId)} closed ${sanitize(entry.closedDate)}\n`;
}
/**
 * The `verify:` command a phase's PLAN.md declared for one issue (#206),
 * or null when the plan names none. The declaration may sit anywhere in
 * that task's paragraph; the search stops at the next task bullet.
 */
export function declaredVerifyFor(projectDir, phaseDir, issueId) {
    const planPath = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
    if (!existsSync(planPath))
        return null;
    const lines = readFileSync(planPath, "utf8").split("\n");
    const id = issueId.replace(/^#/, "");
    const start = lines.findIndex((l) => new RegExp(`^-\\s+(?:\\*\\*#?|#)${id.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}[\\s—-]`).test(l));
    if (start === -1)
        return null;
    for (let i = start; i < lines.length; i++) {
        if (i > start && /^(?:-\s+\*\*#|#{1,6}\s)/.test(lines[i]))
            break;
        const m = /`verify:\s*(\S[^`]*)`/i.exec(lines[i]);
        if (m)
            return m[1].trim();
    }
    return null;
}
/**
 * Whether the evidence actually run cites what the plan declared.
 *
 * Deliberately a REPORT, never a refusal. Declared commands are written in
 * shorthand ("npm test") while evidence records what was really typed
 * ("npx vitest run --exclude '**\/*.live.test.ts'"), so a string gate here
 * would fail honest closes constantly and teach people to pad the field.
 * The comparison is loose on purpose — a shared significant token is
 * enough to say "this is the same check" — and the judgement of whether a
 * mismatch matters belongs to verify, where a human reads it.
 */
function citesDeclared(declared, evidenceCommand) {
    const tokens = (t) => new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g)?.filter((w) => !["run", "npm", "npx", "the", "and", "--exclude", "test"].includes(w)) ?? []);
    const d = tokens(declared);
    const e = tokens(evidenceCommand);
    for (const t of d)
        if (e.has(t))
            return true;
    // Nothing distinctive matched. "npm test" against "npx vitest run
    // --exclude ..." is the common honest case: both name the suite, neither
    // shares a distinctive token once the stoplist has done its work. Treat
    // "both are the test suite" as the same check, then fall back to exact
    // equality for anything else.
    const SUITE = /\b(?:test|tests|vitest|jest|mocha|pytest|suite)\b/i;
    if (SUITE.test(declared) && SUITE.test(evidenceCommand))
        return true;
    return declared.trim().toLowerCase() === evidenceCommand.trim().toLowerCase();
}
function ledgerHeader(phase) {
    return `# Phase ${phase.number}: ${phase.name} — Ledger\n\n`
        + `<!-- append-only; one line per verified task; server appends, never rewrites -->\n\n`;
}
/**
 * Appends one formatted line to a phase's LEDGER.md, creating the file (with
 * header) on first append. Never rewrites existing content -- append-only,
 * so the ledger stays a trustworthy record even if a session crashes
 * mid-task. Ledger rides into git with the closing commit; the server just
 * writes the bytes.
 */
export function appendLedger(projectDir, phaseDir, entry) {
    const phase = projectStatus(projectDir).phases.find((p) => p.dir === phaseDir);
    if (!phase) {
        throw new CairnError("NOT_FOUND", `no phase dir '${phaseDir}' found under .cairn/plans/phases`, "run plan_scaffold_phase (or plan_status to list known phases), then retry ledger_append");
    }
    const path = join(plansRoot(projectDir), "phases", phaseDir, "LEDGER.md");
    const line = formatEntry(entry);
    if (existsSync(path)) {
        appendFileSync(path, line);
    }
    else {
        writeFileSync(path, ledgerHeader(phase) + line);
    }
    const declaredVerify = declaredVerifyFor(projectDir, phaseDir, entry.issueId);
    return {
        path, line: line.trimEnd(),
        ...(declaredVerify === null ? {} : {
            declaredVerify,
            evidenceCitesDeclared: entry.evidence
                ? citesDeclared(declaredVerify, entry.evidence.command)
                : false,
        }),
    };
}
