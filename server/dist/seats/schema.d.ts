/**
 * Purpose: the seat definition schema — one parameterized shape (name, lens,
 * rubric categories, anchored 0-10 scale, injection dose, scope signals,
 * advisory model) with N definitions, replacing prose-clone role files.
 * Seat files carry flat frontmatter (the plugin's agents/*.md shape); this
 * module owns the flat→nested mapping and the human-first validation errors
 * that name the file and the field.
 * Author(s): John Reed
 */
import { z } from "zod";
export declare const DOSES: readonly ["minimal", "standard", "full"];
export type Dose = (typeof DOSES)[number];
/**
 * One seat definition — a named, reusable viewpoint as DATA, not prose.
 * `signals` stays a free vocabulary this phase (wave 3's dispatch consumes
 * it); `model` is advisory only — the model-routing blast-radius rubric
 * ALWAYS beats a seat's preference.
 */
export declare const SeatSchema: z.ZodObject<{
    name: z.ZodString;
    lens: z.ZodString;
    categories: z.ZodArray<z.ZodString>;
    scale: z.ZodObject<{
        anchors: z.ZodObject<{
            ten: z.ZodString;
            five: z.ZodOptional<z.ZodString>;
            zero: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        honesty: z.ZodString;
    }, z.core.$strip>;
    dose: z.ZodEnum<{
        standard: "standard";
        minimal: "minimal";
        full: "full";
    }>;
    signals: z.ZodArray<z.ZodString>;
    model: z.ZodOptional<z.ZodEnum<{
        haiku: "haiku";
        sonnet: "sonnet";
        opus: "opus";
    }>>;
}, z.core.$strip>;
export type Seat = z.infer<typeof SeatSchema>;
/**
 * Parses one seat definition file: flat zod-validated frontmatter plus a free
 * markdown body (the lens prose). Any failure is a typed CONFIG_INVALID whose
 * message names the file and the offending frontmatter field — write-time
 * validation, never a CI grep.
 *
 * :param text: raw file contents
 * :param sourcePath: where the file lives — lands verbatim in error messages
 * :returns: the validated seat plus the untouched body
 */
export declare function parseSeatDoc(text: string, sourcePath: string): {
    seat: Seat;
    body: string;
};
