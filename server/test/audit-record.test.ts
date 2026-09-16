import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAuditRecords, writeAuditRecord } from "../src/audit/record.js";

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
        failure_scenario: "POST /checkout with cart=[] → 500 instead of 400" },
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
      [{ severity: "important", title: "second run", failure_scenario: "rerun → new finding" }]);
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
