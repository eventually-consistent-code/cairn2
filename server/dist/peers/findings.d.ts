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
import { z } from "zod";
/**
 * One structured peer finding. `axis` stays a free string on purpose —
 * phase 9's review dimensions slot in without a schema change.
 * Unknown extra keys are stripped, not rejected: peers embellish.
 */
export declare const FindingSchema: z.ZodObject<{
    claim: z.ZodString;
    evidence: z.ZodString;
    evidenceType: z.ZodOptional<z.ZodEnum<["file-line", "doc-section", "transcript", "external"]>>;
    severity: z.ZodEnum<["critical", "important", "minor"]>;
    recommendation: z.ZodString;
    axis: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    evidence: string;
    severity: "critical" | "important" | "minor";
    claim: string;
    recommendation: string;
    evidenceType?: "file-line" | "doc-section" | "transcript" | "external" | undefined;
    axis?: string | undefined;
}, {
    evidence: string;
    severity: "critical" | "important" | "minor";
    claim: string;
    recommendation: string;
    evidenceType?: "file-line" | "doc-section" | "transcript" | "external" | undefined;
    axis?: string | undefined;
}>;
export type Finding = z.infer<typeof FindingSchema>;
export interface ParsedFindings {
    findings: Finding[];
    unparsed: string[];
}
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
export declare function parseFindings(raw: string): ParsedFindings;
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
export declare function loadTemplate(name: string, slots: Record<string, string>, rootDir?: string): string;
