// Purpose: marked-section document writer -- machine-safe incremental updates
//   to hand-maintained docs (the distill pipeline merges into these). Rewrites
//   ONLY the region under a section's <!-- docs: --> marker; everything else
//   is preserved byte-for-byte. A section that is missing or unmarked throws,
//   never silently appends or clobbers -- hand-written prose is untouchable
//   by construction. Generalizes the research marker grammar to 'docs:'.
// Author(s): John Reed

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { CairnError } from "../errors.js";
import {
  attemptRe, buildMarker, findHeadings, findMarker, parseSections,
} from "../research/sections.js";
import type { SectionMeta, SectionState } from "../research/sections.js";

/** The writer's marker namespace -- <!-- docs: done|pending|failed ... -->. */
export const DOCS_NAMESPACE = "docs";

export interface WriteSectionOptions {
  /** Rebuild the marker with this state; omitted, the existing marker line
   *  is preserved byte-for-byte. */
  state?: SectionState;
  /** Marker meta (date/model/note) -- applied only when state is given.
   *  A bare 'YYYY-MM-DD' string is accepted as shorthand for { date }. */
  meta?: SectionMeta | string;
}

export interface CreateSectionOptions {
  /** Heading level for the new section: 2..6, default 2 ('##'). */
  level?: number;
  /** Marker state stamped on the new section (default 'done'). */
  state?: SectionState;
  /** Marker meta; a bare 'YYYY-MM-DD' string means { date }. */
  meta?: SectionMeta | string;
}

// Guards the live bug: callers passing meta as a bare date string
// ({meta: '2026-09-01'}) instead of a SectionMeta object. Property access on
// a string ('2026-09-01'.date) is undefined, so buildMarker silently dropped
// EVERY meta field and rebuilt a bare '<!-- docs: done -->'. Accept the
// date-string shorthand; any other string meta is a loud typo, never a
// silent bare marker.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const normalizeMeta = (meta?: SectionMeta | string): SectionMeta | undefined => {
  if (typeof meta !== "string") return meta;
  const trimmed = meta.trim();
  if (DATE_ONLY_RE.test(trimmed)) return { date: trimmed };
  throw new CairnError("CONFIG_INVALID",
    `meta must be a { date, model, note } object or a bare YYYY-MM-DD date string, got '${meta}'`,
    "pass meta as an object, e.g. { date: '2026-09-01', model: 'sonnet' }");
};

// A replacement body must not restructure the document: a ##+ heading inside
// it would split the marked region (breaking the next write), and a docs:
// marker inside it would forge machine provenance. Fenced examples are fine.
const assertBody = (body: string): void => {
  const lines = body.split("\n");
  if (findHeadings(lines).length > 0) {
    throw new CairnError("CONFIG_INVALID",
      "body must not contain ##+ headings -- that would split the marked region",
      "write each subsection through its own marked section instead");
  }
  const attempt = attemptRe(DOCS_NAMESPACE);
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence && attempt.test(line)) {
      throw new CairnError("CONFIG_INVALID",
        "body must not contain a docs: marker line",
        "drop the marker from the body -- the writer manages the marker");
    }
  }
};

interface Region { markerIndex: number; end: number; }

// The marked region: everything after the section's docs: marker up to (not
// including) the next ##+ heading at ANY level, or EOF. Ending at any heading
// keeps subsections out of reach -- each one is its own (marked or protected)
// region. Missing heading is NOT_FOUND; a heading with no docs: marker is
// PRECONDITION_FAILED -- that prose never opted into machine updates.
const findRegion = (lines: string[], heading: string): Region => {
  const headings = findHeadings(lines);
  const pos = headings.findIndex((h) => h.heading === heading);
  if (pos === -1) {
    throw new CairnError("NOT_FOUND",
      `no section heading '${heading}' in the document`,
      "check the heading text, or create the section explicitly");
  }
  const marker = findMarker(lines, headings[pos].index, DOCS_NAMESPACE);
  if (!marker) {
    throw new CairnError("PRECONDITION_FAILED",
      `section '${heading}' has no <!-- docs: --> marker -- it is hand-written prose`,
      "add a '<!-- docs: done -->' line under the heading to opt it into machine updates");
  }
  const next = headings[pos + 1];
  return { markerIndex: marker.index, end: next ? next.index : lines.length };
};

// Deterministic region serialization: blank line after the marker, the body
// (trailing whitespace trimmed), blank line before whatever follows. The same
// body always serializes identically -- that is what makes writes idempotent.
const regionLines = (body: string): string[] => {
  const trimmed = body.replace(/\s+$/, "");
  return trimmed === "" ? [""] : ["", ...trimmed.split("\n"), ""];
};

