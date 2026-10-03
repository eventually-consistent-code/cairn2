import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAuditRecords, parseAuditRecord, writeAuditRecord, type AuditFinding } from "../src/audit/record.js";
import { loadYield } from "../src/seats/yield.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-audit-"));
const today = new Date().toISOString().slice(0, 10);
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
/** A temp dir that is a git repo with one commit. */
function freshRepo(): string {
  const dir = fresh();
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "seed", "--no-gpg-sign");
  return dir;
}

describe("writeAuditRecord", () => {
  it("writes scope-date file with frontmatter and finding blocks", () => {
    const dir = fresh();
    const out = writeAuditRecord(dir, "uat-phase-1", "findings", [
      { severity: "critical", title: "checkout flow 500s on empty cart", issue: "GH-9",
        failure_scenario: "POST /checkout with cart=[] → 500 instead of 400",
        panel: [{ seat: "correctness", verdict: "CONFIRMED", evidence: "reproduced with an empty cart" }] },
      { severity: "minor", title: "settings copy stale",
        failure_scenario: "open /settings → footer still says 2025" },
    ]);
    expect(out.path).toBe(join(dir, ".cairn", "audit", `uat-phase-1-${today}.md`));
    expect(out.findings).toBe(2);
    const raw = readFileSync(out.path, "utf8");
    expect(raw).toContain("scope: uat-phase-1");
    expect(raw).toContain("verdict: findings");
    expect(raw).toContain("## finding — critical");
    expect(raw).toContain("scenario: POST /checkout with cart=[] → 500 instead of 400");
    expect(raw).toContain("outcome: confirmed");
    expect(raw).toContain("vote: correctness CONFIRMED — reproduced with an empty cart");
    expect(raw).toContain("issue: GH-9");
    expect(raw).toContain("## finding — minor");
  });

  it("refuses a finding without a typed failure_scenario (a hunch is not a finding)", () => {
    const dir = fresh();
    expect(() => writeAuditRecord(dir, "review-x", "findings",
      [{ severity: "critical", title: "boom" } as never])).toThrow(/failure_scenario/);
    expect(() => writeAuditRecord(dir, "review-x", "findings",
      [{ severity: "important", title: "boom", failure_scenario: "   " }])).toThrow(/hunch/);
    expect(existsSync(join(dir, ".cairn", "audit"))).toBe(false);
    // A clean pass is byte-for-byte the pre-phase-21 record — no findings, no field.
    const out = writeAuditRecord(dir, "review-x", "pass", []);
    expect(readFileSync(out.path, "utf8")).not.toContain("scenario:");
  });

  it("same scope+date overwrites; a different date is never touched", () => {
    const dir = fresh();
    const old = join(dir, ".cairn", "audit", "uat-phase-1-2020-01-01.md");
    writeAuditRecord(dir, "uat-phase-1", "pass", []);
    writeFileSync(old, "immutable history\n");
    writeAuditRecord(dir, "uat-phase-1", "findings",
      [{ severity: "important", title: "second run", failure_scenario: "rerun → new finding",
        panel: [{ seat: "tests", verdict: "PLAUSIBLE", evidence: "could not reproduce either way" }] }]);
    expect(readFileSync(old, "utf8")).toBe("immutable history\n");
    const rerun = readFileSync(join(dir, ".cairn", "audit", `uat-phase-1-${today}.md`), "utf8");
    expect(rerun).toContain("second run");
    expect(rerun).not.toContain("verdict: pass");
  });

  it("rejects an empty scope and a verdict/findings mismatch", () => {
    const dir = fresh();
    expect(() => writeAuditRecord(dir, "", "pass", [])).toThrow(/scope/);
    expect(() => writeAuditRecord(dir, "x", "pass",
      [{ severity: "critical", title: "boom", failure_scenario: "s" }])).toThrow(/verdict/);
  });

  it("stamps commit + dirty from git at write time; no stamp outside a repo", () => {
    const repo = freshRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const clean = writeAuditRecord(repo, "security", "pass", []);
    expect(clean.commit).toBe(head);
    expect(clean.dirty).toBe(false);
    const raw = readFileSync(clean.path, "utf8");
    expect(raw).toContain(`commit: ${head}`);
    expect(raw).toContain("dirty: false");
    expect(listAuditRecords(repo)[0]).toMatchObject({ scope: "security", commit: head, dirty: false });

    // An uncommitted change to a tracked file flips the flag; untracked noise does not.
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "scratch.txt"), "ignored\n");
    expect(writeAuditRecord(repo, "security-21", "pass", []).dirty).toBe(true);
    expect(listAuditRecords(repo).find((r) => r.scope === "security-21")?.dirty).toBe(true);

    // No git → no stamp, and the record still writes (pre-phase-21 shape).
    const plain = writeAuditRecord(fresh(), "review-x", "pass", []);
    expect(plain).not.toHaveProperty("commit");
    expect(readFileSync(plain.path, "utf8")).not.toContain("commit:");
  });

  describe("refutation panel (#196)", () => {
    const vote = (seat: string, verdict: "CONFIRMED" | "PLAUSIBLE" | "REFUTED") =>
      ({ seat, verdict, evidence: `${seat} checked it` });
    const finding = (over: Partial<import("../src/audit/record.js").AuditFinding> = {}) => ({
      severity: "important" as const, title: "lookup dereferences null",
      failure_scenario: "lookup(undefined) → null → TypeError", ...over,
    });

    it("quorum table: majority REFUTED dies; ties and lone PLAUSIBLE survive as plausible; more CONFIRMED confirms", () => {
      const dir = fresh();
      const out = writeAuditRecord(dir, "review-working", "findings", [
        finding({ title: "dies", panel: [vote("a", "REFUTED"), vote("b", "REFUTED"), vote("c", "CONFIRMED")] }),
        finding({ title: "tie", panel: [vote("a", "REFUTED"), vote("b", "CONFIRMED")] }),
        finding({ title: "lone plausible", panel: [vote("a", "PLAUSIBLE")] }),
        finding({ title: "confirmed", panel: [vote("a", "CONFIRMED"), vote("b", "CONFIRMED"), vote("c", "REFUTED")] }),
        finding({ title: "one refuted of one", panel: [vote("a", "REFUTED")] }),
      ]);
      expect(out.results.map((r) => [r.title, r.outcome, r.survived])).toEqual([
        ["dies", "refuted", false],
        ["tie", "plausible", true],
        ["lone plausible", "plausible", true],
        ["confirmed", "confirmed", true],
        ["one refuted of one", "refuted", false],
      ]);
      expect(out.findings).toBe(5);
      expect(out.survived).toBe(3);
      expect(out.refuted).toBe(2);
      const raw = readFileSync(out.path, "utf8");
      // Refuted findings stay IN the record, marked — the tracker never sees them.
      expect(raw).toContain("dies\nscenario:");
      expect(raw).toContain("refuted: true — not filed to the tracker");
      expect(raw).toContain("outcome: plausible");
    });

    it("critical/important need a panel (two votes on a security scope); minors don't", () => {
      const dir = fresh();
      expect(() => writeAuditRecord(dir, "review-working", "findings", [finding()]))
        .toThrow(/has 0 panel votes; scope 'review-working' needs 1/);
      expect(() => writeAuditRecord(dir, "security-21", "findings",
        [finding({ severity: "critical", panel: [vote("a", "CONFIRMED")] })]))
        .toThrow(/needs 2/);
      const ok = writeAuditRecord(dir, "security-21", "findings", [
        finding({ severity: "critical", panel: [vote("a", "CONFIRMED"), vote("b", "PLAUSIBLE")] }),
        finding({ severity: "minor", title: "nit" }),
      ]);
      expect(ok.results.map((r) => r.outcome)).toEqual(["confirmed", "unpanelled"]);
      expect(ok.survived).toBe(2);
      // A vote missing its evidence is a shape error, not a judgment.
      expect(() => writeAuditRecord(dir, "review-working", "findings",
        [finding({ panel: [{ seat: "a", verdict: "CONFIRMED", evidence: " " }] })])).toThrow(/evidence/);
    });

    it("staged patch (#197): apply-eligible only when survived AND all three claims are true", () => {
      const dir = fresh();
      const verifier = (over: Partial<{ targeted: boolean; no_new_issue: boolean; behavior_unchanged: boolean }> = {}) => ({
        seat: "correctness", evidence: "read the patch against the finding", testsRun: "server suite 1399 passed",
        claims: { targeted: true, no_new_issue: true, behavior_unchanged: true, ...over },
      });
      const out = writeAuditRecord(dir, "review-working", "findings", [
        finding({ title: "clean", panel: [vote("v", "CONFIRMED")], patch: { path: "fix/r1/194.patch", verifier: verifier() } }),
        finding({ title: "not targeted", panel: [vote("v", "CONFIRMED")], patch: { path: "fix/r1/195.patch", verifier: verifier({ targeted: false }) } }),
        finding({ title: "behavior moved", panel: [vote("v", "CONFIRMED")], patch: { path: "fix/r1/196.patch", verifier: verifier({ behavior_unchanged: false }) } }),
        finding({ title: "refuted with a patch", panel: [vote("v", "REFUTED")], patch: { path: "fix/r1/197.patch", verifier: verifier() } }),
        finding({ title: "no patch", panel: [vote("v", "CONFIRMED")] }),
      ]);
      expect(out.results.map((r) => [r.title, r.applyEligible])).toEqual([
        ["clean", true],
        ["not targeted", false],
        ["behavior moved", false],
        ["refuted with a patch", false],
        ["no patch", undefined],
      ]);
      const raw = readFileSync(out.path, "utf8");
      expect(raw).toContain("patch: fix/r1/194.patch");
      expect(raw).toContain("apply: eligible — on the user's choice");
      expect(raw).toContain("apply: blocked — claims not all true");
      expect(raw).toContain("patch verifier: correctness — targeted=false");
      // A patch without its verifier's claims is a shape error.
      expect(() => writeAuditRecord(dir, "review-working", "findings", [
        finding({ panel: [vote("v", "CONFIRMED")],
          patch: { path: "fix/r1/x.patch", verifier: { seat: "c", evidence: "e", testsRun: "t" } } as never }),
      ])).toThrow(/three boolean claims/);
    });

    it("credits raising seats' findingsSurvived only for panelled survivors", () => {
      const dir = fresh();
      const yieldBase = fresh();
      const out = writeAuditRecord(dir, "review-working", "findings", [
        finding({ title: "lives", seats: ["correctness", "security"], panel: [vote("v", "CONFIRMED")] }),
        finding({ title: "dies", seats: ["correctness"], panel: [vote("v", "REFUTED")] }),
        finding({ title: "minor unpanelled", severity: "minor", seats: ["clarity"] }),
      ], { yieldBaseDir: yieldBase });
      expect(out.note).toBeUndefined();
      const { state } = loadYield(dir, yieldBase);
      expect(state.seats.correctness).toEqual({ dispatched: 0, findingsRaised: 0, findingsSurvived: 1 });
      expect(state.seats.security).toEqual({ dispatched: 0, findingsRaised: 0, findingsSurvived: 1 });
      expect(state.seats.clarity).toBeUndefined();
    });
  });

  it("listAuditRecords returns scope/date/verdict sorted by path", () => {
    const dir = fresh();
    writeAuditRecord(dir, "review-diff", "pass", []);
    writeAuditRecord(dir, "uat-phase-1", "findings",
      [{ severity: "minor", title: "t", failure_scenario: "s" }]);
    const all = listAuditRecords(dir);
    expect(all).toHaveLength(2);
    expect(all[0].scope).toBe("review-diff");
    expect(all[1].verdict).toBe("findings");
  });
});

