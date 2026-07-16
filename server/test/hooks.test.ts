import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Hook scripts live at the plugin root (repo root), not under server/ -- two
// levels up from server/test.
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "scripts");
const BREADCRUMB = join(scriptsDir, "posttooluse-breadcrumb.mjs");
const PRECOMPACT = join(scriptsDir, "precompact-refresh.mjs");
const SESSIONSTART = join(scriptsDir, "sessionstart-continuity.mjs");

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The hook scripts hash `resolve(process.cwd())` inside the spawned child.
 * On macOS, os.tmpdir() lives under a symlinked prefix (/var -> /private/var),
 * which the OS canonicalizes on chdir but plain path.resolve() does not --
 * so the hash must be derived from the *child's* actual cwd, not the literal
 * mkdtempSync string, or every fixture path in this file would compute the
 * wrong handoff/banner path and silently test against nothing.
 */
function realCwd(dir: string): string {
  return execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
    cwd: dir, encoding: "utf8",
  });
}

function hashAndBase(dir: string): { base: string; hash: string } {
  const real = realCwd(dir);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return { base: basename(real), hash };
}

function handoffPathFor(home: string, projectDir: string): string {
  const { base, hash } = hashAndBase(projectDir);
  return join(home, ".cairn", "handoff", `${base}-${hash}.json`);
}

function bannerPathFor(home: string, projectDir: string): string {
  const { base, hash } = hashAndBase(projectDir);
  return join(home, ".cairn", "banner", `${base}-${hash}.md`);
}

function baseHandoff(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    created: "2020-01-01T00:00:00.000Z",
    source: "tool",
    project: "proj",
    task: { current: "t1", title: "first task" },
    tasks_completed: [],
    tasks_remaining: [],
    blockers: [],
    decisions_in_flight: [],
    uncommitted_files: [],
    next_action: "keep going",
    notes: "n",
    partial: false,
    ...overrides,
  };
}

function writeHandoffFixture(home: string, projectDir: string, data: Record<string, unknown>): string {
  const path = handoffPathFor(home, projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

/** Runs a hook script with cwd=projectDir, HOME=home. Returns trimmed stdout. */
function runHook(script: string, projectDir: string, home: string): string {
  return execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 5000,
  }).trim();
}

function backdateMtime(path: string, msAgo: number): void {
  const t = (Date.now() - msAgo) / 1000;
  utimesSync(path, t, t);
}

describe("hooks/scripts smoke check", () => {
  it("all three scripts exist", () => {
    for (const p of [BREADCRUMB, PRECOMPACT, SESSIONSTART]) expect(existsSync(p)).toBe(true);
  });
});

describe("posttooluse-breadcrumb", () => {
  it("no-handoff dir: exits cleanly and creates no file at all", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const stdout = runHook(BREADCRUMB, proj, home);
    expect(stdout).toBe("");
    expect(existsSync(join(home, ".cairn"))).toBe(false);
  });

  it("storm test: 5 rapid invocations produce at most 1 write (60s throttle)", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const path = writeHandoffFixture(home, proj, baseHandoff());
    backdateMtime(path, 70_000); // older than the 60s throttle window

    const before = readFileSync(path, "utf8");
    const snapshots: string[] = [];
    for (let i = 0; i < 5; i++) {
      runHook(BREADCRUMB, proj, home);
      snapshots.push(readFileSync(path, "utf8"));
    }

    // First invocation lands a write (mtime was stale); the remaining 4,
    // fired immediately after, land inside the 60s window and no-op.
    expect(snapshots[0]).not.toBe(before);
    for (let i = 1; i < snapshots.length; i++) expect(snapshots[i]).toBe(snapshots[0]);

    const written = JSON.parse(snapshots[0]);
    expect(written.source).toBe("posttooluse");
    expect(written.task).toEqual({ current: "t1", title: "first task" }); // preserved verbatim
    expect(written.next_action).toBe("keep going"); // preserved verbatim

    // Atomic write leaves no .tmp residue behind.
    const files = readdirSync(dirname(path));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("captures uncommitted files from git status --porcelain, capped at 20", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    execFileSync("git", ["init", "-q"], { cwd: proj });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: proj });
    execFileSync("git", ["config", "user.name", "t"], { cwd: proj });
    for (let i = 0; i < 25; i++) writeFileSync(join(proj, `f${i}.txt`), "x");

    const path = writeHandoffFixture(home, proj, baseHandoff());
    backdateMtime(path, 70_000);
    runHook(BREADCRUMB, proj, home);

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.source).toBe("posttooluse");
    expect(written.uncommitted_files.length).toBe(20);
    expect(written.uncommitted_files).toContain("f0.txt");
  });

  it("wall-clock stays well under the <100ms budget", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const path = writeHandoffFixture(home, proj, baseHandoff());
    backdateMtime(path, 70_000);

    runHook(BREADCRUMB, proj, home); // warm-up run, untimed (disk cache / OS scheduling noise)
    backdateMtime(path, 70_000);

    const started = Date.now();
    runHook(BREADCRUMB, proj, home);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(100);
  });
});

