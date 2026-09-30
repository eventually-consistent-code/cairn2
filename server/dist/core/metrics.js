/**
 * The metrics log's segment scheme, in one place (#237).
 *
 * The Stop hook segments the cost log instead of truncating it (#229): a full
 * segment is CLOSED by renaming it, and a fresh live segment takes over the
 * canonical name. Any reader that opens only the canonical name therefore sees
 * a truncated record the moment a project rotates for the first time -- and
 * reads that way silently, because a short file is indistinguishable from a
 * young one.
 *
 * Three readers learned to enumerate segments under #229 and two did not. This
 * module is the server's single copy, so the next reader inherits the
 * behaviour instead of reimplementing it. The hook scripts keep their own copy
 * in hooks/scripts/lib.mjs: hook scripts may never import server code, and
 * that boundary is the floor -- two copies, not one.
 *
 * The writer's naming rule lives in hooks/scripts/stop-costtracker.mjs. Change
 * it there and this must follow.
 */
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
/**
 * Every segment of the metrics log, oldest first, the live one last.
 *
 * The live segment keeps the canonical name; a closed one is
 * "<stem>.<stamp>.jsonl" with a fixed-width UTC stamp, so a plain lexical sort
 * is chronological order.
 *
 * :param current: path to the live segment (the canonical name)
 * :returns: absolute paths, oldest segment first, always including `current`
 */
export function metricsSegments(current) {
    const dir = dirname(current);
    const stem = basename(current).replace(/\.jsonl$/, "");
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [current]; // no metrics dir yet -- the live segment is the whole story
    }
    const closed = names
        .filter((n) => n !== `${stem}.jsonl` && n.startsWith(`${stem}.`) && n.endsWith(".jsonl"))
        .sort();
    return [...closed.map((n) => join(dir, n)), current];
}
