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

export interface TranscriptEntry {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

export interface Boundary {
  index: number;
  kind: "microcompact" | "compact";
}

export interface Symptom {
  kind: "reread" | "repeat_question";
  boundaryIndex: number;
  evidence: string;
}

const CLEARED_MARKER = "[Old tool result content cleared]";

/** Content blocks of an entry, or an empty list for any other shape. */
function blocks(entry: TranscriptEntry): Array<Record<string, unknown>> {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
}

function textOf(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? block.text : "";
}

/**
 * :param entries: transcript entries in order
 * :returns one boundary per compaction event; a run of cleared markers is one
 */
export function findBoundaries(entries: TranscriptEntry[]): Boundary[] {
  const out: Boundary[] = [];
  let lastWasCleared = false;

  entries.forEach((entry, index) => {
    if (entry?.subtype === "compact_boundary") {
      out.push({ index, kind: "compact" });
      lastWasCleared = false;
      return;
    }
    const isCleared = blocks(entry).some((b) =>
      b.type === "tool_result" && typeof b.content === "string" &&
      b.content.includes(CLEARED_MARKER));
    if (isCleared && !lastWasCleared) out.push({ index, kind: "microcompact" });
    lastWasCleared = isCleared;
  });

  return out;
}

/** Every file path a Read tool_use targeted, by entry index. */
function readsByIndex(entries: TranscriptEntry[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  entries.forEach((entry, index) => {
    const paths: string[] = [];
    for (const b of blocks(entry)) {
      if (b.type !== "tool_use" || b.name !== "Read") continue;
      const input = b.input as { file_path?: unknown } | undefined;
      if (typeof input?.file_path === "string") paths.push(input.file_path);
    }
    if (paths.length) out.set(index, paths);
  });
  return out;
}

/**
 * Noun phrases worth matching: runs of 2 lowercase words, which is where
 * "deploy target" and "database url" live. Crude on purpose -- a real parser
 * would be a dependency and a false sense of precision.
 *
 * Two things tuned against real transcripts, not just the fixture: contractions
 * and possessives are folded into one token (strip the apostrophe instead of
 * turning it into a space) so "doesn't" and "user's" don't fracture into a
 * stray "t" / "s" that collides with something unrelated a thousand lines
 * away; and slash-delimited paths are stripped before tokenizing, because a
 * path mentioned in prose ("the file at /Users/jsreed/foo.ts") otherwise
 * reads as English words ("users", "jsreed") and produces phantom topics.
 * The stop-word list is also wider than a first pass needs, because on a
 * real transcript -- tens of thousands of words on each side of a boundary --
 * even a handful of missed connective words (rather, than, into, own, per,
 * still, one...) reliably collide by chance and drown out real matches.
 */
function phrases(text: string): Set<string> {
  const noPaths = text.replace(/\/\S+/g, " ");
  const words = noPaths.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(Boolean);
  const out = new Set<string>();
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
    if (stop.has(words[i]) || stop.has(words[i + 1])) continue;
    if (words[i].length < 3 || words[i + 1].length < 3) continue;
    out.add(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

/**
 * :param entries: transcript entries in order
 * :param boundaries: output of findBoundaries over the same entries
 * :returns symptoms attributed to the nearest preceding boundary
 */
export function detectSymptoms(
  entries: TranscriptEntry[],
  boundaries: Boundary[],
): Symptom[] {
  if (boundaries.length === 0) return [];
  const out: Symptom[] = [];
  const reads = readsByIndex(entries);

  for (const boundary of boundaries) {
    const before = new Set<string>();
    for (const [index, paths] of reads) {
      if (index < boundary.index) for (const p of paths) before.add(p);
    }
    const seen = new Set<string>();
    for (const [index, paths] of reads) {
      if (index <= boundary.index) continue;
      for (const p of paths) {
        if (before.has(p) && !seen.has(p)) {
          seen.add(p);
          out.push({ kind: "reread", boundaryIndex: boundary.index, evidence: p });
        }
      }
    }

    // A question after the boundary about something the user already stated
    // before it. Only the user's own words count as "already supplied" --
    // the assistant restating a fact is not the user having given it.
    const supplied = new Set<string>();
    entries.slice(0, boundary.index).forEach((entry) => {
      if (entry?.type !== "user") return;
      for (const b of blocks(entry)) for (const p of phrases(textOf(b))) supplied.add(p);
    });
    const asked = new Set<string>();
    entries.slice(boundary.index + 1).forEach((entry) => {
      if (entry?.type !== "assistant") return;
      for (const b of blocks(entry)) {
        const text = textOf(b);
        if (!text.includes("?")) continue;
        for (const p of phrases(text)) {
          if (supplied.has(p) && !asked.has(p)) {
            asked.add(p);
            out.push({ kind: "repeat_question", boundaryIndex: boundary.index, evidence: p });
          }
        }
      }
    });
  }

  return out;
}
