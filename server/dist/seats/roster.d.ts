/**
 * Purpose: seat roster resolution — shipped defaults (templates/seats/ in
 * the plugin) merged with project seats (.cairn/roles/, a read path only:
 * the server never writes there), then filtered/ordered by cairn.json's
 * optional `seats` block. Per-file tolerance is the design center: one bad
 * seat file skips that seat with a note, never the roster.
 * Author(s): John Reed
 */
import { type Seat } from "./schema.js";
export interface RosterSeat {
    /** Seat name (frontmatter `name` when valid, file stem when not). */
    name: string;
    source: "default" | "project";
    /** False means the definition failed validation — skipped, never fatal. */
    valid: boolean;
    note?: string;
    /** Validated definition — present only when valid. */
    seat?: Seat;
    /** The lens prose below the frontmatter — present only when valid. */
    body?: string;
    /** Where the definition file lives. */
    path: string;
}
export interface Roster {
    seats: RosterSeat[];
    /** Roster-level advisories (e.g. an enabled name that matched nothing). */
    notes: string[];
}
/**
 * Resolves the merged seat roster for a project.
 *
 * Resolution rules:
 * - shipped defaults load from templates/seats/ (filename order), project
 *   seats from .cairn/roles/ — a project seat whose NAME matches a default
 *   replaces it in place (source flips to "project"); a new name appends
 * - a duplicate name within the same source keeps the first file; the later
 *   one lands as valid:false with a note
 * - an invalid file never shadows anything — the seat it would have defined
 *   is skipped with a note, the roster still loads
 * - cairn.json's optional `seats` block then filters/orders: `enabled`
 *   picks the roster (in its order; unknown names become roster notes),
 *   `disabled` removes names; absent block = every default enabled, i.e.
 *   today's behavior
 *
 * :param projectDir: project root (must hold cairn.json)
 * :param rootDir: plugin root override — test seam for the shipped dir
 * :returns: the resolved roster, invalid entries included for visibility
 */
export declare function loadRoster(projectDir: string, rootDir?: string): Roster;
