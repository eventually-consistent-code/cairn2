import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CairnError } from "../src/errors.js";
import type { Finding } from "../src/peers/findings.js";
import {
  runStart, runAbandon, runStatus, runClose,
  recordPeerOutput, recordFindings, recordVerdict,
} from "../src/peers/state.js";


// A known-good finding, reused across the matrix.
const GOOD: Finding = {
  claim: "unbounded retry loop on 429",
  evidence: "src/tracker/github.ts:112",
  evidenceType: "file-line",
  severity: "important",
  recommendation: "cap retries at 3 with backoff",
  axis: "correctness",
};

const META = {
  mode: "review" as const,
  target: "feat/phase-10",
  focus: "error handling",
  peers: ["codex", "grok"],
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "cairn-peers-state-"));
}

// Runs fn expecting a CairnError; returns its code (or a marker when it
// didn't throw / threw something else) so tests assert on codes plainly.
function errCode(fn: () => unknown): string {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    return e instanceof CairnError ? e.code : `not-cairn: ${String(e)}`;
  }
}


describe("runStart", () => {
  it("creates the run dir and a valid state.json with the meta", () => {
    const dir = freshDir();
    runStart(dir, "feat-phase-10", META);
    const statePath = join(dir, ".cairn", "peers", "feat-phase-10", "state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.meta.mode).toBe("review");
    expect(state.meta.target).toBe("feat/phase-10");
    expect(state.meta.peers).toEqual(["codex", "grok"]);
    expect(state.meta.startedAt).toBeTruthy();
    expect(state.meta.closedAt).toBeUndefined();
  });

  it("slugs like review does: lowercase, non-[a-z0-9] runs collapse to one hyphen", () => {
    const dir = freshDir();
    runStart(dir, "Feat/Phase 10!!", META);
    expect(existsSync(join(dir, ".cairn", "peers", "feat-phase-10", "state.json"))).toBe(true);
  });

  it("rejects a slug that collapses to nothing", () => {
    expect(errCode(() => runStart(freshDir(), "///", META))).toBe("CONFIG_INVALID");
  });

  it("throws CONFIG_INVALID when an UNFINISHED run exists for the slug", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    expect(errCode(() => runStart(dir, "x", META))).toBe("CONFIG_INVALID");
  });

  it("abandon then start is fine", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    runAbandon(dir, "x");
    expect(errCode(() => runStart(dir, "x", META))).toBe("no-throw");
  });

  it("a fresh start after a finished run wipes the prior run's raw outputs", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordPeerOutput(dir, "x", "codex", 1, "old run output");
    runAbandon(dir, "x");
    runStart(dir, "x", META);
    expect(existsSync(join(dir, ".cairn", "peers", "x", "codex.round1.txt"))).toBe(false);
  });

  it("rejects an empty peer roster and a path-hostile peer name", () => {
    expect(errCode(() => runStart(freshDir(), "x", { ...META, peers: [] })))
      .toBe("CONFIG_INVALID");
    expect(errCode(() => runStart(freshDir(), "x", { ...META, peers: ["../evil"] })))
      .toBe("CONFIG_INVALID");
  });
});


describe("runAbandon", () => {
  it("missing run is NOT_FOUND", () => {
    expect(errCode(() => runAbandon(freshDir(), "nope"))).toBe("NOT_FOUND");
  });

  it("abandoning an already-finished run is CONFIG_INVALID", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    runAbandon(dir, "x");
    expect(errCode(() => runAbandon(dir, "x"))).toBe("CONFIG_INVALID");
  });
});