describe("precompact-refresh", () => {
  it("no-handoff dir: exits cleanly and creates no file at all", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const stdout = runHook(PRECOMPACT, proj, home);
    expect(stdout).toBe("");
    expect(existsSync(join(home, ".cairn"))).toBe(false);
  });

  it("is unthrottled: writes even immediately after a fresh write", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const path = writeHandoffFixture(home, proj, baseHandoff());
    backdateMtime(path, 70_000);
    runHook(BREADCRUMB, proj, home); // lands a write, refreshes mtime to "now"

    const before = readFileSync(path, "utf8");
    runHook(PRECOMPACT, proj, home); // must NOT be throttled by the fresh mtime
    const after = readFileSync(path, "utf8");

    expect(after).not.toBe(before);
    expect(JSON.parse(after).source).toBe("precompact");
    expect(JSON.parse(after).next_action).toBe("keep going"); // preserved verbatim
  });
});

describe("sessionstart-continuity", () => {
  it("nothing present: emits no stdout", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const stdout = runHook(SESSIONSTART, proj, home);
    expect(stdout).toBe("");
  });

  it("resume:prompt (default) asks the user, in the documented JSON shape", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    writeHandoffFixture(home, proj, baseHandoff({
      phase: { number: 3, slug: "continuity" },
      issue: "cairn-42",
      next_action: "implement writeHandoff skeleton guard",
    }));

    const stdout = runHook(SESSIONSTART, proj, home);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("phase: 3 (continuity)");
    expect(ctx).toContain("issue: cairn-42");
    expect(ctx).toContain("t1");
    expect(ctx).toContain("implement writeHandoff skeleton guard");
    expect(ctx.toLowerCase()).toContain("ask the user");
    expect(ctx).not.toContain("without asking the user");
  });

  it("resume:auto instructs an automatic resume instead of asking", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "auto" },
    }));
    writeHandoffFixture(home, proj, baseHandoff());

    const stdout = runHook(SESSIONSTART, proj, home);
    const parsed = JSON.parse(stdout);
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("without asking the user");
    expect(ctx.toLowerCase()).not.toContain("ask the user whether");
  });

  it("resume:off suppresses the resume block entirely (no stdout, handoff present)", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "off" },
    }));
    writeHandoffFixture(home, proj, baseHandoff());

    const stdout = runHook(SESSIONSTART, proj, home);
    expect(stdout).toBe("");
  });

  it("includes the banner file verbatim when present, even with resume:off", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "off" },
    }));
    const bannerPath = bannerPathFor(home, proj);
    mkdirSync(dirname(bannerPath), { recursive: true });
    writeFileSync(bannerPath, "## cairn recall index — proj\nsome banner content\n");
    writeHandoffFixture(home, proj, baseHandoff());

    const stdout = runHook(SESSIONSTART, proj, home);
    const parsed = JSON.parse(stdout);
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("some banner content");
    expect(ctx.toLowerCase()).not.toContain("ask the user whether");
    expect(ctx).not.toContain("without asking the user");
  });
});
