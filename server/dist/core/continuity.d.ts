import { z } from "zod";
export declare function handoffPath(projectDir: string): string;
export declare function bannerPath(projectDir: string): string;
export interface Handoff {
    version: 1;
    created: string;
    source: "tool" | "posttooluse" | "precompact" | "waypoint";
    project: string;
    phase?: {
        number: number;
        slug: string;
    };
    issue?: string;
    plan?: string;
    task: {
        current: string;
        title: string;
    };
    tasks_completed: string[];
    tasks_remaining: string[];
    blockers: string[];
    decisions_in_flight: string[];
    uncommitted_files: string[];
    next_action: string;
    notes: string;
    partial: boolean;
}
export declare const HandoffSchema: z.ZodType<Handoff>;
/**
 * Reads the project's handoff. Never errors the session for staleness -- callers
 * get `stale: true` and decide what to do with it. Invalid JSON/schema still
 * throws HANDOFF_INVALID, since that's a corrupt file, not a stale one.
 */
export declare function readHandoff(projectDir: string): {
    handoff: Handoff;
    stale: boolean;
} | null;
/**
 * Merges `patch` over the existing handoff (or a blank skeleton) and writes it
 * atomically. Two guards keep this safe to call from hot paths like PostToolUse:
 *  - unregistered guard: no loadable cairn.json -> skip silently, never scaffold.
 *  - skeleton guard: richness is monotonic between clears -- a write can't
 *    replace a rich handoff (task.current or next_action non-empty) with an
 *    empty one. clearHandoff() is the explicit way to wipe a handoff.
 */
export declare function writeHandoff(projectDir: string, patch: Partial<Handoff> & {
    source: Handoff["source"];
}): void;
/** Deletes the project's handoff file, if any. Returns whether one existed. */
export declare function clearHandoff(projectDir: string): boolean;
