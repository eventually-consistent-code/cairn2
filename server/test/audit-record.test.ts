import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAuditRecords, writeAuditRecord } from "../src/audit/record.js";
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
