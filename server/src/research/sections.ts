// Purpose: one section-marker grammar for every research artifact consumer
//   (scout's RESEARCH.md, survey's SURVEY.md, council, ...). Parses ##+
//   sections and their completion markers, and flips a section's marker in
//   place -- a typo'd marker throws instead of silently reading as done.
// Author(s): John Reed

import { CairnError } from "../errors.js";

export type SectionState = "done" | "pending" | "failed";

export interface Section {
  heading: string;
  level: number;
  /** 1-indexed line of the heading. */
  line: number;
  state: SectionState | "unmarked";
  date?: string;
  model?: string;
  note?: string;
  /** 1-indexed line of the marker comment, when one exists. */
  markerLine?: number;
}

export interface SectionMeta { date?: string; model?: string; note?: string; }

// The grammar: <!-- <namespace>: <state>[ <date>][ <model>][ — <note>] -->
//   namespace ∈ [a-z]+, state ∈ done|pending|failed, date is YYYY-MM-DD,
//   model is a lowercase tier token, note is free text after an em/en dash.
const NAMESPACE_RE = /^[a-z]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL_RE = /^[a-z0-9-]+$/;
const MARKER_RE = new RegExp(
  "^<!--\\s*([a-z]+):\\s+(done|pending|failed)"
  + "(?:\\s+(\\d{4}-\\d{2}-\\d{2}))?"        // optional ISO date
  + "(?:\\s+([a-z0-9-]+))?"                  // optional model tier token
  + "(?:\\s+[—–]\\s+(.*?))?"                 // optional note after em/en dash
  + "\\s*-->$",
);

// CommonMark allows up to 3 leading SPACES on a heading (4 is a code
// block, and a tab never counts) — match that so a lightly-indented
// section still registers.
const HEADING_RE = /^ {0,3}(#{2,})\s+(.*?)\s*$/;
const COMMENT_RE = /^<!--.*-->$/;
// "Looks like a marker attempt for this namespace" -- the namespace name
// followed by a colon inside a comment. Anything matching this that fails the
// strict grammar above is a typo, never a legacy no-marker section.
const attemptRe = (namespace: string): RegExp =>
  new RegExp(`^<!--\\s*${namespace}\\s*:`);

const assertNamespace = (namespace: string): void => {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new CairnError("CONFIG_INVALID",
      `namespace must be lowercase letters only, got '${namespace}'`,
      "use a plain lowercase namespace like scout, survey, or council");
  }
};

const buildMarker = (namespace: string, state: SectionState, meta?: SectionMeta): string => {
  if (meta?.date !== undefined && !DATE_RE.test(meta.date)) {
    throw new CairnError("CONFIG_INVALID",
      `date must be YYYY-MM-DD, got '${meta.date}'`,
      "pass an ISO date like 2026-08-10, or omit it");
  }
  if (meta?.model !== undefined && !MODEL_RE.test(meta.model)) {
    throw new CairnError("CONFIG_INVALID",
      `model must be a lowercase tier token ([a-z0-9-]+), got '${meta.model}'`,
      "use a token like sonnet, haiku, or opus-4-6, or omit it");
  }
  if (meta?.note !== undefined && (meta.note.includes("-->") || meta.note.includes("\n"))) {
    throw new CairnError("CONFIG_INVALID",
      "note must be a single line and cannot contain '-->'",
      "reword the note without a comment terminator or newline");
  }
  const parts = [`<!-- ${namespace}: ${state}`];
  if (meta?.date) parts.push(` ${meta.date}`);
  if (meta?.model) parts.push(` ${meta.model}`);
  if (meta?.note) parts.push(` — ${meta.note}`);
  parts.push(" -->");
  return parts.join("");
};

interface RawSection { heading: string; level: number; index: number; }

// Sections are ##+ headings outside fenced code blocks -- a ```-fenced
// example containing '## Fake' must never register (or typo-throw).
const findHeadings = (lines: string[]): RawSection[] => {
  const out: RawSection[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^(```|~~~)/.test(lines[i].trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m) out.push({ heading: m[2], level: m[1].length, index: i });
  }
  return out;
};

// The marker block: consecutive comment lines (blank lines allowed between)
// directly under the heading, ending at the first prose/heading line. Returns
// this namespace's marker line index, or undefined when the section carries
// no marker for it. A comment that ATTEMPTS this namespace but fails the
// grammar throws -- never silently classifies.
const findMarker = (lines: string[], headingIndex: number, namespace: string):
  { index: number; match: RegExpExecArray } | undefined => {
  const attempt = attemptRe(namespace);
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (!COMMENT_RE.test(line)) break; // first real content ends the block
    if (!attempt.test(line)) continue; // other namespace (or plain comment): ignored
    const match = MARKER_RE.exec(line);
    if (!match || match[1] !== namespace) {
      throw new CairnError("CONFIG_INVALID",
        `line ${i + 1}: '${line}' looks like a ${namespace} section marker but does not parse`,
        `fix the marker to '<!-- ${namespace}: done|pending|failed [YYYY-MM-DD] [model] [— note] -->'`);
    }
    return { index: i, match };
  }
  return undefined;
};

/**
 * Parse a research artifact's ##+ sections and their completion markers for
 * one namespace. A heading with no marker is state 'unmarked' (legacy --
 * callers decide policy); a marker attempt that doesn't parse throws
 * CONFIG_INVALID naming the line.
 */
export function parseSections(markdown: string, namespace: string): Section[] {
  assertNamespace(namespace);
  const lines = markdown.split("\n");
  return findHeadings(lines).map(({ heading, level, index }) => {
    const marker = findMarker(lines, index, namespace);
    if (!marker) return { heading, level, line: index + 1, state: "unmarked" as const };
    const [, , state, date, model, note] = marker.match;
    return {
      heading, level, line: index + 1,
      state: state as SectionState,
      ...(date !== undefined ? { date } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(note !== undefined ? { note } : {}),
      markerLine: marker.index + 1,
    };
  });
}

/**
 * Return new markdown with one section's marker for this namespace replaced
 * (or inserted directly under the heading when unmarked). Heading not found
 * throws NOT_FOUND. Idempotent: same state+meta yields identical output.
 */
export function flipSection(markdown: string, namespace: string, heading: string,
  state: SectionState, meta?: SectionMeta): string {
  assertNamespace(namespace);
  const marker = buildMarker(namespace, state, meta);
  const lines = markdown.split("\n");
  const target = findHeadings(lines).find((h) => h.heading === heading);
  if (!target) {
    throw new CairnError("NOT_FOUND",
      `no section heading '${heading}' in the document`,
      "check the heading text with a parse-only call first");
  }
  const existing = findMarker(lines, target.index, namespace);
  if (existing) {
    lines[existing.index] = marker;
  } else {
    lines.splice(target.index + 1, 0, marker);
  }
  return lines.join("\n");
}
