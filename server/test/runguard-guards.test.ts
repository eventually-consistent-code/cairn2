import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// The always-on destructive-git refusals (#249, #250) and the live-run push
// authority gate (#252) in the PreToolUse run guard. Commands are only ever
// fed to the hook as JSON on stdin -- nothing here runs them.

const RUNGUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..",
  "hooks", "scripts", "pretooluse-runguard.mjs");

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Hook run with a clean override env so the host shell can't leak one in. */
function guard(proj: string, home: string, command: string, extraEnv: Record<string, string> = {},
  cwd: string = proj): { status: number | null; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, CAIRN_HOME: home, ...extraEnv,
  };
  if (!("CAIRN_ALLOW_DESTRUCTIVE_GIT" in extraEnv)) delete env.CAIRN_ALLOW_DESTRUCTIVE_GIT;
  const r = spawnSync(process.execPath, [RUNGUARD], {
    cwd: proj, env, encoding: "utf8", timeout: 5000,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

/** A committed git repo plus an isolated cairn home, optionally with one run manifest. */
function fixture(manifest?: Record<string, unknown>): { proj: string; home: string } {
  const proj = freshDir("cairn-runguard-proj-");
  execFileSync("git", ["init", "-q"], { cwd: proj });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: proj });
  execFileSync("git", ["config", "user.name", "t"], { cwd: proj });
  writeFileSync(join(proj, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: proj });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: proj });
  const home = freshDir("cairn-runguard-home-");
  if (manifest) {
    // Same plain-resolve() hash the guard derives from CLAUDE_PROJECT_DIR
    const abs = resolve(proj);
    const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(join(home, "runs", `${basename(abs)}-${hash}-run-x.json`),
      JSON.stringify({ version: 1, runId: "run-x", ...manifest }));
  }
  return { proj, home };
}

