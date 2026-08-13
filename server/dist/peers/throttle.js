/**
 * Purpose: resource-aware peer fan-out budget (#75) — how many peer CLIs
 * may run at once on this host. A live council dispatched 16 concurrent
 * peer processes and exhausted the laptop's memory (observed 2026-08-12);
 * each peer CLI is a full agent process, not a lightweight request, so the
 * budget reserves a real seat's worth of RAM per peer. Pure function with
 * injectable inputs — os.freemem()/os.cpus() only as defaults — so the
 * matrix is testable without faking the host.
 * Author(s): John Reed
 */
import { freemem, cpus } from "node:os";
// 750MB per seat: each peer CLI boots a full agent runtime (Node/Go binary,
// model client, working context) — live observation on 2026-08-12 put a
// working peer process in the 500MB-1GB range, so 750MB is the planning
// number that keeps a burst of seats from paging the host to death.
const BYTES_PER_SEAT = 750 * 1024 * 1024;
// Never fan out wider than this even on a huge host — beyond 8 concurrent
// peers the bottleneck is judgment (someone has to read all that), not RAM.
const HARD_CAP = 8;
/**
 * Computes how many peer CLI processes may run concurrently.
 *
 * budget = min(cores - 1, floor(freeMem / 750MB), 8), floored at 1 — one
 * core stays reserved for the host/server itself, memory pays 750MB per
 * seat, and the hard cap keeps huge hosts sane. An explicit `override`
 * (peerFanout.maxConcurrent from cairn.json) wins entirely when set —
 * the user's call beats the heuristic — but still floors at 1.
 *
 * :param opts.freeMemBytes: free memory in bytes (default os.freemem())
 * :param opts.cores: logical core count (default os.cpus().length)
 * :param opts.override: config-declared budget — wins outright when set
 * :returns: max concurrent peer processes, always >= 1
 */
export function concurrencyBudget(opts) {
    if (opts?.override !== undefined)
        return Math.max(1, Math.floor(opts.override));
    const freeMemBytes = opts?.freeMemBytes ?? freemem();
    const cores = opts?.cores ?? cpus().length;
    const budget = Math.min(cores - 1, Math.floor(freeMemBytes / BYTES_PER_SEAT), HARD_CAP);
    return Math.max(1, budget);
}
