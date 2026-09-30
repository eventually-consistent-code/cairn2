/**
 * Rollup over the metrics rows the Stop hook writes.
 *
 * Computes nothing the hook already computed: residency rides the hook's
 * existing forward pass, and re-deriving it here would read every transcript
 * a second time to learn what a row already says.
 *
 * Rows are CUMULATIVE per session -- the latest row for a session_id is that
 * session's whole record, and summing rows would multiply-count every one.
 */
import type { SessionSpan } from "./attribution.js";

type Bands = { under150k: number; to300k: number; to500k: number; over500k: number };

export interface MetricsRow {
  ts: string;
  session_id: string;
  cache_read_tokens?: number;
  context?: {
    turns: number;
    turns_sidechain: number;
    ctx_sum: number;
    prefix_tokens: number;
    /** TURNS per band. Every row that has a `context` field has these. */
    bands: Bands;
    /** Context TOKENS summed per band. Absent on rows written before it existed. */
    band_tokens?: Bands;
    residency: Record<string, number>;
  };
}

export interface MeterReport {
  sessions: number;
  turns: number;
  /**
   * Summed session rent -- see `rentBasis`. This is NOT one measurement: a
   * row carrying `context.ctx_sum` contributes Sigma(input + cache_write +
   * cache_read); an older row without it contributes `cache_read_tokens`
   * alone, which is strictly smaller. Reported as one total because it is
   * the total that was paid, with the mix declared beside it.
   */
  rent: number;
  /** How many sessions contributed which quantity to `rent`, and how much. */
  rentBasis: {
    ctxSumSessions: number;
    ctxSumRent: number;
    cacheReadSessions: number;
    cacheReadRent: number;
  };
  avgContextPerTurn: number;
  sidechainTurnShare: number;
  /**
   * Share of context spend by band. Divided from summed TOKENS when any
   * session carries `band_tokens`, and from turn COUNTS otherwise -- a turn
   * share understates the high bands, because a high-band turn costs more.
   * `bandShare.basis` says which one this is.
   */
  bandRentShare: Record<string, number>;
  /** Which quantity `bandRentShare` divided, and the count-based share always. */
  bandShare: {
    basis: "tokens" | "turns" | "none";
    tokenSessions: number;
    turnOnlySessions: number;
    turnShare: Record<string, number>;
  };
  residency: Record<string, number>;
  prefixTokens: { p50: number; max: number };
}

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
function orderedByTs(rows: MetricsRow[]): MetricsRow[] {
  const parseable = rows.filter((r) => !Number.isNaN(Date.parse(r.ts)));
  if (parseable.length === 0) return rows.slice(0, 1);
  return [...parseable].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** Rows grouped by session id, insertion-ordered. */
function bySession(rows: MetricsRow[]): Map<string, MetricsRow[]> {
  const out = new Map<string, MetricsRow[]>();
  for (const r of rows) {
    const list = out.get(r.session_id);
    if (list) list.push(r); else out.set(r.session_id, [r]);
  }
  return out;
}

/** Latest row per session id; a row with an unparseable ts loses to any other. */
function latestPerSession(rows: MetricsRow[]): MetricsRow[] {
  const out: MetricsRow[] = [];
  for (const list of bySession(rows).values()) {
    const ordered = orderedByTs(list);
    out.push(ordered[ordered.length - 1]);
  }
  return out;
}

/** Share of a total, per key; all zeros when the total is zero. */
function share(tally: Record<string, number>): Record<string, number> {
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    Object.entries(tally).map(([k, v]) => [k, total === 0 ? 0 : v / total]),
  );
}

/**
 * :param rows: metrics rows, any number per session
 * :returns the rollup across the latest row of each session
 */
export function summarise(rows: MetricsRow[]): MeterReport {
  const latest = latestPerSession(rows);
  let turns = 0;
  let sidechain = 0;
  let ctxSumRent = 0;
  let cacheReadRent = 0;
  let ctxSumSessions = 0;
  let cacheReadSessions = 0;
  let tokenSessions = 0;
  let turnOnlySessions = 0;
  const residency: Record<string, number> = {};
  const zeroed = () => ({ under150k: 0, to300k: 0, to500k: 0, over500k: 0 }) as Record<string, number>;
  const bandTurns = zeroed();
  const bandTokens = zeroed();
  const prefixes: number[] = [];

  for (const r of latest) {
    // Two different quantities, kept apart on the way in so the mix can be
    // reported instead of quietly averaged into one unlabelled number.
    if (r.context?.ctx_sum !== undefined) {
      ctxSumRent += r.context.ctx_sum;
      ctxSumSessions += 1;
    } else if (r.cache_read_tokens !== undefined) {
      cacheReadRent += r.cache_read_tokens;
      cacheReadSessions += 1;
    }
    const c = r.context;
    if (!c) continue;
    turns += c.turns;
    sidechain += c.turns_sidechain;
    if (c.prefix_tokens > 0) prefixes.push(c.prefix_tokens);
    for (const [k, v] of Object.entries(c.bands)) bandTurns[k] = (bandTurns[k] ?? 0) + v;
    if (c.band_tokens) {
      tokenSessions += 1;
      for (const [k, v] of Object.entries(c.band_tokens)) bandTokens[k] = (bandTokens[k] ?? 0) + v;
    } else {
      turnOnlySessions += 1;
    }
    for (const [k, v] of Object.entries(c.residency)) residency[k] = (residency[k] ?? 0) + v;
  }

  const rent = ctxSumRent + cacheReadRent;
  const turnShare = share(bandTurns);
  // Tokens win whenever any session has them: a band share divided from turn
  // counts systematically understates the expensive bands. Sessions that
  // predate `band_tokens` cannot be folded into that sum -- counts and tokens
  // are not the same unit -- so they contribute to `turnShare` only, and
  // `bandShare` says how many sessions sit on each side.
  const basis: "tokens" | "turns" | "none" = tokenSessions > 0
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
export function sessionSpans(rows: MetricsRow[]): SessionSpan[] {
  const spans: SessionSpan[] = [];
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
