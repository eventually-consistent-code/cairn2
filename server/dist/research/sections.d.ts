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
export interface SectionMeta {
    date?: string;
    model?: string;
    note?: string;
}
export declare const attemptRe: (namespace: string) => RegExp;
export declare const buildMarker: (namespace: string, state: SectionState, meta?: SectionMeta) => string;
export interface RawSection {
    heading: string;
    level: number;
    index: number;
}
export declare const findHeadings: (lines: string[]) => RawSection[];
export declare const findMarker: (lines: string[], headingIndex: number, namespace: string) => {
    index: number;
    match: RegExpExecArray;
} | undefined;
/**
 * Parse a research artifact's ##+ sections and their completion markers for
 * one namespace. A heading with no marker is state 'unmarked' (legacy --
 * callers decide policy); a marker attempt that doesn't parse throws
 * CONFIG_INVALID naming the line.
 */
export declare function parseSections(markdown: string, namespace: string): Section[];
/**
 * Return new markdown with one section's marker for this namespace replaced
 * (or inserted directly under the heading when unmarked). Heading not found
 * throws NOT_FOUND. Idempotent: same state+meta yields identical output.
 */
export declare function flipSection(markdown: string, namespace: string, heading: string, state: SectionState, meta?: SectionMeta): string;