describe("recordPeerOutput", () => {
  it("writes <peer>.round<N>.txt verbatim for rounds 1 and 2", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordPeerOutput(dir, "x", "codex", 1, "round one\nraw ```json``` bytes");
    recordPeerOutput(dir, "x", "codex", 2, "round two");
    const base = join(dir, ".cairn", "peers", "x");
    expect(readFileSync(join(base, "codex.round1.txt"), "utf8"))
      .toBe("round one\nraw ```json``` bytes");
    expect(readFileSync(join(base, "codex.round2.txt"), "utf8")).toBe("round two");
    const state = JSON.parse(readFileSync(join(base, "state.json"), "utf8"));
    expect(state.outputs.map((o: { peer: string; round: number }) => `${o.peer}:${o.round}`))
      .toEqual(["codex:1", "codex:2"]);
  });

  it("round 3 breaks the two-round cap: CONFIG_INVALID", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    expect(errCode(() => recordPeerOutput(dir, "x", "codex", 3, "out"))).toBe("CONFIG_INVALID");
  });

  it("a peer outside the run's roster is CONFIG_INVALID", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    expect(errCode(() => recordPeerOutput(dir, "x", "opencode", 1, "out"))).toBe("CONFIG_INVALID");
  });

  it("missing run is NOT_FOUND; a closed run refuses writes", () => {
    expect(errCode(() => recordPeerOutput(freshDir(), "nope", "codex", 1, "out"))).toBe("NOT_FOUND");
    const dir = freshDir();
    runStart(dir, "x", META);
    runAbandon(dir, "x");
    expect(errCode(() => recordPeerOutput(dir, "x", "codex", 1, "out"))).toBe("CONFIG_INVALID");
  });
});


describe("recordFindings", () => {
  it("assigns stable ids f1, f2, ... continuing across calls", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    const first = recordFindings(dir, "x", "codex", 1, [GOOD, { ...GOOD, claim: "second" }]);
    expect(first.ids).toEqual(["f1", "f2"]);
    const second = recordFindings(dir, "x", "grok", 1, [{ ...GOOD, claim: "third" }]);
    expect(second.ids).toEqual(["f3"]);
    const status = runStatus(dir, "x");
    expect(status.findings.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(status.findings[2].peer).toBe("grok");
    expect(status.findings[2].round).toBe(1);
  });

  it("rejects a finding that fails the schema", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    const bad = { claim: "no evidence or severity" } as unknown as Finding;
    expect(errCode(() => recordFindings(dir, "x", "codex", 1, [bad]))).toBe("CONFIG_INVALID");
  });
});


describe("recordVerdict", () => {
  function seeded(): { dir: string } {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    return { dir };
  }

  it("disputed can move to verified, dead, or open-disagreement", () => {
    for (const final of ["verified", "dead", "open-disagreement"] as const) {
      const { dir } = seeded();
      recordVerdict(dir, "x", "f1", "disputed");
      recordVerdict(dir, "x", "f1", final, "settled in round 2");
      const f = runStatus(dir, "x").findings[0];
      expect(f.verdict).toBe(final);
      expect(f.note).toBe("settled in round 2");
    }
  });

  it("verified and dead are terminal: any change is CONFIG_INVALID", () => {
    for (const terminal of ["verified", "dead"] as const) {
      const { dir } = seeded();
      recordVerdict(dir, "x", "f1", terminal);
      expect(errCode(() => recordVerdict(dir, "x", "f1", "disputed"))).toBe("CONFIG_INVALID");
      expect(errCode(() => recordVerdict(dir, "x", "f1", "open-disagreement")))
        .toBe("CONFIG_INVALID");
    }
  });

  it("an unknown verdict value is CONFIG_INVALID; unknown finding id is NOT_FOUND", () => {
    const { dir } = seeded();
    expect(errCode(() => recordVerdict(dir, "x", "f1", "maybe" as never))).toBe("CONFIG_INVALID");
    expect(errCode(() => recordVerdict(dir, "x", "f99", "verified"))).toBe("NOT_FOUND");
  });
});


