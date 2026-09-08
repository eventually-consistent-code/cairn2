import type { SectionMeta, SectionState } from "../research/sections.js";
/** The writer's marker namespace -- <!-- docs: done|pending|failed ... -->. */
export declare const DOCS_NAMESPACE = "docs";
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
export declare function writeSection(markdown: string, heading: string, body: string, opts?: WriteSectionOptions): string;
/**
 * Return new markdown with a NEW marked section appended at the end: heading,
 * docs: marker, body. Appending is explicit-only -- a heading that already
 * exists throws PRECONDITION_FAILED (update it with writeSection instead).
 */
export declare function createSection(markdown: string, heading: string, body: string, opts?: CreateSectionOptions): string;
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
export declare function writeSectionFile(path: string, heading: string, body: string, opts?: WriteSectionFileOptions): WriteSectionFileResult;
