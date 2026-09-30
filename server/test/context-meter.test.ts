import { describe, it, expect } from "vitest";
import { summarise, sessionSpans } from "../src/context/meter.js";

const row = (sessionId: string, ts: string, over: Partial<{
  turns: number; sidechain: number; ctxSum: number; prefix: number;
  bandTokens: { under150k: number; to300k: number; to500k: number; over500k: number };
}> = {}) => ({
  ts,
  session_id: sessionId,
  cache_read_tokens: over.ctxSum ?? 0,
  context: {
    turns: over.turns ?? 10,
    turns_sidechain: over.sidechain ?? 0,
    ctx_sum: over.ctxSum ?? 1_000_000,
    prefix_tokens: over.prefix ?? 40_000,
    bands: { under150k: 5, to300k: 3, to500k: 2, over500k: 0 },
    ...(over.bandTokens ? { band_tokens: over.bandTokens } : {}),
    residency: { tool_result: 800, tool_call: 200 },
  },
});

describe("context meter", () => {
  it("takes the latest row per session — rows are cumulative", () => {
    const out = summarise([
      row("s1", "2026-09-01T10:00:00Z", { turns: 5, ctxSum: 500_000 }),
      row("s1", "2026-09-01T11:00:00Z", { turns: 20, ctxSum: 4_000_000 }),
    ]);
    expect(out.sessions).toBe(1);
    expect(out.turns).toBe(20);
    expect(out.rent).toBe(4_000_000);
  });

  it("reports average context per turn and the sidechain turn share", () => {
    const out = summarise([
      row("s1", "2026-09-01T10:00:00Z", { turns: 10, sidechain: 6, ctxSum: 2_000_000 }),
    ]);
    expect(out.avgContextPerTurn).toBe(200_000);
    expect(out.sidechainTurnShare).toBeCloseTo(0.6);
  });

  it("aggregates residency across sessions", () => {
    const out = summarise([
      row("s1", "2026-09-01T10:00:00Z"),
      row("s2", "2026-09-01T10:00:00Z"),
    ]);
    expect(out.residency).toEqual({ tool_result: 1600, tool_call: 400 });
  });

  it("survives rows written before the context field existed", () => {
    const out = summarise([
      { ts: "2026-08-01T10:00:00Z", session_id: "old", cache_read_tokens: 5_000 },
    ]);
    expect(out.sessions).toBe(1);
    expect(out.turns).toBe(0);
    expect(out.avgContextPerTurn).toBe(0);
  });

  it("derives session spans from first and last row timestamps", () => {
    const spans = sessionSpans([
      row("s1", "2026-09-01T10:00:00Z", { ctxSum: 100 }),
      row("s1", "2026-09-01T12:00:00Z", { ctxSum: 900 }),
    ]);
    expect(spans).toEqual([
      { sessionId: "s1", startedAt: "2026-09-01T10:00:00Z",
        endedAt: "2026-09-01T12:00:00Z", rent: 900, rentBasis: "ctx_sum" },
    ]);
  });
});

// `bands` counts TURNS; a high band costs far more per turn, so dividing the
// counts understates it. The share must come from the summed tokens whenever
// a row carries them, and say so when it cannot.
describe("band share is rent, not turns", () => {
  it("divides summed band tokens, not turn counts, when band_tokens is present", () => {
    // 5 low turns carrying 100k each = 500k; 2 high turns carrying 4M each
    // = 8M. By turns the high band is 2/10 = 20%; by tokens it is 8/8.5 = 94%.
    const out = summarise([
      row("s1", "2026-09-01T10:00:00Z", {
        bandTokens: { under150k: 500_000, to300k: 0, to500k: 0, over500k: 8_000_000 },
      }),
    ]);
    expect(out.bandShare.basis).toBe("tokens");
    expect(out.bandRentShare.over500k).toBeCloseTo(8 / 8.5, 5);
    expect(out.bandRentShare.under150k).toBeCloseTo(0.5 / 8.5, 5);
    // The turn share stays visible beside it, and disagrees -- on purpose.
    expect(out.bandShare.turnShare.over500k).toBe(0);
    expect(out.bandShare.turnShare.under150k).toBeCloseTo(0.5);
  });

  it("falls back to the turn share for rows written before band_tokens, visibly", () => {
    const out = summarise([row("old", "2026-09-01T10:00:00Z")]);
    expect(out.bandShare).toMatchObject({
      basis: "turns", tokenSessions: 0, turnOnlySessions: 1,
    });
    expect(out.bandRentShare).toEqual(out.bandShare.turnShare);
    expect(out.bandRentShare.under150k).toBeCloseTo(0.5);
  });

  it("reports the session mix when both row generations are present", () => {
    const out = summarise([
      row("new", "2026-09-01T10:00:00Z", {
        bandTokens: { under150k: 1_000, to300k: 0, to500k: 0, over500k: 0 },
      }),
      row("old", "2026-09-01T10:00:00Z"),
    ]);
    expect(out.bandShare).toMatchObject({
      basis: "tokens", tokenSessions: 1, turnOnlySessions: 1,
    });
  });

  it("reports no basis at all when nothing carries a band", () => {
    const out = summarise([
      { ts: "2026-08-01T10:00:00Z", session_id: "ancient", cache_read_tokens: 5 },
    ]);
    expect(out.bandShare.basis).toBe("none");
  });
});

// `rent` sums two different measurements. The report must say how much of it
// came from each, because the fallback quantity is strictly smaller.
describe("rent basis is declared, never coerced", () => {
  it("splits ctx_sum sessions from cache_read fallback sessions", () => {
    const out = summarise([
      row("full", "2026-09-01T10:00:00Z", { ctxSum: 2_000_000 }),
      { ts: "2026-08-01T10:00:00Z", session_id: "legacy", cache_read_tokens: 5_000 },
    ]);
    expect(out.rent).toBe(2_005_000);
    expect(out.rentBasis).toEqual({
      ctxSumSessions: 1, ctxSumRent: 2_000_000,
      cacheReadSessions: 1, cacheReadRent: 5_000,
    });
  });

  it("labels each span with the quantity its rent actually is", () => {
    const spans = sessionSpans([
      { ts: "2026-08-01T10:00:00Z", session_id: "legacy", cache_read_tokens: 5_000 },
    ]);
    expect(spans[0]).toMatchObject({ rent: 5_000, rentBasis: "cache_read" });
  });
});

// The rollup and the span ends must agree on which row is last, even when a
// row's stamp is corrupt -- two rules could pick two different rows.
describe("one latest-row rule", () => {
  it("summarise and sessionSpans pick the same row when a ts is unparseable", () => {
    const rows = [
      row("s1", "2026-09-01T10:00:00Z", { ctxSum: 100, turns: 1 }),
      row("s1", "not-a-timestamp", { ctxSum: 999, turns: 99 }),
      row("s1", "2026-09-01T12:00:00Z", { ctxSum: 900, turns: 9 }),
    ];
    const out = summarise(rows);
    const spans = sessionSpans(rows);
    expect(out.rent).toBe(900);
    expect(out.turns).toBe(9);
    expect(spans[0]).toMatchObject({
      startedAt: "2026-09-01T10:00:00Z", endedAt: "2026-09-01T12:00:00Z", rent: 900,
    });
  });

  it("keeps a session visible when every one of its stamps is corrupt", () => {
    const rows = [row("s1", "nonsense", { ctxSum: 42 })];
    expect(summarise(rows).sessions).toBe(1);
    expect(sessionSpans(rows)).toHaveLength(1);
  });
});