describe("runStatus", () => {
  it("kill-sim: round 1 recorded for 2 of 3 peers -- status names the missing peer", () => {
    const dir = freshDir();
    runStart(dir, "x", { ...META, peers: ["codex", "opencode", "grok"] });
    recordPeerOutput(dir, "x", "codex", 1, "out");
    recordPeerOutput(dir, "x", "grok", 1, "out");
    const status = runStatus(dir, "x");
    expect(status.resumable.peersMissingRound1).toEqual(["opencode"]);
    expect(status.resumable.complete).toBe(false);
  });

  it("names disputed findings whose peer has no round-2 output yet", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordPeerOutput(dir, "x", "codex", 1, "out");
    recordPeerOutput(dir, "x", "grok", 1, "out");
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    recordVerdict(dir, "x", "f1", "disputed");
    let status = runStatus(dir, "x");
    expect(status.resumable.disputedAwaitingRound2).toEqual(["f1"]);
    recordPeerOutput(dir, "x", "codex", 2, "steelman reply");
    status = runStatus(dir, "x");
    expect(status.resumable.disputedAwaitingRound2).toEqual([]);
    // still not complete: f1 sits at disputed, unresolved
    expect(status.resumable.unresolved).toEqual(["f1"]);
    expect(status.resumable.complete).toBe(false);
  });

  it("missing run is NOT_FOUND", () => {
    expect(errCode(() => runStatus(freshDir(), "nope"))).toBe("NOT_FOUND");
  });
});


describe("runClose", () => {
  it("refuses to close while a disputed (or unjudged) finding remains", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordFindings(dir, "x", "codex", 1, [GOOD, { ...GOOD, claim: "second" }]);
    recordVerdict(dir, "x", "f1", "disputed");
    // f1 disputed, f2 never judged -- both block
    expect(errCode(() => runClose(dir, "x"))).toBe("CONFIG_INVALID");
  });

  it("assembles provenance from the records: title from claim, peer + round + verdict in detail", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordPeerOutput(dir, "x", "codex", 1, "out");
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    recordFindings(dir, "x", "grok", 2, [{ ...GOOD, claim: "grok's late catch", severity: "minor" }]);
    recordVerdict(dir, "x", "f1", "verified");
    recordVerdict(dir, "x", "f2", "dead", "code already guards this");
    const summary = runClose(dir, "x");

    expect(summary.verdict).toBe("findings");
    expect(summary.findings).toHaveLength(2);
    expect(summary.findings[0].title).toBe(GOOD.claim);
    expect(summary.findings[0].severity).toBe("important");
    expect(summary.findings[0].detail).toBe("raised by codex round 1; verdict verified");
    expect(summary.findings[1].detail)
      .toBe("raised by grok round 2; verdict dead -- code already guards this");

    const state = JSON.parse(readFileSync(
      join(dir, ".cairn", "peers", "x", "state.json"), "utf8"));
    expect(state.meta.closedAt).toBeTruthy();
  });

  it("all-dead findings close as a pass; the record still credits what got thrown out", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    recordVerdict(dir, "x", "f1", "dead");
    const summary = runClose(dir, "x");
    expect(summary.verdict).toBe("pass");
    expect(summary.findings).toHaveLength(1);
  });

  it("a closed run refuses further writes, and a new start on the slug is fine", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    runClose(dir, "x");
    expect(errCode(() => recordFindings(dir, "x", "codex", 1, [GOOD]))).toBe("CONFIG_INVALID");
    expect(errCode(() => runStart(dir, "x", META))).toBe("no-throw");
  });
});


describe("council mode (#71)", () => {
  it("runStart accepts mode 'council' and persists it", () => {
    const dir = freshDir();
    runStart(dir, "x", { ...META, mode: "council" as never });
    const state = JSON.parse(readFileSync(
      join(dir, ".cairn", "peers", "x", "state.json"), "utf8"));
    expect(state.meta.mode).toBe("council");
  });
});


