import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { writeAuditRecord } from "../src/audit/record.js";
import { scaffoldPhase, writePlanIssues } from "../src/planning/artifacts.js";
import {
  canonicalPhaseName, ensurePhase, driftReport, staleAuditDrift,
} from "../src/planning/mirror.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-mirror-"));
const git = (d: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: d, encoding: "utf8" }).trim();
function commit(d: string, file: string, msg: string): void {
  mkdirSync(join(d, file, ".."), { recursive: true });
  writeFileSync(join(d, file), `${msg}\n`);
  git(d, "add", file); git(d, "commit", "-q", "-m", msg, "--no-gpg-sign");
}
/** Temp git repo with one seed commit and a scaffolded phase. */
function repo(): string {
  const d = dir();
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  commit(d, "src/a.ts", "seed");
  return d;
}

describe("ensurePhase", () => {
  it("creates once, then returns the same phase (idempotent)", async () => {
    const t = new FakeTracker();
    const a = await ensurePhase(t, 2, "Planning Engine");
    const b = await ensurePhase(t, 2, "Planning Engine");
    expect(a.name).toBe(canonicalPhaseName(2, "Planning Engine"));
    expect(b.id).toBe(a.id);
    expect((await t.listPhases()).length).toBe(1);
  });

  it("rejects trackers without phase support", async () => {
    const t = new FakeTracker();
    Object.defineProperty(t, "capabilities", {
      value: { ...t.capabilities, hasPhases: false },
    });
    await expect(ensurePhase(t, 1, "X"))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("driftReport", () => {
  it("flags missing and closed-in-unverified-phase, passes open", async () => {
    const t = new FakeTracker();
    const open = await t.createIssue({ title: "open one" });
    const closed = await t.createIssue({ title: "closed one" });
    await t.closeIssue(closed.id);

    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core"); // no VERIFICATION.md
    writePlanIssues(d, pd, [open.id, closed.id, "FAKE-999"]);

    const report = await driftReport(t, d);
    expect(report.ok).toEqual([open.id]);
    expect(report.flagged).toEqual(expect.arrayContaining([
      { issueId: closed.id, phase: 1, reason: "closed" },
      { issueId: "FAKE-999", phase: 1, reason: "missing" },
    ]));
  });

  it("closed issues in a VERIFIED phase are not drift", async () => {
    const t = new FakeTracker();
    const done = await t.createIssue({ title: "done" });
    await t.closeIssue(done.id);
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writePlanIssues(d, pd, [done.id]);
    writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");
    const report = await driftReport(t, d);
    expect(report.flagged).toEqual([]);
    expect(report.ok).toEqual([done.id]);
  });
});

describe("staleAuditDrift (#195)", () => {
  it("a security audit stamped at HEAD is current; docs-only commits keep it current", async () => {
    const d = repo();
    writeAuditRecord(d, "security-1", "pass", []);
    expect(staleAuditDrift(d)).toBeNull();
    commit(d, "docs/guide.md", "docs only");
    expect(staleAuditDrift(d)).toBeNull();
    // ...and the full report carries nothing but the (empty) issue side.
    const report = await driftReport(new FakeTracker(), d);
    expect(report.flagged).toEqual([]);
  });

  it("code commits after the stamp flag the LATEST security record as stale", async () => {
    const d = repo();
    writeAuditRecord(d, "security-1", "pass", []);
    commit(d, "src/b.ts", "code moved");
    commit(d, "src/c.ts", "code moved again");
    const flag = staleAuditDrift(d);
    expect(flag).toMatchObject({ reason: "stale-audit", scope: "security-1",
      cause: "code-moved", codeCommitsSince: 2 });
    expect(flag?.detail).toMatch(/predates 2 code commits — re-run \/cairn:audit security/);
    const report = await driftReport(new FakeTracker(), d);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].reason).toBe("stale-audit");
  });

  it("a record written over a dirty tree is stale on its own", () => {
    const d = repo();
    writeFileSync(join(d, "src/a.ts"), "edited, not committed\n");
    writeAuditRecord(d, "security", "pass", []);
    expect(staleAuditDrift(d)).toMatchObject({ cause: "dirty", scope: "security" });
  });

  it("non-security scopes, unstamped legacy records, and non-git dirs never flag", () => {
    const d = repo();
    writeAuditRecord(d, "review-working", "pass", []);
    commit(d, "src/b.ts", "code moved");
    expect(staleAuditDrift(d)).toBeNull();
    // Legacy: a security record with no stamp (hand-written pre-phase-21 shape).
    writeFileSync(join(d, ".cairn", "audit", "security-2020-01-01.md"),
      "---\nscope: security\nverdict: pass\ncreated: 2020-01-01\n---\n# Audit: security\n");
    expect(staleAuditDrift(d)).toBeNull();
    expect(staleAuditDrift(dir())).toBeNull();
  });
});
