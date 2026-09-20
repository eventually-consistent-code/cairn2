import { readdirSync } from "node:fs";
import { cardsDir, listCards, readCard } from "./cards.js";
import { checkCardStaleness } from "./staleness.js";
/** Default: a low-confidence card older than this is a compaction candidate. */
export const AGED_DAYS = 90;
/** Jaccard threshold over significant body tokens. Tuned to surface, not to decide. */
export const DUPLICATE_SIMILARITY = 0.6;
const DAY_MS = 86_400_000;
/**
 * Significant tokens of a card body: lowercased words of 4+ characters,
 * deduplicated. Short words carry no signal and every card shares them.
 */
function tokens(body) {
    return new Set(body.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []);
}
function jaccard(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let shared = 0;
    for (const t of a)
        if (b.has(t))
            shared++;
    return shared / (a.size + b.size - shared);
}
/**
 * Reads every card file directly, reporting the ones `listCards` would skip.
 * This is the whole point of the mode: the silent skip is the rot.
 */
function scanMalformed(projectDir) {
    const dir = cardsDir(projectDir);
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return []; // no card store yet — not a finding
    }
    const out = [];
    for (const entry of entries.sort()) {
        if (!entry.endsWith(".md"))
            continue;
        try {
            // Same read path listCards uses, so anything it would skip fails here too.
            readCard(projectDir, entry.replace(/\.md$/, ""));
        }
        catch (e) {
            const msg = e.message ?? String(e);
            out.push({ file: entry, error: msg.split("\n")[0].slice(0, 200) });
        }
    }
    return out;
}
/**
 * Computes the audit. Never throws on a bad card — surfacing bad cards is
 * the job, so a failure to read one is a finding rather than an error.
 *
 * :param projectDir: repository root
 * :param now: injectable clock for age math
 * :returns: the evidence block
 */
export function auditMemory(projectDir, now = Date.now()) {
    const malformed = scanMalformed(projectDir);
    const cards = listCards(projectDir, {});
    const byType = {};
    const byConfidence = {};
    const provenanceBroken = [];
    const aged = [];
    for (const card of cards) {
        const fm = card.frontmatter;
        byType[fm.type] = (byType[fm.type] ?? 0) + 1;
        // confidence is optional in the schema; group the absent ones honestly
        // rather than letting them vanish from the tally.
        const conf = fm.confidence ?? "unset";
        byConfidence[conf] = (byConfidence[conf] ?? 0) + 1;
        const files = fm.provenanceFiles ?? [];
        const commits = fm.provenanceCommits ?? [];
        if (files.length > 0 && files.length === commits.length) {
            const pairs = files.map((file, i) => ({ file, commit: commits[i] }));
            const { stale, reasons } = checkCardStaleness(projectDir, pairs);
            // "changed" is ordinary drift the recall banner already flags. Only a
            // missing file or an unresolvable commit means the card's evidence is
            // gone, which is what an audit should raise.
            const broken = reasons.filter((r) => r.includes("no longer exists") || r.includes("could not verify"));
            if (stale && broken.length > 0)
                provenanceBroken.push({ id: card.id, reasons: broken });
        }
        const created = fm.created;
        const t = Date.parse(created);
        if (!Number.isNaN(t)) {
            const ageDays = Math.floor((now - t) / DAY_MS);
            if (ageDays >= AGED_DAYS && conf === "low") {
                aged.push({ id: card.id, created, ageDays, confidence: conf });
            }
        }
    }
    // Near-duplicates: O(n^2) over a store that is deliberately small, and the
    // capacity guard exists precisely to keep it that way.
    const nearDuplicates = [];
    const toks = cards.map((c) => ({ id: c.id, t: tokens(c.body) }));
    for (let i = 0; i < toks.length; i++) {
        for (let j = i + 1; j < toks.length; j++) {
            const s = jaccard(toks[i].t, toks[j].t);
            if (s >= DUPLICATE_SIMILARITY) {
                nearDuplicates.push({ a: toks[i].id, b: toks[j].id, similarity: Math.round(s * 100) / 100 });
            }
        }
    }
    nearDuplicates.sort((x, y) => y.similarity - x.similarity);
    return {
        counts: { total: cards.length + malformed.length, readable: cards.length, byType, byConfidence },
        malformed,
        provenanceBroken,
        nearDuplicates,
        aged: aged.sort((a, b) => b.ageDays - a.ageDays),
    };
}
