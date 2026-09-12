import { describe, it, expect } from "vitest";
import {
  dedupFindings,
  LINE_WINDOW,
  CLAIM_SIMILARITY_THRESHOLD,
  type SeatFinding,
} from "../src/seats/dedup.js";

// Shorthand builder — a valid finding with per-test overrides.
function f(over: Partial<SeatFinding> = {}): SeatFinding {
  return {
    seat: "correctness",
    file: "src/app.ts",
    line: 42,
    claim: "unchecked null return from lookup",
    severity: "important",
    ...over,
  };
}

// Deterministic-enough shuffle for the determinism case — fixed seed LCG,
// no randomness in the test itself.
function shuffled<T>(items: T[], seed: number): T[] {
  const arr = [...items];
  let s = seed;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

describe("seats/dedup", () => {
  it("exposes the documented merge-rule constants", () => {
    expect(LINE_WINDOW).toBe(2);
    expect(CLAIM_SIMILARITY_THRESHOLD).toBe(0.5);
  });

  it("passes through empty and single-finding input", () => {
    expect(dedupFindings([])).toEqual([]);

    const only = f({ score: 7 });
    const out = dedupFindings([only]);
    expect(out).toEqual([
      {
        file: "src/app.ts",
        line: 42,
        claim: "unchecked null return from lookup",
        severity: "important",
        seats: [{ seat: "correctness", score: 7 }],
      },
    ]);
  });

  it("merges exact duplicates, crediting every seat and keeping max severity", () => {
    const out = dedupFindings([
      f({ seat: "correctness", severity: "important", score: 6 }),
      f({ seat: "security", severity: "critical", score: 3 }),
      f({ seat: "tests", severity: "minor", score: 8 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("critical");
    expect(out[0].seats).toEqual([
      { seat: "correctness", score: 6 },
      { seat: "security", score: 3 },
      { seat: "tests", score: 8 },
    ]);
  });

  it("merges within the ±2 line window, anchored at the lowest line", () => {
    const out = dedupFindings([
      f({ seat: "correctness", line: 42 }),
      f({ seat: "security", line: 44 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(42);
    expect(out[0].seats.map((s) => s.seat)).toEqual(["correctness", "security"]);
  });

  it("does not merge beyond the window, and chains never drift past the anchor", () => {
    // 42 and 44 merge; 46 is within 2 of 44 but 4 from the anchor — stays out.
    const out = dedupFindings([
      f({ seat: "correctness", line: 42 }),
      f({ seat: "security", line: 44 }),
      f({ seat: "tests", line: 46 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].line).toBe(42);
    expect(out[0].seats).toHaveLength(2);
    expect(out[1].line).toBe(46);
    expect(out[1].seats).toEqual([{ seat: "tests" }]);
  });

  it("merges paraphrased claims above the token-overlap threshold", () => {
    const out = dedupFindings([
      f({ seat: "correctness", claim: "unchecked null return from lookup" }),
      f({ seat: "security", claim: "null return from lookup is unchecked!" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].seats.map((s) => s.seat)).toEqual(["correctness", "security"]);
  });

  it("keeps distinct claims at the same location separate", () => {
    const out = dedupFindings([
      f({ seat: "correctness", claim: "off-by-one in the loop bound" }),
      f({ seat: "security", claim: "user input reaches exec without escaping" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.seats.length)).toEqual([1, 1]);
  });

  it("keeps the highest-severity finding's claim as canonical", () => {
    const out = dedupFindings([
      f({
        seat: "tests",
        severity: "minor",
        claim: "unchecked null return from lookup",
      }),
      f({
        seat: "security",
        severity: "critical",
        claim: "lookup null return unchecked, crashes the handler",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].claim).toBe("lookup null return unchecked, crashes the handler");
    expect(out[0].severity).toBe("critical");
  });

  it("preserves score attribution per seat, absent scores staying absent", () => {
    const out = dedupFindings([
      f({ seat: "correctness", score: 4 }),
      f({ seat: "security" }), // unscored seat
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].seats).toEqual([
      { seat: "correctness", score: 4 },
      { seat: "security" },
    ]);
    expect("score" in out[0].seats[1]).toBe(false);
  });

  it("orders output by file, then line, then severity", () => {
    const out = dedupFindings([
      f({ file: "src/z.ts", line: 5, claim: "z claim" }),
      f({ file: "src/a.ts", line: 90, claim: "later line" }),
      f({ file: "src/a.ts", line: 10, severity: "minor", claim: "minor here" }),
      f({
        file: "src/a.ts",
        line: 10,
        severity: "critical",
        claim: "totally different critical claim",
      }),
    ]);
    expect(
      out.map((d) => [d.file, d.line, d.severity]),
    ).toEqual([
      ["src/a.ts", 10, "critical"],
      ["src/a.ts", 10, "minor"],
      ["src/a.ts", 90, "important"],
      ["src/z.ts", 5, "important"],
    ]);
  });

  it("is deterministic under shuffled input", () => {
    const findings: SeatFinding[] = [
      f({ seat: "correctness", line: 42, severity: "important", score: 6 }),
      f({ seat: "security", line: 43, severity: "critical", score: 2 }),
      f({ seat: "tests", line: 44, severity: "minor" }),
      f({ file: "src/other.ts", seat: "clarity", line: 7, claim: "name lies" }),
      f({ line: 42, seat: "architecture", claim: "wrong layer owns lookup" }),
    ];

    const baseline = dedupFindings(findings);
    for (const seed of [1, 7, 1337]) {
      expect(dedupFindings(shuffled(findings, seed))).toEqual(baseline);
    }
  });
});
