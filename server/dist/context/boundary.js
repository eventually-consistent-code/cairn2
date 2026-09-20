/**
 * Compaction boundaries, and whether crossing one cost anything.
 *
 * The harness compacts on its own -- a microcompact clears old tool results
 * in place, a full compaction summarises and restarts. Moving the threshold
 * from window-safety to cost-optimal makes boundaries far more frequent, so
 * the question "did that hurt" stops being academic.
 *
 * It cuts BOTH ways. Context-rot research finds recall degrading as context
 * grows, so a session riding 900k is also losing information -- just without
 * a marker in the transcript to blame. These detectors say what a boundary
 * cost; they do not assume the pre-boundary state was healthy.
 *
 * Deliberately crude, and deliberately only two. A third symptom -- a
 * decision reversed without new evidence -- needs semantic judgement this
 * cannot honestly fake, so boundary reports surface the surrounding turns
 * for a human to label rather than guessing.
 */
const CLEARED_MARKER = "[Old tool result content cleared]";
/**
 * Content blocks of an entry, or an empty list for any other shape.
 * A content array can hold anything -- null, a bare string, whatever a
 * malformed line coughs up -- so only real objects pass through.
 */
function blocks(entry) {
    const content = entry?.message?.content;
    if (!Array.isArray(content))
        return [];
    return content.filter((b) => typeof b === "object" && b !== null);
}
function textOf(block) {
    return typeof block.text === "string" ? block.text : "";
}
/**
 * :param entries: transcript entries in order
 * :returns one boundary per compaction event; a run of cleared markers is one
 */
export function findBoundaries(entries) {
    const out = [];
    let lastWasCleared = false;
    entries.forEach((entry, index) => {
        if (entry?.subtype === "compact_boundary") {
            out.push({ index, kind: "compact" });
            lastWasCleared = false;
            return;
        }
        const isCleared = blocks(entry).some((b) => b.type === "tool_result" && typeof b.content === "string" &&
            b.content.includes(CLEARED_MARKER));
        if (isCleared && !lastWasCleared)
            out.push({ index, kind: "microcompact" });
        lastWasCleared = isCleared;
    });
    return out;
}
/** Every file path a Read tool_use targeted, by entry index. */
function readsByIndex(entries) {
    const out = new Map();
    entries.forEach((entry, index) => {
        const paths = [];
        for (const b of blocks(entry)) {
            if (b.type !== "tool_use" || b.name !== "Read")
                continue;
            const input = b.input;
            if (typeof input?.file_path === "string")
                paths.push(input.file_path);
        }
        if (paths.length)
            out.set(index, paths);
    });
    return out;
}
/**
 * Noun phrases worth matching: runs of 2 lowercase words, which is where
 * "deploy target" and "database url" live. Crude on purpose -- a real parser
 * would be a dependency and a false sense of precision.
 *
 * Two things tuned against real transcripts, not just the fixture:
 * slash-delimited paths are stripped before tokenizing, because a path
 * mentioned in prose ("the file at /Users/jsreed/foo.ts") otherwise reads as
 * English words ("users", "jsreed") and produces phantom topics; and the
 * stop-word list is wider than a first pass needs, because on a real
 * transcript -- tens of thousands of words on each side of a boundary --
 * even a handful of missed connective words (rather, than, into, own, per,
 * still, one...) reliably collide by chance and drown out real matches.
 * Including "s" and "t" as stop words also covers the fragment an apostrophe
 * leaves behind ("doesn't" -> "doesn" + "t", "user's" -> "user" + "s")
 * without needing to fold contractions into one token first -- tried that,
 * and it changed nothing on either real transcript once the stop words were
 * in place, so it stayed out.
 */
function phrases(text) {
    const noPaths = text.replace(/\/\S+/g, " ");
    const words = noPaths.toLowerCase().replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/).filter(Boolean);
    const out = new Set();
    const stop = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "to", "of", "in", "on", "for", "and", "or", "nor", "but", "so", "it", "its", "this",
        "that", "these", "those", "which", "what", "who", "whom", "whose", "should", "would",
        "could", "can", "may", "might", "must", "shall", "will", "i", "you", "he", "she", "we",
        "they", "them", "him", "her", "us", "me", "my", "your", "our", "their", "his", "use",
        "used", "using", "do", "does", "did", "done", "with", "without", "at", "by", "from",
        "as", "than", "then", "rather", "into", "onto", "upon", "also", "just", "only", "even",
        "ever", "never", "always", "still", "yet", "quite", "much", "many", "more", "most",
        "less", "least", "own", "same", "such", "some", "any", "each", "every", "both", "few",
        "several", "other", "another", "one", "two", "three", "first", "second", "last", "next",
        "per", "let", "lets", "get", "gets", "got", "way", "ways", "row", "s", "t", "re", "ve",
        "ll", "d", "m", "not", "no", "if", "when", "where", "while", "because", "about", "over",
        "under", "again", "here", "there", "up", "down", "out", "off", "all"]);
    for (let i = 0; i < words.length - 1; i++) {
        if (stop.has(words[i]) || stop.has(words[i + 1]))
            continue;
        if (words[i].length < 3 || words[i + 1].length < 3)
            continue;
        out.add(`${words[i]} ${words[i + 1]}`);
    }
    return out;
}
/**
 * :param entries: transcript entries in order
 * :param boundaries: output of findBoundaries over the same entries
 * :returns symptoms attributed to the nearest preceding boundary
 *
 * "Before" a boundary is unbounded -- everything up to it, since a file read
 * long ago and re-read now is still evidence of that re-read, and a fact the
 * user gave at any earlier point still counts as already supplied. "After"
 * a boundary is bounded at the *next* boundary (or the end of the transcript
 * for the last one), so a single re-read or repeated question is attributed
 * to exactly one boundary -- the one it actually followed -- instead of to
 * every boundary that happens to precede it.
 */
export function detectSymptoms(entries, boundaries) {
    if (boundaries.length === 0)
        return [];
    const out = [];
    const reads = readsByIndex(entries);
    boundaries.forEach((boundary, i) => {
        const windowEnd = i + 1 < boundaries.length ? boundaries[i + 1].index : entries.length;
        const before = new Set();
        for (const [index, paths] of reads) {
            if (index < boundary.index)
                for (const p of paths)
                    before.add(p);
        }
        const seen = new Set();
        for (const [index, paths] of reads) {
            if (index <= boundary.index || index >= windowEnd)
                continue;
            for (const p of paths) {
                if (before.has(p) && !seen.has(p)) {
                    seen.add(p);
                    out.push({ kind: "reread", boundaryIndex: boundary.index, evidence: p });
                }
            }
        }
        // A question after the boundary (and before the next one) about
        // something the user already stated before it. Only the user's own
        // words count as "already supplied" -- the assistant restating a fact
        // is not the user having given it.
        const supplied = new Set();
        entries.slice(0, boundary.index).forEach((entry) => {
            if (entry?.type !== "user")
                return;
            for (const b of blocks(entry))
                for (const p of phrases(textOf(b)))
                    supplied.add(p);
        });
        const asked = new Set();
        entries.slice(boundary.index + 1, windowEnd).forEach((entry) => {
            if (entry?.type !== "assistant")
                return;
            for (const b of blocks(entry)) {
                const text = textOf(b);
                if (!text.includes("?"))
                    continue;
                for (const p of phrases(text)) {
                    if (supplied.has(p) && !asked.has(p)) {
                        asked.add(p);
                        out.push({ kind: "repeat_question", boundaryIndex: boundary.index, evidence: p });
                    }
                }
            }
        });
    });
    return out;
}