describe("run guard: hard reset refused in every session (#249)", () => {
  it("refuses git reset --hard with no run, naming the override", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git reset --hard",
      "git reset --hard HEAD~1",
      "git reset HEAD~1 --hard",
      "git -C . reset --hard origin/main",
      "git -C sub -c core.x=1 reset -q --hard",
      "cd x && git reset --hard",
      "sudo git reset --hard",
      "bash -c 'git reset --hard'",
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("CAIRN_ALLOW_DESTRUCTIVE_GIT=1");
    }
  });

  it("a non-running manifest changes nothing -- still refused", () => {
    const { proj, home } = fixture({ status: "complete", phases: [], pushAuth: { granted: false } });
    expect(guard(proj, home, "git reset --hard").status).toBe(2);
  });

  it("quoted mentions and soft resets pass", () => {
    const { proj, home } = fixture();
    for (const c of [
      'git commit -m "explain git reset --hard"',
      "git commit -m 'git reset --hard'",
      "echo git reset --hard",
      "git reset --soft HEAD~1",
      "git reset HEAD -- --hard",
      "git log --oneline # git reset --hard",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("command substitution inside double quotes is a command, not text (#257)", () => {
    const { proj, home } = fixture();
    for (const c of [
      'echo "$(git reset --hard)"',
      'echo "result: $(git reset --hard HEAD~1) done"',
      'echo "`git reset --hard`"',
      'git commit -m "$(git reset --hard)"',
      'echo "$(echo "$(git reset --hard)")"',
      'echo "$(cd sub && (true) && git reset --hard)"',
      'echo "$(echo ")" ; git reset --hard)"',
      'echo "$(git push --force)"',
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("CAIRN_ALLOW_DESTRUCTIVE_GIT=1");
    }
  });

  it("literal text that only looks like a substitution still passes (#257)", () => {
    const { proj, home } = fixture();
    for (const c of [
      'git commit -m "explain git reset --hard"',
      "git commit -m '$(git reset --hard)'",
      'git commit -m "escaped \\$(git reset --hard) is text"',
      'git commit -m "escaped \\`git reset --hard\\` is text"',
      'echo "$(git log --oneline -1) says git reset --hard"',
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("CAIRN_ALLOW_DESTRUCTIVE_GIT=1 overrides from env or as the leading assignment only", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "git reset --hard", { CAIRN_ALLOW_DESTRUCTIVE_GIT: "1" }).status)
      .toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard").status).toBe(0);
    expect(guard(proj, home, 'git reset --hard -m "CAIRN_ALLOW_DESTRUCTIVE_GIT=1"').status)
      .toBe(2);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 true && git reset --hard").status)
      .toBe(2);
  });

  it("overridden hard reset still meets the live-run owner-checkout refusal", () => {
    const { proj, home } = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    const r = guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run-x");
  });

  it("checkout/switch stay live-run-only", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "git checkout main").status).toBe(0);
    expect(guard(proj, home, "git switch -c feature").status).toBe(0);
  });

  it("garbage stdin fails open", () => {
    const r = spawnSync(process.execPath, [RUNGUARD], { input: "{ nope", encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});

describe("run guard: force-push refused in every session (#250)", () => {
  it("refuses every force shape with no run, naming the override", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git push --force",
      "git push origin main --force",
      "git push -f",
      "git push -fu origin main",
      "git push -uf origin main",
      "git push --force-with-lease",
      "git push --force-with-lease=main:abc123 origin main",
      "git push --force-if-includes origin main",
      "git push origin +main",
      "git push origin +HEAD:refs/heads/main",
      "git -C . push -f",
      "git fetch && git push --force",
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("CAIRN_ALLOW_DESTRUCTIVE_GIT=1");
    }
  });

  it("plain pushes and quoted mentions pass outside a run", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git push",
      "git push origin main",
      "git push -u origin feature",
      "git push -o ci.skip origin main",
      "git push --follow-tags",
      'git commit -m "never git push --force"',
      "echo git push -f",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("CAIRN_ALLOW_DESTRUCTIVE_GIT=1 overrides from env or as the leading assignment", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "git push --force", { CAIRN_ALLOW_DESTRUCTIVE_GIT: "1" }).status)
      .toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git push origin +main").status)
      .toBe(0);
    expect(guard(proj, home, "git push -f -m CAIRN_ALLOW_DESTRUCTIVE_GIT=1").status).toBe(2);
  });
});

describe("run guard: mid-run push needs manifest push authority (#252)", () => {
  const phases = [{ number: 3, name: "p3", estimate: { low: 1, high: 2, estUsd: { low: 0, high: 0 } } }];
  const granted = { granted: true, scope: "manifest-phases", grantedAt: "2026-10-01T00:00:00Z" };

  it("refuses git push while running without granted authority, naming the run", () => {
    const { proj, home } = fixture({
      status: "running", phases, pushAuth: { granted: false, scope: "manifest-phases" },
    });
    for (const c of ["git push", "git push origin main", "git -C . push -u origin run-branch"]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("run-x");
      expect(r.stderr, c).toContain("push");
    }
  });

  it("refuses from the run's own worktree too -- that is where a run pushes", () => {
    const { proj, home } = fixture({
      status: "running", phases, pushAuth: { granted: false, scope: "manifest-phases" },
    });
    const wt = join(freshDir("cairn-runguard-wt-"), "tree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "runbranch", wt], { cwd: proj });
    expect(guard(proj, home, "git push origin runbranch", {}, wt).status).toBe(2);
  });

  it("allows git push while running when authority is granted for the manifest's phases", () => {
    const { proj, home } = fixture({ status: "running", phases, pushAuth: granted });
    expect(guard(proj, home, "git push origin main").status).toBe(0);
  });

  it("granted authority over no phases, or a foreign scope, covers nothing", () => {
    const empty = fixture({ status: "running", phases: [], pushAuth: granted });
    expect(guard(empty.proj, empty.home, "git push").status).toBe(2);
    const wide = fixture({ status: "running", phases, pushAuth: { ...granted, scope: "all" } });
    expect(guard(wide.proj, wide.home, "git push").status).toBe(2);
    const missing = fixture({ status: "running", phases });
    expect(guard(missing.proj, missing.home, "git push").status).toBe(2);
  });

  it("granted authority does not license a force-push", () => {
    const { proj, home } = fixture({ status: "running", phases, pushAuth: granted });
    expect(guard(proj, home, "git push --force-with-lease").status).toBe(2);
  });

  it("no running manifest: plain push passes; quoted mention passes mid-run", () => {
    for (const status of ["staged", "complete", "stopped"]) {
      const { proj, home } = fixture({ status, phases, pushAuth: { granted: false } });
      expect(guard(proj, home, "git push").status, status).toBe(0);
    }
    const { proj, home } = fixture({ status: "running", phases, pushAuth: { granted: false } });
    expect(guard(proj, home, 'git commit -m "git push later"').status).toBe(0);
  });
});