describe("recordFindings idempotent re-record (#71)", () => {
  it("re-recording the same peer+round REPLACES that round's prior findings", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordFindings(dir, "x", "codex", 1, [GOOD, { ...GOOD, claim: "second" }]);
    recordFindings(dir, "x", "grok", 1, [{ ...GOOD, claim: "grok keeps" }]);
    recordVerdict(dir, "x", "f1", "verified");
    recordVerdict(dir, "x", "f2", "dead");

    // a retried parse re-records codex round 1: same first claim (updated
    // recommendation), a genuinely new second claim, "second" gone
    const re = recordFindings(dir, "x", "codex", 1, [
      { ...GOOD, recommendation: "updated rec" },
      { ...GOOD, claim: "brand new" },
    ]);
    expect(re.ids).toEqual(["f1", "f4"]);

    const findings = runStatus(dir, "x").findings;
    expect(findings.map((f) => f.id).sort()).toEqual(["f1", "f3", "f4"]);
    const f1 = findings.find((f) => f.id === "f1")!;
    // claim matched a prior finding: id AND verdict survive, body updates
    expect(f1.verdict).toBe("verified");
    expect(f1.finding.recommendation).toBe("updated rec");
    // the replaced finding's verdict went with it
    expect(findings.some((f) => f.finding.claim === "second")).toBe(false);
    // other peers' findings untouched
    const f3 = findings.find((f) => f.id === "f3")!;
    expect(f3.peer).toBe("grok");
    expect(f3.finding.claim).toBe("grok keeps");
    // genuinely new claim gets a fresh, never-reused id
    expect(findings.find((f) => f.id === "f4")!.verdict).toBeUndefined();
  });

  it("an identical repeat call is a no-op: same ids, same findings", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    const first = recordFindings(dir, "x", "codex", 1, [GOOD, { ...GOOD, claim: "second" }]);
    const again = recordFindings(dir, "x", "codex", 1, [GOOD, { ...GOOD, claim: "second" }]);
    expect(again.ids).toEqual(first.ids);
    expect(runStatus(dir, "x").findings).toHaveLength(2);
  });
});


describe("runClose seat completeness (#71)", () => {
  it("refuses to close while a rostered peer lacks a round-1 output, naming the seat", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordPeerOutput(dir, "x", "codex", 1, "out");
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    recordVerdict(dir, "x", "f1", "verified");
    let caught: unknown;
    try { runClose(dir, "x"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CairnError);
    expect((caught as CairnError).code).toBe("CONFIG_INVALID");
    expect((caught as CairnError).message).toContain("grok");
  });

  it("allowIncomplete closes anyway and stamps incompleteSeats for provenance", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordPeerOutput(dir, "x", "codex", 1, "out");
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    recordVerdict(dir, "x", "f1", "verified");
    const summary = (runClose as unknown as
      (d: string, s: string, o?: { allowIncomplete?: boolean }) => ReturnType<typeof runClose>)(
      dir, "x", { allowIncomplete: true });
    expect(summary.verdict).toBe("findings");
    expect((summary as { incompleteSeats?: string[] }).incompleteSeats).toEqual(["grok"]);
  });

  it("a complete run's summary carries no incompleteSeats field", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordPeerOutput(dir, "x", "codex", 1, "out");
    recordPeerOutput(dir, "x", "grok", 1, "out");
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    recordVerdict(dir, "x", "f1", "verified");
    const summary = runClose(dir, "x");
    expect((summary as { incompleteSeats?: string[] }).incompleteSeats).toBeUndefined();
  });

  it("allowIncomplete does NOT waive unresolved findings", () => {
    const dir = freshDir();
    runStart(dir, "x", META);
    recordPeerOutput(dir, "x", "codex", 1, "out");
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    expect(errCode(() => (runClose as unknown as
      (d: string, s: string, o?: { allowIncomplete?: boolean }) => unknown)(
      dir, "x", { allowIncomplete: true }))).toBe("CONFIG_INVALID");
  });
});


describe("atomicity", () => {
  it("state.json is valid JSON after every op and no .tmp files linger", () => {
    const dir = freshDir();
    const base = join(dir, ".cairn", "peers", "x");
    const check = () => {
      expect(() => JSON.parse(readFileSync(join(base, "state.json"), "utf8"))).not.toThrow();
      expect(readdirSync(base).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    };
    runStart(dir, "x", META);
    check();
    recordPeerOutput(dir, "x", "codex", 1, "out");
    check();
    recordFindings(dir, "x", "codex", 1, [GOOD]);
    check();
    recordVerdict(dir, "x", "f1", "verified");
    check();
    runClose(dir, "x");
    check();
  });
});
