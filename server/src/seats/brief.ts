/**
 * Purpose: wave-brief composition — `work`'s per-issue dispatch briefs,
 * composed from templates/wave-brief.md plus an optional roster seat
 * (and that seat's role-scoped memory cards) instead of freehand
 * retyping. Same {{slot}} mechanism as the peers
 * templates: every occurrence of a provided slot is replaced, and the
 * seat framing rides at the seat's declared dose. No tool surface — the
 * work verb reads the template + seat_roster directly; this module is
 * the tested reference composition (and the future server-side path).
 * Author(s): John Reed
 */

// Imports
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CairnError } from "../errors.js";
import type { Seat } from "./schema.js";


// Constants

// The template lives in the plugin's templates tree, not server/ —
// resolved relative to this module, which sits three levels below the
// repo/plugin root from both src/seats/ and dist/seats/ (same trick as
// roster.ts and peers/findings.ts).
const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const TEMPLATE_PATH = join("templates", "wave-brief.md");


// Types

export interface RoleCard {
  /** The card body — the remembered fact itself. */
  body: string;
  /** The card's confidence grade, when it carries one. */
  confidence?: "high" | "medium" | "low";
  /** Card creation date (YYYY-MM-DD, from the card frontmatter). */
  created: string;
  /** Provenance-checked staleness — true marks the line as possibly rotten. */
  stale: boolean;
}

export interface BriefInput {
  /** Validated roster seat — absent means a generic (seatless) brief. */
  seat?: Seat;
  /** The seat's lens prose body — rides into the brief only at dose "full". */
  seatBody?: string;
  /**
   * Role-scoped memory cards (scopeRole = seat name) — rendered as a short
   * "what this seat remembers" section. Absent or empty skips the section
   * entirely: output stays byte-identical to a roleCards-less compose.
   */
  roleCards?: RoleCard[];
  /** Tracker issue content: id, title, body — lands verbatim under Task. */
  issue: string;
  /** This issue's PLAN.md task text (+ any locked decisions that bind it). */
  planExcerpt: string;
  /** Wave-specific rule details: base sha, setup commands, trailer block. */
  rules?: string;
  /** Repo/plugin root override — test seam for the template location. */
  rootDir?: string;
}


// Composition

/**
 * Renders the seat-framing section at the seat's declared dose:
 * minimal = lens only; standard = + categories + honesty line;
 * full = + scale anchors + the lens prose body.
 *
 * :param seat: validated seat definition
 * :param body: the lens prose below the seat's frontmatter (full dose only)
 * :returns: the markdown framing section
 */
function seatFraming(seat: Seat, body?: string): string {
  const lines = [`## Seat: ${seat.name}`, "", `Lens: ${seat.lens}`];
  if (seat.dose !== "minimal") {
    lines.push(`Categories: ${seat.categories.join(", ")}`);
    lines.push(`Honesty: ${seat.scale.honesty}`);
  }
  if (seat.dose === "full") {
    const a = seat.scale.anchors;
    const anchors = [`10 — ${a.ten}`];
    if (a.five) anchors.push(`5 — ${a.five}`);
    if (a.zero) anchors.push(`0 — ${a.zero}`);
    lines.push(`Anchors: ${anchors.join("; ")}`);
    if (body?.trim()) {
      lines.push("", body.trim());
    }
  }
  return lines.join("\n");
}

/**
 * Renders the "what this seat remembers" section — one line per
 * role-scoped card, newest-first order left to the caller. A stale card
 * (provenance rotted) is marked inline so the reader weighs it lightly.
 *
 * :param cards: role-scoped card summaries, already staleness-checked
 * :returns: the markdown memory section
 */
function roleMemory(cards: RoleCard[]): string {
  const lines = ["What this seat remembers:"];
  for (const c of cards) {
    const meta = [c.created];
    if (c.confidence) meta.push(`confidence ${c.confidence}`);
    if (c.stale) meta.push("STALE — verify before leaning on it");
    lines.push(`- (${meta.join("; ")}) ${c.body.trim().replace(/\s*\n\s*/g, " ")}`);
  }
  return lines.join("\n");
}

/**
 * Composes one wave dispatch brief from templates/wave-brief.md.
 *
 * Seatless composition fills the framing slot empty — the generic brief,
 * structurally identical to the hand-written ones this replaces. With a
 * seat, the framing section leads, quoting lens/categories/honesty at
 * the seat's dose. An unprovided optional slot renders empty (never a
 * dangling {{marker}}); blank-line runs left by empty slots collapse.
 *
 * :param input: seat (optional), issue content, plan excerpt, rules
 * :returns: the filled brief text, ready to hand a wave worker
 * :raises CairnError: code NOT_FOUND when the template file is missing
 */
export function composeBrief(input: BriefInput): string {
  const rootDir = input.rootDir ?? DEFAULT_ROOT_DIR;
  const path = join(rootDir, TEMPLATE_PATH);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CairnError(
      "NOT_FOUND",
      "wave-brief template not found",
      `expected it at ${TEMPLATE_PATH}`,
    );
  }

  // The doc comment atop the template is for template editors, not
  // workers — strip it (and only it) before filling, so the slot names
  // it mentions don't get filled as if they were live slots.
  text = text.replace(/^<!--[\s\S]*?-->\s*/, "");

  // The framing slot stacks the seat section and the seat's memory —
  // either part absent just drops out (no roleCards means the slot value
  // is exactly what it was before roleCards existed).
  const framingParts: string[] = [];
  if (input.seat) framingParts.push(seatFraming(input.seat, input.seatBody));
  if (input.roleCards?.length) framingParts.push(roleMemory(input.roleCards));

  const slots: Record<string, string> = {
    seat_framing: framingParts.join("\n\n"),
    issue: input.issue,
    plan_excerpt: input.planExcerpt,
    rules: input.rules ?? "",
  };
  for (const [key, value] of Object.entries(slots)) {
    text = text.split(`{{${key}}}`).join(value);
  }

  // Empty slots leave stacked blank lines behind — collapse, don't ship.
  return text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}
