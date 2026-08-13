/**
 * Purpose: the convergence memory for a peers run — a per-run store under
 * .cairn/peers/<slug>/ that survives interruption. state.json is the index
 * (meta, which peer answered which round, findings with verdicts); the raw
 * peer outputs live in per-peer files beside it and are never re-read into
 * state. An interrupted run resumes from runStatus's report of what's
 * missing, and runClose is where audit provenance comes from — assembled
 * from the RECORDS, not from whatever the interrupted conversation
 * remembered.
 * Author(s): John Reed
 */
import { type Finding } from "./findings.js";
export declare const VERDICTS: readonly ["verified", "dead", "disputed", "open-disagreement"];
export type Verdict = (typeof VERDICTS)[number];
export interface RunMeta {
    mode: "review" | "plan" | "council";
    target: string;
    focus?: string;
    peers: string[];
    startedAt: string;
    closedAt?: string;
    abandonedAt?: string;
}
export interface OutputRecord {
    peer: string;
    round: number;
    file: string;
    recordedAt: string;
}
export interface FindingRecord {
    id: string;
    peer: string;
    round: number;
    finding: Finding;
    verdict?: Verdict;
    note?: string;
}
interface RunState {
    meta: RunMeta;
    outputs: OutputRecord[];
    findings: FindingRecord[];
}
export interface RunResumable {
    peersMissingRound1: string[];
    disputedAwaitingRound2: string[];
    unresolved: string[];
    complete: boolean;
}
export interface RunStatusReport {
    slug: string;
    meta: RunMeta;
    outputs: OutputRecord[];
    findings: FindingRecord[];
    resumable: RunResumable;
}
export interface CloseSummary {
    slug: string;
    verdict: "pass" | "findings";
    findings: Array<{
        severity: Finding["severity"];
        title: string;
        detail: string;
    }>;
    peers: string[];
    roundsRun: number;
    closedAt: string;
    /** Rostered peers with no round-1 output — present only on a close that
     *  went through with allowIncomplete, so provenance shows the degradation
     *  was deliberate. */
    incompleteSeats?: string[];
}
/**
 * Creates the run dir and state.json for a new convergence run. An
 * UNFINISHED run already sitting on the slug is a hard stop — the caller
 * resumes it (runStatus) or abandons it (runAbandon) explicitly; nothing
 * here silently clobbers in-flight work. A finished (closed/abandoned)
 * run gets wiped, raw outputs and all, and the slug starts fresh.
 *
 * :param projectDir: project root the .cairn tree lives under
 * :param slug: run identity — slugged like review's scopes (lowercase,
 *              non-[a-z0-9] runs collapse to one hyphen)
 * :param meta: mode/target/focus plus the peer roster for the run
 * :returns: { slug, state } with the normalized slug
 * :raises CairnError: CONFIG_INVALID on an unfinished run or bad meta
 */
export declare function runStart(projectDir: string, slug: string, meta: {
    mode: "review" | "plan" | "council";
    target: string;
    focus?: string;
    peers: string[];
}): {
    slug: string;
    state: RunState;
};
/**
 * Marks an unfinished run abandoned — its slug becomes startable again.
 * Raw outputs stay on disk until the next runStart wipes them.
 */
export declare function runAbandon(projectDir: string, slug: string): {
    slug: string;
    abandonedAt: string;
};
/**
 * Stores one peer's raw reply for a round, verbatim, in
 * <peer>.round<N>.txt beside state.json — big and write-once, never
 * folded into the index. Re-recording the same peer+round overwrites
 * (a retried send supersedes the interrupted one).
 */
export declare function recordPeerOutput(projectDir: string, slug: string, peer: string, round: number, rawOutput: string): OutputRecord;
/**
 * Enters parsed findings into the run under stable ids (f1, f2, ... —
 * assigned in arrival order, never reused), tagged with the peer and
 * round that raised them. Validation is all-or-nothing per call: one bad
 * finding rejects the batch so ids never end up half-assigned.
 *
 * Idempotent per peer+round: a repeat call REPLACES that peer's prior
 * findings for the round (a retried parse supersedes the interrupted
 * one, mirroring recordPeerOutput). A finding whose claim matches one
 * of the replaced batch keeps its id, verdict, and note; a genuinely
 * new claim gets a fresh id that has never been used on the run. Other
 * peers' and rounds' findings are untouched.
 *
 * :returns: { ids } — the assigned ids, in the order given
 */
export declare function recordFindings(projectDir: string, slug: string, peer: string, round: number, findings: Finding[]): {
    ids: string[];
};
/**
 * Sets a finding's verdict, with the transitions validated: anything can
 * be judged once; `disputed` may move on to verified/dead/
 * open-disagreement (that's convergence working); verified and dead are
 * TERMINAL — changing one is CONFIG_INVALID, re-stating the same verdict
 * is a harmless no-op (the note may still update).
 */
export declare function recordVerdict(projectDir: string, slug: string, findingId: string, verdict: Verdict, note?: string): FindingRecord;
/**
 * The resume map: everything recorded so far, plus what's still missing —
 * peers with no round-1 output, disputed findings whose peer hasn't
 * answered round 2 yet, and findings not yet at a final verdict. An
 * interrupted run picks up exactly here instead of re-running peers that
 * already answered.
 */
export declare function runStatus(projectDir: string, slug: string): RunStatusReport;
/**
 * Ends the run: every finding must sit at a FINAL verdict (verified,
 * dead, or open-disagreement — disputed and unjudged both block), then
 * closedAt is stamped and the provenance summary comes back shaped for
 * audit_record's findings[] — title from the claim, detail assembled
 * from the records ("raised by <peer> round <n>; verdict <v>"), dead
 * findings included so the record credits what got thrown out. Overall
 * verdict is "findings" iff anything survived (verified or
 * open-disagreement).
 *
 * A rostered peer with no round-1 output is a SILENT SEAT — closing over
 * one hides a reviewer that never answered, so it refuses (CONFIG_INVALID
 * naming the seats) unless the caller passes allowIncomplete, which closes
 * anyway and stamps the summary's incompleteSeats so provenance shows the
 * degradation was deliberate. allowIncomplete never waives unresolved
 * findings — those always block.
 */
export declare function runClose(projectDir: string, slug: string, opts?: {
    allowIncomplete?: boolean;
}): CloseSummary;
export {};
