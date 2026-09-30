/**
 * Rows of one session in timestamp order.
 *
 * A row whose `ts` cannot be parsed is dropped from the ordering rather than
 * sorted arbitrarily -- it can neither win "latest" nor become a span's
 * start. A session whose rows ALL have a bad stamp keeps its first row, so
 * the session stays visible rather than vanishing from the rollup.
 *
 * One rule, used by both the latest-row pick and the span ends, so the two
 * cannot disagree about which row is last.
 */
function orderedByTs(rows) {
    const parseable = rows.filter((r) => !Number.isNaN(Date.parse(r.ts)));
    if (parseable.length === 0)
        return rows.slice(0, 1);
    return [...parseable].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
/** Rows grouped by session id, insertion-ordered. */
function bySession(rows) {
    const out = new Map();
    for (const r of rows) {
        const list = out.get(r.session_id);
        if (list)
            list.push(r);
        else
            out.set(r.session_id, [r]);
    }
    return out;
}
/** Latest row per session id; a row with an unparseable ts loses to any other. */
function latestPerSession(rows) {
    const out = [];
    for (const list of bySession(rows).values()) {
        const ordered = orderedByTs(list);
        out.push(ordered[ordered.length - 1]);
    }
    return out;
}
/** Share of a total, per key; all zeros when the total is zero. */
function share(tally) {
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    return Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, total === 0 ? 0 : v / total]));
}
/**
 * :param rows: metrics rows, any number per session
 * :returns the rollup across the latest row of each session
 */
export function summarise(rows) {
    const latest = latestPerSession(rows);
    let turns = 0;
    let sidechain = 0;
    let ctxSumRent = 0;
    let cacheReadRent = 0;
    let ctxSumSessions = 0;
    let cacheReadSessions = 0;
    let tokenSessions = 0;
    let turnOnlySessions = 0;
    const residency = {};
    const zeroed = () => ({ under150k: 0, to300k: 0, to500k: 0, over500k: 0 });
    const bandTurns = zeroed();
    const bandTokens = zeroed();
    const prefixes = [];
    for (const r of latest) {
        // Two different quantities, kept apart on the way in so the mix can be
        // reported instead of quietly averaged into one unlabelled number.
        if (r.context?.ctx_sum !== undefined) {
            ctxSumRent += r.context.ctx_sum;
            ctxSumSessions += 1;
        }
        else if (r.cache_read_tokens !== undefined) {
            cacheReadRent += r.cache_read_tokens;
            cacheReadSessions += 1;
        }
        const c = r.context;
        if (!c)
            continue;
        turns += c.turns;
        sidechain += c.turns_sidechain;
        if (c.prefix_tokens > 0)
            prefixes.push(c.prefix_tokens);
        for (const [k, v] of Object.entries(c.bands))
            bandTurns[k] = (bandTurns[k] ?? 0) + v;
        if (c.band_tokens) {
            tokenSessions += 1;
            for (const [k, v] of Object.entries(c.band_tokens))
                bandTokens[k] = (bandTokens[k] ?? 0) + v;
        }
        else {
            turnOnlySessions += 1;
        }
        for (const [k, v] of Object.entries(c.residency))
            residency[k] = (residency[k] ?? 0) + v;
    }
    const rent = ctxSumRent + cacheReadRent;
    const turnShare = share(bandTurns);
    // Tokens win whenever any session has them: a band share divided from turn
    // counts systematically understates the expensive bands. Sessions that
    // predate `band_tokens` cannot be folded into that sum -- counts and tokens
    // are not the same unit -- so they contribute to `turnShare` only, and
    // `bandShare` says how many sessions sit on each side.
    const basis = tokenSessions > 0
        ? "tokens"
        : turnOnlySessions > 0 ? "turns" : "none";
    const bandRentShare = basis === "tokens" ? share(bandTokens) : turnShare;
    prefixes.sort((a, b) => a - b);
    return {
        sessions: latest.length,
        turns,
        rent,
        rentBasis: { ctxSumSessions, ctxSumRent, cacheReadSessions, cacheReadRent },
        avgContextPerTurn: turns === 0 ? 0 : Math.round(rent / turns),
        sidechainTurnShare: turns === 0 ? 0 : sidechain / turns,
        bandRentShare,
        bandShare: { basis, tokenSessions, turnOnlySessions, turnShare },
        residency,
        prefixTokens: {
            p50: prefixes.length === 0 ? 0 : prefixes[Math.floor(prefixes.length / 2)],
            max: prefixes.length === 0 ? 0 : prefixes[prefixes.length - 1],
        },
    };
}
/**
 * Session spans for attribution: first and last row timestamp, and the rent
 * from the latest row (rows being cumulative, the latest one is the total).
 *
 * :param rows: metrics rows, any number per session
 * :returns one span per session id
 */
export function sessionSpans(rows) {
    const spans = [];
    for (const [sessionId, list] of bySession(rows)) {
        const sorted = orderedByTs(list);
        const last = sorted[sorted.length - 1];
        const ctxSum = last.context?.ctx_sum;
        spans.push({
            sessionId,
            startedAt: sorted[0].ts,
            endedAt: last.ts,
            rent: ctxSum ?? last.cache_read_tokens ?? 0,
            rentBasis: ctxSum !== undefined ? "ctx_sum" : "cache_read",
        });
    }
    return spans;
}
