import { describe, it, expect } from "vitest";
import { summarise, sessionSpans } from "../src/context/meter.js";

const row = (sessionId: string, ts: string, over: Partial<{
  turns: number; sidechain: number; ctxSum: number; prefix: number;
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
        endedAt: "2026-09-01T12:00:00Z", rent: 900 },
    ]);
  });
});
