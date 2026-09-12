/**
 * Purpose: wave-brief composition — `work`'s per-issue dispatch briefs,
 * composed from templates/wave-brief.md plus an optional roster seat
 * instead of freehand retyping. Same {{slot}} mechanism as the peers
 * templates: every occurrence of a provided slot is replaced, and the
 * seat framing rides at the seat's declared dose. No tool surface — the
 * work verb reads the template + seat_roster directly; this module is
 * the tested reference composition (and the future server-side path).
 * Author(s): John Reed
 */
import type { Seat } from "./schema.js";
export interface BriefInput {
    /** Validated roster seat — absent means a generic (seatless) brief. */
    seat?: Seat;
    /** The seat's lens prose body — rides into the brief only at dose "full". */
    seatBody?: string;
    /** Tracker issue content: id, title, body — lands verbatim under Task. */
    issue: string;
    /** This issue's PLAN.md task text (+ any locked decisions that bind it). */
    planExcerpt: string;
    /** Wave-specific rule details: base sha, setup commands, trailer block. */
    rules?: string;
    /** Repo/plugin root override — test seam for the template location. */
    rootDir?: string;
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
export declare function composeBrief(input: BriefInput): string;