describe("sweep manifest + baseline delta (#215)", () => {
  const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const minor = (title: string, failure_scenario: string): AuditFinding =>
    ({ severity: "minor", title, failure_scenario });
  const NULL_DEREF = minor("lookup dereferences null", "lookup(undefined) returns null then the caller crashes with TypeError");
  const STALE_FOOTER = minor("settings footer is stale", "open /settings and the footer still says 2025");
  const RETRY_LOOP = minor("retry loop never backs off", "tracker 429 makes the client retry with zero delay forever");
  const commitCode = (repo: string, file: string) => {
    writeFileSync(join(repo, file), `${file}\n`);
    git(repo, "add", file); git(repo, "commit", "-q", "-m", `code ${file}`, "--no-gpg-sign");
  };
  /** Writes the two leg records, then a manifest over them. */
  function sweep(repo: string, date: string, sec: AuditFinding[], rev: AuditFinding[]) {
    const s = writeAuditRecord(repo, "security-25", sec.length ? "findings" : "pass", sec);
    const r = writeAuditRecord(repo, "review-working", rev.length ? "findings" : "pass", rev);
    const all = [...sec, ...rev];
    return writeAuditRecord(repo, `sweep-${date}`, all.length ? "findings" : "pass", all, {
      legs: [{ scope: "security-25", path: s.path }, { scope: "review-working", path: r.path }],
    });
  }

  it("first sweep: cairn + commit stamped, legs indexed, findings carry their leg, delta null", () => {
    const repo = freshRepo();
    const out = sweep(repo, "2026-01-01", [NULL_DEREF], [STALE_FOOTER]);
    expect(out.delta).toBeNull();
    const raw = readFileSync(out.path, "utf8");
    expect(raw).toContain(`cairn: ${VERSION}`);
    expect(raw).toContain(`commit: ${git(repo, "rev-parse", "HEAD")}`);
    expect(raw).toMatch(/^leg: security-25 => .*security-25-.*\.md$/m);
    expect(raw).toMatch(/^leg: review-working => .*review-working-.*\.md$/m);
    expect(raw).toContain("first baseline");
    expect(raw).toMatch(/lookup dereferences null\nscenario: [^\n]*\nsource leg: security-25/);
    expect(raw).toMatch(/settings footer is stale\nscenario: [^\n]*\nsource leg: review-working/);
  });

  it("two sweeps across a code commit: new / persisting (title and scenario) / fixed; a third re-raise is regressed", () => {
    const repo = freshRepo();
    const first = sweep(repo, "2026-01-01", [NULL_DEREF], [STALE_FOOTER]);
    commitCode(repo, "b.ts");

    // Same null-deref under a new headline + paraphrased scenario; footer gone; retry loop arrives.
    const renamed = minor("caller crashes on missing key",
      "lookup(undefined) returns null and the caller crashes with a TypeError");
    const second = sweep(repo, "2026-01-02", [renamed, RETRY_LOOP], []);
    const d2 = second.delta!;
    expect(d2.baseline).toMatchObject({ path: first.path, commit: first.commit, cairn: VERSION, created: today });
    expect(d2.codeCommitsSince).toBe(1);
    expect(d2.persisting.map((f) => f.title)).toEqual(["caller crashes on missing key"]);
    expect(d2.new.map((f) => f.title)).toEqual(["retry loop never backs off"]);
    expect(d2.fixed.map((f) => [f.title, f.leg])).toEqual([["settings footer is stale", "review-working"]]);
    expect(d2.regressed).toEqual([]);
    const raw2 = readFileSync(second.path, "utf8");
    expect(raw2).toContain(`## delta vs sweep-2026-01-01-${today}`);
    expect(raw2).toContain("code commits since: 1");
    expect(raw2).toContain("- fixed — minor: settings footer is stale\n  scenario: open /settings");

    // The footer comes back: fixed in sweep 2's own delta, present now -> regressed, not new.
    const third = sweep(repo, "2026-01-03", [renamed, RETRY_LOOP], [STALE_FOOTER]);
    const d3 = third.delta!;
    expect(d3.baseline.path).toBe(second.path);
    expect(d3.codeCommitsSince).toBe(0);
    expect(d3.regressed.map((f) => f.title)).toEqual(["settings footer is stale"]);
    expect(d3.new).toEqual([]);
    expect(d3.persisting.map((f) => f.title).sort()).toEqual(
      ["caller crashes on missing key", "retry loop never backs off"]);
    expect(d3.fixed).toEqual([]);
    expect(readFileSync(third.path, "utf8")).toContain("- regressed — minor: settings footer is stale");
  });

  it("refuted findings are neither carried nor compared; a non-sweep scope has no delta and refuses legs", () => {
    const repo = freshRepo();
    const killed: AuditFinding = { severity: "important", title: "phantom race",
      failure_scenario: "two writers interleave and lose an update",
      panel: [{ seat: "v", verdict: "REFUTED", evidence: "single writer by construction" }] };
    writeAuditRecord(repo, "sweep-2026-01-01", "findings", [killed, NULL_DEREF]);
    const second = writeAuditRecord(repo, "sweep-2026-01-02", "findings", [NULL_DEREF]);
    expect(second.delta).toMatchObject({ new: [], fixed: [], regressed: [] });
    expect(second.delta!.persisting.map((f) => f.title)).toEqual(["lookup dereferences null"]);

    const plain = writeAuditRecord(repo, "review-working", "pass", []);
    expect(plain).not.toHaveProperty("delta");
    expect(readFileSync(plain.path, "utf8")).not.toContain("cairn:");
    expect(() => writeAuditRecord(repo, "review-working", "pass", [],
      { legs: [{ scope: "x", path: "y.md" }] })).toThrow(/not sweep-/);
  });

  it("a sweep manifest credits no seat yield — its legs already did (#255)", () => {
    const repo = freshRepo();
    const yieldBase = fresh();
    const carried: AuditFinding = { severity: "important", title: "lookup dereferences null",
      failure_scenario: "lookup(undefined) returns null then the caller crashes with TypeError",
      seats: ["correctness"], panel: [{ seat: "v", verdict: "CONFIRMED", evidence: "reproduced" }] };
    const leg = writeAuditRecord(repo, "review-working", "findings", [carried], { yieldBaseDir: yieldBase });
    expect(loadYield(repo, yieldBase).state.seats.correctness?.findingsSurvived).toBe(1);
    const manifest = writeAuditRecord(repo, "sweep-2026-01-01", "findings", [carried],
      { yieldBaseDir: yieldBase, legs: [{ scope: "review-working", path: leg.path }] });
    expect(manifest.survived).toBe(1);
    expect(loadYield(repo, yieldBase).state.seats.correctness?.findingsSurvived).toBe(1);
  });

  describe("the manifest honours its legs' outcomes (#248)", () => {
    const vote = (seat: string, verdict: "CONFIRMED" | "PLAUSIBLE" | "REFUTED") =>
      ({ seat, verdict, evidence: `${seat} checked it` });
    const TOKEN_LEAK: AuditFinding = { severity: "critical", title: "Token leak",
      failure_scenario: "GITHUB_TOKEN echoed into the tracker comment body on adapter error",
      panel: [vote("a", "REFUTED"), vote("b", "REFUTED"), vote("c", "CONFIRMED")] };
    const SECRET_LOG: AuditFinding = { severity: "critical", title: "Secret in debug log",
      failure_scenario: "CAIRN debug logging prints the bearer header on a 401",
      panel: [vote("a", "CONFIRMED"), vote("b", "PLAUSIBLE")] };
    const STALE_CACHE: AuditFinding = { severity: "important", title: "Stale map cache",
      failure_scenario: "map_get after map_set returns the pre-write node",
      panel: [vote("a", "CONFIRMED")] };
    function legs(repo: string) {
      const s = writeAuditRecord(repo, "security-25", "findings", [TOKEN_LEAK, SECRET_LOG]);
      const r = writeAuditRecord(repo, "review-working", "findings", [STALE_CACHE]);
      return [{ scope: "security-25", path: s.path }, { scope: "review-working", path: r.path }];
    }

    it("refuses a finding its leg refuted, whatever panel the manifest carries", () => {
      const repo = freshRepo();
      const idx = legs(repo);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "findings",
        [{ ...TOKEN_LEAK, panel: [vote("a", "CONFIRMED")] }], { legs: idx }))
        .toThrow(/'Token leak' was refuted in leg 'security-25'/);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "findings",
        [{ ...TOKEN_LEAK, panel: [vote("a", "CONFIRMED"), vote("b", "CONFIRMED")] }], { legs: idx }))
        .toThrow(/refuted in leg/);
      expect(listAuditRecords(repo).some((r) => r.scope.startsWith("sweep-"))).toBe(false);
    });

    it("a security leg's two-vote bar travels with its findings; other legs keep theirs", () => {
      const repo = freshRepo();
      const idx = legs(repo);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "findings",
        [{ ...SECRET_LOG, panel: [vote("a", "CONFIRMED")] }], { legs: idx }))
        .toThrow(/has 1 panel vote; its leg 'security-25' needs 2/);
      // A leg mislabelled in the index still answers to its record's own scope.
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "findings",
        [{ ...SECRET_LOG, panel: [vote("a", "CONFIRMED")] }],
        { legs: [{ scope: "review-working", path: idx[0].path }] })).toThrow(/needs 2/);
      // Verbatim survivors — 2 votes from the security leg, 1 from review — are accepted.
      const ok = writeAuditRecord(repo, "sweep-2026-01-01", "findings", [SECRET_LOG, STALE_CACHE], { legs: idx });
      expect(ok.results.map((r) => [r.title, r.survived])).toEqual(
        [["Secret in debug log", true], ["Stale map cache", true]]);
      expect(readFileSync(ok.path, "utf8")).toMatch(/Stale map cache\nscenario: [^\n]*\nsource leg: review-working/);
    });

    it("refuses leg paths that aren't regular files under the audit dir", () => {
      const repo = freshRepo();
      const idx = legs(repo);
      const outside = join(repo, "a.txt");
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "pass", [],
        { legs: [{ scope: "x", path: outside }] })).toThrow(/outside the audit dir/);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "pass", [],
        { legs: [{ scope: "x", path: join(".cairn", "audit", "..", "..", "a.txt") }] })).toThrow(/outside/);
      const link = join(repo, ".cairn", "audit", "link.md");
      symlinkSync(outside, link);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "pass", [],
        { legs: [{ scope: "x", path: link }] })).toThrow(/not a regular file/);
      // A relative path under the audit dir, and a missing one, are both fine.
      const rel = idx[1].path.slice(repo.length + 1);
      expect(writeAuditRecord(repo, "sweep-2026-01-01", "findings", [STALE_CACHE],
        { legs: [{ scope: "review-working", path: rel },
          { scope: "gone", path: join(repo, ".cairn", "audit", "gone.md") }] }).survived).toBe(1);
    });
  });

  it("parseAuditRecord round-trips the writer's output", () => {
    const repo = freshRepo();
    const first = sweep(repo, "2026-01-01", [NULL_DEREF], [STALE_FOOTER]);
    const back = parseAuditRecord(first.path);
    expect(back.frontmatter).toMatchObject({ scope: "sweep-2026-01-01", verdict: "findings", cairn: VERSION });
    expect(back.legs.map((l) => l.scope)).toEqual(["security-25", "review-working"]);
    expect(back.findings).toEqual([
      { title: NULL_DEREF.title, severity: "minor", failure_scenario: NULL_DEREF.failure_scenario,
        outcome: "unpanelled", leg: "security-25" },
      { title: STALE_FOOTER.title, severity: "minor", failure_scenario: STALE_FOOTER.failure_scenario,
        outcome: "unpanelled", leg: "review-working" },
    ]);
    expect(back.notes).toEqual([]);

    // A panelled, refuted, detailed record reads back with its outcomes; detail is not parsed as keys.
    const dir = fresh();
    const out = writeAuditRecord(dir, "review-working", "findings", [
      { severity: "important", title: "dies", failure_scenario: "s1",
        detail: "scenario: not a key line\noutcome: confirmed",
        panel: [{ seat: "v", verdict: "REFUTED", evidence: "e" }] },
      { severity: "critical", title: "lives", failure_scenario: "s2", issue: "GH-1",
        panel: [{ seat: "v", verdict: "CONFIRMED", evidence: "e" }] },
    ]);
    expect(parseAuditRecord(out.path).findings).toEqual([
      { title: "dies", severity: "important", failure_scenario: "s1", outcome: "refuted" },
      { title: "lives", severity: "critical", failure_scenario: "s2", outcome: "confirmed" },
    ]);
  });

  it("parseAuditRecord skips a legacy (pre-phase-21) block with a note, keeping the rest", () => {
    const dir = fresh();
    const legacy = join(dir, "legacy.md");
    writeFileSync(legacy, [
      "---", "scope: uat-phase-1", "verdict: findings", "created: 2020-01-01", "---",
      "# Audit: uat-phase-1", "",
      "## finding — critical", "checkout 500s", "issue: GH-9", "",
      "## finding — minor", "copy stale", "scenario: open /settings → old year", "",
    ].join("\n"));
    const back = parseAuditRecord(legacy);
    expect(back.findings).toEqual([
      { title: "copy stale", severity: "minor", failure_scenario: "open /settings → old year", outcome: "unpanelled" },
    ]);
    expect(back.notes).toEqual(["skipped critical finding 'checkout 500s' — no scenario (pre-phase-21 body)"]);
    expect(back.legs).toEqual([]);
    expect(back.deltaFixed).toEqual([]);
  });
});
