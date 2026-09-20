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

export interface MetricsRow {
  ts: string;
  session_id: string;
  cache_read_tokens?: number;
  context?: {
    turns: number;
    turns_sidechain: number;
    ctx_sum: number;
    prefix_tokens: number;
    bands: { under150k: number; to300k: number; to500k: number; over500k: number };
    residency: Record<string, number>;
  };
}

export interface MeterReport {
  sessions: number;
  turns: number;
  rent: number;
  avgContextPerTurn: number;
  sidechainTurnShare: number;
  bandRentShare: Record<string, number>;
  residency: Record<string, number>;
  prefixTokens: { p50: number; max: number };
}

/** Latest row per session id; a row with an unparseable ts loses to any other. */
function latestPerSession(rows: MetricsRow[]): MetricsRow[] {
  const best = new Map<string, MetricsRow>();
  for (const r of rows) {
    const prior = best.get(r.session_id);
    if (!prior) { best.set(r.session_id, r); continue; }
    const a = Date.parse(r.ts);
    const b = Date.parse(prior.ts);
    if (!Number.isNaN(a) && (Number.isNaN(b) || a >= b)) best.set(r.session_id, r);
  }
  return [...best.values()];
}

/**
 * :param rows: metrics rows, any number per session
 * :returns the rollup across the latest row of each session
 */
export function summarise(rows: MetricsRow[]): MeterReport {
  const latest = latestPerSession(rows);
  let turns = 0;
  let sidechain = 0;
  let rent = 0;
  const residency: Record<string, number> = {};
  const bandTurns: Record<string, number> = {
    under150k: 0, to300k: 0, to500k: 0, over500k: 0,
  };
  const prefixes: number[] = [];

  for (const r of latest) {
    rent += r.context?.ctx_sum ?? r.cache_read_tokens ?? 0;
    const c = r.context;
    if (!c) continue;
    turns += c.turns;
    sidechain += c.turns_sidechain;
    if (c.prefix_tokens > 0) prefixes.push(c.prefix_tokens);
    for (const [k, v] of Object.entries(c.bands)) bandTurns[k] = (bandTurns[k] ?? 0) + v;
    for (const [k, v] of Object.entries(c.residency)) residency[k] = (residency[k] ?? 0) + v;
  }

  const totalBandTurns = Object.values(bandTurns).reduce((a, b) => a + b, 0);
  const bandRentShare = Object.fromEntries(
    Object.entries(bandTurns).map(([k, v]) => [k, totalBandTurns === 0 ? 0 : v / totalBandTurns]),
  );
  prefixes.sort((a, b) => a - b);

  return {
    sessions: latest.length,
    turns,
    rent,
    avgContextPerTurn: turns === 0 ? 0 : Math.round(rent / turns),
    sidechainTurnShare: turns === 0 ? 0 : sidechain / turns,
    bandRentShare,
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
  const byId = new Map<string, MetricsRow[]>();
  for (const r of rows) {
    const list = byId.get(r.session_id);
    if (list) list.push(r); else byId.set(r.session_id, [r]);
  }
  const spans: SessionSpan[] = [];
  for (const [sessionId, list] of byId) {
    const sorted = [...list].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const last = sorted[sorted.length - 1];
    spans.push({
      sessionId,
      startedAt: sorted[0].ts,
      endedAt: last.ts,
      rent: last.context?.ctx_sum ?? last.cache_read_tokens ?? 0,
    });
  }
  return spans;
}
