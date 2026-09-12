/**
 * Purpose: the seat definition schema — one parameterized shape (name, lens,
 * rubric categories, anchored 0-10 scale, injection dose, scope signals,
 * advisory model) with N definitions, replacing prose-clone role files.
 * Seat files carry flat frontmatter (the plugin's agents/*.md shape); this
 * module owns the flat→nested mapping and the human-first validation errors
 * that name the file and the field.
 * Author(s): John Reed
 */

// Imports
import { z } from "zod";
import { CairnError } from "../errors.js";
import { parseFrontmatter } from "../planning/frontmatter.js";


// Constants

export const DOSES = ["minimal", "standard", "full"] as const;
export type Dose = (typeof DOSES)[number];

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// The canonical seat shape is nested (scale.anchors.ten), but frontmatter is
// flat by design — this maps a zod issue path back to the frontmatter key the
// user actually typed, so validation errors name something greppable.
const FRONTMATTER_KEY: Record<string, string> = {
  "scale.anchors.ten": "anchor_ten",
  "scale.anchors.five": "anchor_five",
  "scale.anchors.zero": "anchor_zero",
  "scale.honesty": "honesty",
};


// Schema

/**
 * One seat definition — a named, reusable viewpoint as DATA, not prose.
 * `signals` stays a free vocabulary this phase (wave 3's dispatch consumes
 * it); `model` is advisory only — the model-routing blast-radius rubric
 * ALWAYS beats a seat's preference.
 */
export const SeatSchema = z.object({
  name: z
    .string()
    .regex(KEBAB_RE, "must be kebab-case (lowercase letters/digits, hyphen-separated)")
    .describe("unique roster key — project seats override defaults by this name"),
  lens: z
    .string()
    .min(1)
    .refine((s) => !s.includes("\n"), "must be a single line")
    .describe("one-line viewpoint — what this seat is looking for"),
  categories: z
    .array(z.string().min(1))
    .min(1)
    .describe("rubric axes this seat scores"),
  scale: z.object({
    anchors: z.object({
      ten: z.string().min(1).describe("what a 10 looks like"),
      five: z.string().min(1).optional().describe("what a 5 looks like"),
      zero: z.string().min(1).optional().describe("what a 0 looks like"),
    }),
    honesty: z
      .string()
      .min(1)
      .describe("fabrication-refusal line — what the seat says instead of inventing a score"),
  }),
  dose: z
    .enum(DOSES)
    .describe("server-validated injection tier — how much of the definition rides into a brief"),
  signals: z
    .array(z.string().min(1))
    .describe("scope-signal names (free vocabulary this phase) — dispatch picks seats by these"),
  model: z
    .enum(["haiku", "sonnet", "opus"])
    .optional()
    .describe("advisory only — the model-routing blast-radius rubric always wins over this preference"),
});
export type Seat = z.infer<typeof SeatSchema>;


// Parsing

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
export function parseSeatDoc(
  text: string,
  sourcePath: string,
): { seat: Seat; body: string } {
  let data: Record<string, string | string[]>;
  let body: string;
  try {
    ({ data, body } = parseFrontmatter(text));
  } catch (e) {
    const detail = e instanceof CairnError ? e.message : String(e);
    throw new CairnError(
      "CONFIG_INVALID",
      `seat definition ${sourcePath}: ${detail}`,
      "seat files open with a flat frontmatter block — see templates/seats/ for the shape",
    );
  }
  // Flat frontmatter → the canonical nested shape.
  const candidate = {
    name: data.name,
    lens: data.lens,
    categories: data.categories,
    scale: {
      anchors: {
        ten: data.anchor_ten,
        five: data.anchor_five,
        zero: data.anchor_zero,
      },
      honesty: data.honesty,
    },
    dose: data.dose,
    signals: data.signals,
    model: data.model,
  };
  const result = SeatSchema.safeParse(candidate);
  if (!result.success) {
    const parts = result.error.issues.map((i) => {
      const path = i.path.join(".");
      const key = FRONTMATTER_KEY[path] ?? path;
      // Human-first special case for the one live bug class this schema
      // structurally kills: a seat that never declared its dose.
      const message =
        key === "dose" && data.dose === undefined
          ? "required — every seat declares its injection dose (minimal | standard | full)"
          : i.message;
      return `${key}: ${message}`;
    });
    throw new CairnError(
      "CONFIG_INVALID",
      `seat definition ${sourcePath}: ${parts.join("; ")}`,
      "fix the named frontmatter field(s) — see templates/seats/ for the shape",
    );
  }
  return { seat: result.data, body };
}
