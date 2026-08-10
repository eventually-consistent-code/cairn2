/**
 * Purpose: the structured half of the peer contract — a zod Finding schema,
 * a tolerant parser that digs fenced-JSON findings out of raw peer output,
 * and the loader for the prompt templates that ask peers for that shape in
 * the first place. Tolerance is the design center: one bad finding in an
 * array never kills the good ones, and anything that fails to parse or
 * validate lands verbatim in `unparsed` instead of on the floor — the
 * caller (the `peers` verb) judges that pile, this layer never discards.
 * Author(s): John Reed
 */

// Imports
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { CairnError } from "../errors.js";


// Constants

// run.ts glues stderr onto stdout under this divider; everything below it
// is warnings/noise from the peer CLI, never findings.
const STDERR_DIVIDER = "\n--- stderr ---\n";

// Templates live in the skills tree, not in server/ — resolved relative to
// this module, which sits three levels below the repo/plugin root from
// both src/peers/ and dist/peers/.
const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const TEMPLATE_SUBDIR = join("skills", "cairn-trailhead", "templates", "peers");


// Schema

/**
 * One structured peer finding. `axis` stays a free string on purpose —
 * phase 9's review dimensions slot in without a schema change.
 * Unknown extra keys are stripped, not rejected: peers embellish.
 */
export const FindingSchema = z.object({
  claim: z.string().min(1),
  evidence: z.string().min(1),
  evidenceType: z.enum(["file-line", "doc-section", "transcript", "external"]).optional(),
  severity: z.enum(["critical", "important", "minor"]),
  recommendation: z.string().min(1),
  axis: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export interface ParsedFindings {
  findings: Finding[];
  unparsed: string[];
}


// Fence extraction

interface FenceBlock {
  info: string;    // lowercased info string after the opening ``` ("" for bare)
  content: string; // verbatim body between the fences (no trimming)
}

/**
 * Walks the text line by line and collects every fenced code block. An
 * opening fence with no closing fence (truncated peer output) still
 * yields a block — everything to EOF — so a cut-off JSON payload reaches
 * the parse attempt instead of vanishing.
 *
 * :param text: peer output with the stderr section already stripped
 * :returns: blocks in document order
 */
function extractFenceBlocks(text: string): FenceBlock[] {
  const lines = text.split("\n");
  const blocks: FenceBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const open = /^\s*```(\S*)\s*$/.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }

    const info = open[1].toLowerCase();
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    if (i < lines.length) i++; // step past the closing fence

    blocks.push({ info, content: body.join("\n") });
  }

  return blocks;
}


// Parser

/**
 * Tolerant extraction of structured findings from raw peer output.
 *
 * Candidate blocks are every ```json fence plus every bare ``` fence whose
 * content parses as JSON (fences tagged with other languages are code
 * snippets, not findings). Each candidate may hold one finding object or
 * an array; validation is per finding, never all-or-nothing. Whatever
 * fails — malformed JSON, wrong shape, a bad element in a good array —
 * lands verbatim in `unparsed`. No candidates at all means the peer spoke
 * prose: the whole (stderr-stripped) output, trimmed, becomes the single
 * `unparsed` entry so nothing is ever dropped.
 *
 * :param raw: a PeerResult.output string, exactly as run.ts produced it
 * :returns: validated findings plus the verbatim leftovers
 */
export function parseFindings(raw: string): ParsedFindings {
  // Strip the stderr section first — CLI warnings under the divider are
  // noise, and one of them containing a stray fence must not parse.
  const dividerAt = raw.indexOf(STDERR_DIVIDER);
  const body = dividerAt === -1 ? raw : raw.slice(0, dividerAt);

  const findings: Finding[] = [];
  const unparsed: string[] = [];
  let sawCandidate = false;

  for (const { info, content } of extractFenceBlocks(body)) {
    if (info !== "json" && info !== "") continue;

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      // A json-tagged fence that won't parse (truncation, sloppy JSON) is
      // a failed attempt at the contract — keep it. A bare fence that
      // won't parse is just a code/prose snippet — not a candidate.
      if (info === "json") {
        sawCandidate = true;
        unparsed.push(content);
      }
      continue;
    }

    // An empty array here is a peer's explicit "no findings" — a valid,
    // fully-parsed reply that contributes nothing to either pile.
    sawCandidate = true;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const checked = FindingSchema.safeParse(item);
      if (checked.success) {
        findings.push(checked.data);
      } else if (Array.isArray(value)) {
        // Bad element inside an array — the fence content covers its good
        // siblings too, so keep just this element, re-serialized.
        unparsed.push(JSON.stringify(item));
      } else {
        unparsed.push(content);
      }
    }
  }

  // Prose-only output (or nothing but non-JSON code fences): the whole
  // reply is the finding-shaped material, keep it intact.
  if (!sawCandidate) {
    const prose = body.trim();
    return { findings: [], unparsed: prose ? [prose] : [] };
  }

  return { findings, unparsed };
}


// Templates

/**
 * Reads a peer prompt template from skills/cairn-trailhead/templates/peers/
 * and fills its `{{slot}}` markers. Every occurrence of each provided slot
 * is replaced; a slot the caller doesn't provide stays verbatim, so the
 * gap is visible in the outbound prompt instead of silently blanked.
 *
 * :param name: template file name, with or without the .md extension
 * :param slots: slot values, e.g. { focus, dimension, content }
 * :param rootDir: repo/plugin root override — defaults to this module's
 *                 own root (three levels up, valid from src and dist)
 * :returns: the filled template text
 * :raises CairnError: code NOT_FOUND when the template file is missing
 */
export function loadTemplate(
  name: string,
  slots: Record<string, string>,
  rootDir: string = DEFAULT_ROOT_DIR,
): string {
  const file = name.endsWith(".md") ? name : `${name}.md`;

  // Template names are bare file names, never paths — anything that tries
  // to walk the tree simply doesn't exist as a template.
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    throw new CairnError("NOT_FOUND",
      `peer template '${name}' not found`,
      "template names are bare file names under skills/cairn-trailhead/templates/peers/");
  }

  const path = join(rootDir, TEMPLATE_SUBDIR, file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CairnError("NOT_FOUND",
      `peer template '${name}' not found`,
      `expected it at ${join(TEMPLATE_SUBDIR, file)}`);
  }

  for (const [key, value] of Object.entries(slots)) {
    text = text.split(`{{${key}}}`).join(value);
  }

  return text;
}
