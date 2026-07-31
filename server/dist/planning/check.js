import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { phaseDirPrefix, plansRoot } from "./artifacts.js";
// Path-like token — used both to spot a shared fixture between plans and to
// anchor a threshold to something concrete (a benchmark file, a spec doc).
const PATHLIKE = /\S+\.(?:md|json|ts|js|mjs|csv|txt)/;
const ANCHOR_WORDS = /\b(?:benchmark|fixture|measured|per spec|spec §|source:)\b/i;
const THRESHOLD_SRC = "(?:<=|>=|<|>|≤|≥|under|over|at least|at most|within)"
    + "\\s*\\d+(?:\\.\\d+)?\\s*(?:ms|s|%|rps|qps|kb|mb|gb|tok|tokens|rows|items)\\b";
const THRESHOLD = new RegExp(THRESHOLD_SRC, "gi");
const THRESHOLD_TEST = new RegExp(THRESHOLD_SRC, "i"); // stateless existence check
const CONTRACT = /^(\s*)- (Produces|Consumes): (.*)$/;
const FENCE = /^\s*```/;
const SYMBOL = /`([A-Za-z_$][\w$]*)`|([A-Za-z_$][\w$]*)\(/g;
const leadingSpaces = (line) => /^(\s*)/.exec(line)[1].length;
// Every `identifier` and every identifier( token, deduped.
function extractSymbols(text) {
    const symbols = new Set();
    for (const m of text.matchAll(SYMBOL))
        symbols.add(m[1] ?? m[2]);
    return symbols;
}
// Walk a PLAN.md's lines and pull out every Produces/Consumes contract,
// including its continuation lines (more-indented, or inside a code fence
// opened on/after the contract line).
function extractContracts(lines, planRel) {
    const contracts = [];
    let i = 0;
    while (i < lines.length) {
        const m = CONTRACT.exec(lines[i]);
        if (!m) {
            i++;
            continue;
        }
        const indent = m[1].length;
        const kind = m[2];
        const startLine = i;
        const parts = [m[3]];
        // A fence can open ON the contract line itself (e.g. a "- Produces:"
        // bullet ending with ```) — an odd count of ``` markers on this line
        // means the fence is still open, so continuation lines start in-fence
        // exactly as if the fence had opened on a later line.
        let inFence = (lines[i].match(/```/g) ?? []).length % 2 === 1;
        let j = i + 1;
        while (j < lines.length) {
            const next = lines[j];
            if (inFence) {
                parts.push(next);
                j++;
                if (FENCE.test(next))
                    inFence = false;
                continue;
            }
            if (next.trim() === "") {
                // Blank line ends the contract unless the next non-blank line is
                // still more-indented (blank-line + outdent ends it).
                let k = j + 1;
                while (k < lines.length && lines[k].trim() === "")
                    k++;
                if (k >= lines.length || leadingSpaces(lines[k]) <= indent)
                    break;
                j++;
                continue;
            }
            const nextIndent = leadingSpaces(next);
            if (nextIndent > indent) {
                parts.push(next);
                if (FENCE.test(next))
                    inFence = true;
                j++;
                continue;
            }
            break; // outdent (or a sibling `- ` bullet at the same indent) ends it
        }
        contracts.push({
            kind, plan: planRel, line: startLine + 1,
            text: parts.join("\n"), symbols: extractSymbols(parts.join("\n")),
        });
        i = j;
    }
    return contracts;
}
const normalize = (text) => text.replace(/\s+/g, " ").trim();
// A threshold is anchored when the same line, or the line directly above or
// below it, names a path-like fixture or one of the anchor words. A
// neighboring line only lends its anchor if it isn't itself a separate,
// self-contained threshold statement — otherwise two independent
// requirements sitting on adjacent lines would anchor each other by accident.
function isAnchored(lines, idx, hasThreshold) {
    if (PATHLIKE.test(lines[idx]) || ANCHOR_WORDS.test(lines[idx]))
        return true;
    for (const i of [idx - 1, idx + 1]) {
        if (i < 0 || i >= lines.length || hasThreshold[i])
            continue;
        if (PATHLIKE.test(lines[i]) || ANCHOR_WORDS.test(lines[i]))
            return true;
    }
    return false;
}
function scanThresholds(lines, planRel) {
    const findings = [];
    const hasThreshold = lines.map((line) => THRESHOLD_TEST.test(line));
    lines.forEach((line, idx) => {
        for (const m of line.matchAll(THRESHOLD)) {
            if (!isAnchored(lines, idx, hasThreshold)) {
                findings.push({ type: "unanchored-threshold", plan: planRel, line: idx + 1, detail: m[0] });
            }
        }
    });
    return findings;
}
export function planCheck(projectDir, phase) {
    const phasesDir = join(plansRoot(projectDir), "phases");
    if (!existsSync(phasesDir))
        return { findings: [], scanned: 0 };
    // Reuse phaseDirName's own pad-and-append scheme instead of re-deriving it
    // here -- the old String(phase).padStart(2,"0") built "1.5-", which never
    // matches the real "01.5-slug" directory a decimal phase actually scaffolds
    // to (CRN-40). phaseDirPrefix throws CONFIG_INVALID for an invalid phase
    // (e.g. 1.55), same as every other phase-consuming call in this codebase.
    const prefix = phase !== undefined ? phaseDirPrefix(phase) : null;
    const plans = [];
    for (const entry of readdirSync(phasesDir)) {
        if (prefix && !entry.startsWith(prefix))
            continue;
        const path = join(phasesDir, entry, "PLAN.md");
        if (!existsSync(path))
            continue;
        const text = readFileSync(path, "utf8");
        const rel = relative(projectDir, path);
        const lines = text.split("\n");
        plans.push({ rel, lines, text, contracts: extractContracts(lines, rel) });
    }
    const findings = [];
    // Thresholds — independent per plan.
    for (const p of plans)
        findings.push(...scanThresholds(p.lines, p.rel));
    // Contract drift — pair every Produces against every Consumes in a
    // different plan that shares a symbol, flag on the consumer's line.
    const seen = new Set();
    for (const producerPlan of plans) {
        for (const producer of producerPlan.contracts) {
            if (producer.kind !== "Produces")
                continue;
            for (const consumerPlan of plans) {
                if (consumerPlan.rel === producerPlan.rel)
                    continue;
                for (const consumer of consumerPlan.contracts) {
                    if (consumer.kind !== "Consumes")
                        continue;
                    const sharedSymbol = [...producer.symbols].find((s) => consumer.symbols.has(s));
                    if (!sharedSymbol)
                        continue;
                    const key = `${producer.plan}:${producer.line}>${consumer.plan}:${consumer.line}`;
                    if (seen.has(key))
                        continue;
                    if (normalize(producer.text) === normalize(consumer.text))
                        continue;
                    const producerFixtures = producerPlan.text.match(new RegExp(PATHLIKE, "g")) ?? [];
                    const consumerFixtures = consumerPlan.text.match(new RegExp(PATHLIKE, "g")) ?? [];
                    if (producerFixtures.some((f) => consumerFixtures.includes(f)))
                        continue;
                    seen.add(key);
                    findings.push({
                        type: "contract-drift", plan: consumer.plan, line: consumer.line,
                        detail: `consumed contract for \`${sharedSymbol}\` differs from producer in ${producer.plan}:${producer.line}`,
                        counterpart: { plan: producer.plan, line: producer.line },
                    });
                }
            }
        }
    }
    // Fully explicit tie-break — byte-equal output is a binding constraint, so
    // sort order must never fall back on readdir/filesystem enumeration order.
    const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
    findings.sort((a, b) => cmp(a.plan, b.plan) || (a.line - b.line) || cmp(a.type, b.type)
        || cmp(a.counterpart?.plan ?? "", b.counterpart?.plan ?? "")
        || ((a.counterpart?.line ?? 0) - (b.counterpart?.line ?? 0))
        || cmp(a.detail, b.detail));
    return { findings, scanned: plans.length };
}