/**
 * Return new markdown with the docs-marked region under `heading` replaced by
 * `body`. Everything outside the region -- including the marker line, unless
 * opts.state rebuilds it -- is preserved byte-for-byte. Idempotent: writing
 * the same body twice yields identical output.
 *
 * :throws CairnError NOT_FOUND when the heading is missing,
 *   PRECONDITION_FAILED when it carries no docs: marker, CONFIG_INVALID for a
 *   typo'd marker anywhere in the doc or a region-breaking body.
 */
export function writeSection(markdown: string, heading: string, body: string,
  opts?: WriteSectionOptions): string {
  assertBody(body);
  const lines = markdown.split("\n");
  const region = findRegion(lines, heading);
  const marker = opts?.state !== undefined
    ? buildMarker(DOCS_NAMESPACE, opts.state, normalizeMeta(opts.meta))
    : lines[region.markerIndex];
  const out = [
    ...lines.slice(0, region.markerIndex),
    marker,
    ...regionLines(body),
    ...lines.slice(region.end),
  ].join("\n");
  // Validate the WHOLE result before returning -- a typo'd docs marker in any
  // other section fails the write, exactly like research_sections' flip.
  parseSections(out, DOCS_NAMESPACE);
  return out;
}

/**
 * Return new markdown with a NEW marked section appended at the end: heading,
 * docs: marker, body. Appending is explicit-only -- a heading that already
 * exists throws PRECONDITION_FAILED (update it with writeSection instead).
 */
export function createSection(markdown: string, heading: string, body: string,
  opts?: CreateSectionOptions): string {
  assertBody(body);
  const level = opts?.level ?? 2;
  if (!Number.isInteger(level) || level < 2 || level > 6) {
    throw new CairnError("CONFIG_INVALID",
      `heading level must be an integer 2..6, got '${level}'`,
      "sections are ##+ headings; pass 2 for '##'");
  }
  if (heading.trim() === "" || heading.includes("\n")) {
    throw new CairnError("CONFIG_INVALID",
      "heading must be a non-empty single line",
      "pass the heading text without '#' prefixes or newlines");
  }
  const lines = markdown.split("\n");
  if (findHeadings(lines).some((h) => h.heading === heading)) {
    throw new CairnError("PRECONDITION_FAILED",
      `section '${heading}' already exists -- refusing to append a duplicate`,
      "use writeSection to update the existing section");
  }
  const marker = buildMarker(DOCS_NAMESPACE, opts?.state ?? "done", normalizeMeta(opts?.meta));
  const base = markdown.replace(/\s+$/, "");
  const block = [
    `${"#".repeat(level)} ${heading.trim()}`,
    marker,
    ...regionLines(body),
  ].join("\n");
  const out = base === "" ? block : `${base}\n\n${block}`;
  parseSections(out, DOCS_NAMESPACE);
  return out;
}

export interface WriteSectionFileOptions extends WriteSectionOptions {
  /** Append the section (heading + marker + body) when the heading is
   *  missing, instead of throwing NOT_FOUND. Never rescues an UNMARKED
   *  section -- that stays PRECONDITION_FAILED. */
  createMissing?: boolean;
  /** Heading level when createMissing appends (default 2). */
  level?: number;
}

export interface WriteSectionFileResult {
  path: string;
  /** false when the write was a byte-for-byte no-op (idempotent skip). */
  changed: boolean;
}

/**
 * File-level writer for the distill pipeline: read the doc, rewrite one
 * marked section, and persist atomically (tmp + rename, same idiom as
 * research_sections' flip). An identical body is a no-op -- the file is not
 * rewritten and `changed` is false, so repeated distill runs produce zero
 * diff. `path` is the caller's resolved path; containment policy (project-dir
 * checks, symlink realpath) belongs to the MCP surface, not this library.
 */
export function writeSectionFile(path: string, heading: string, body: string,
  opts?: WriteSectionFileOptions): WriteSectionFileResult {
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch {
    throw new CairnError("NOT_FOUND",
      `no document at ${path}`,
      "pass the path of an existing markdown file");
  }
  let out: string;
  try {
    out = writeSection(markdown, heading, body, opts);
  } catch (e) {
    const missing = e instanceof CairnError && e.code === "NOT_FOUND";
    if (!missing || !opts?.createMissing) throw e;
    out = createSection(markdown, heading, body, {
      level: opts.level,
      state: opts.state ?? "done",
      meta: opts.meta,
    });
  }
  if (out === markdown) return { path, changed: false };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return { path, changed: true };
}
