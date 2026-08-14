/**
 * Native Tasks -> tracker mirror (#96): the TaskCreated/TaskCompleted hook
 * spools events locally, a detached worker mirrors them to the tracker.
 * Everything here runs against a hermetic HOME (never the real ~/.cairn)
 * and the repo-resident local tracker adapter in a temp project.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, appendFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { configSchema, make } from "../src/tracker/adapters/local.js";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "scripts");
const SPOOL_HOOK = join(scriptsDir, "task-mirror-spool.mjs");
const WORKER = join(scriptsDir, "task-mirror-worker.mjs");

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
 * Spool/map paths as the scripts compute them for CLAUDE_PROJECT_DIR: an
 * env-var string is never chdir'd into, so plain path.resolve() (no symlink
 * canonicalization) matches lib.mjs's pathHash exactly.
 */
function hashAndBase(dir: string): { base: string; hash: string } {
  const abs = resolve(dir);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return { base: basename(abs), hash };
}

function spoolPathFor(home: string, projectDir: string): string {
  const { base, hash } = hashAndBase(projectDir);
  return join(home, ".cairn", "spool", `${base}-${hash}.jsonl`);
}

function mapPathFor(home: string, projectDir: string): string {
  const { base, hash } = hashAndBase(projectDir);
  return join(home, ".cairn", "spool", `${base}-${hash}-map.json`);
}

/** Undelivered rows = fresh spool + any claimed-but-unfinished .work batch. */
function remainingRows(home: string, projectDir: string): string[] {
  const spool = spoolPathFor(home, projectDir);
  const out: string[] = [];
  for (const p of [`${spool}.work`, spool]) {
    if (existsSync(p)) out.push(...readFileSync(p, "utf8").split("\n").filter(Boolean));
  }
  return out;
}

/** Hermetic child env: hermetic HOME, our own CLAUDE_PROJECT_DIR, no leaked CAIRN_*. */
function childEnv(home: string, projectDir: string, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "CLAUDE_PROJECT_DIR" || k.startsWith("CAIRN_")) delete env[k];
  }
  return { ...env, HOME: home, CLAUDE_PROJECT_DIR: projectDir, ...extra };
}

/** Payload in the exact shape CLI 2.1.223 delivers (probe #84 capture). */
function payload(event: string, session: string, taskId: string, subject: string, desc = ""): string {
  return JSON.stringify({
    session_id: session,
    transcript_path: "~/t.jsonl",
    cwd: "",
    prompt_id: "p-1",
    hook_event_name: event,
    task_id: taskId,
    task_subject: subject,
    task_description: desc,
  });
}

/** Runs the spool hook synchronously with worker-spawning disabled. */
function runSpoolHook(projectDir: string, home: string, stdinPayload: string) {
  const r = spawnSync(process.execPath, [SPOOL_HOOK], {
    cwd: projectDir,
    env: childEnv(home, projectDir, { CAIRN_TASK_MIRROR_NO_SPAWN: "1" }),
    input: stdinPayload,
    encoding: "utf8",
    timeout: 5000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Same hook, spawned async -- for the concurrent-append storm. */
function runSpoolHookAsync(projectDir: string, home: string, stdinPayload: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SPOOL_HOOK], {
      cwd: projectDir,
      env: childEnv(home, projectDir, { CAIRN_TASK_MIRROR_NO_SPAWN: "1" }),
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("exit", (code) => resolvePromise(code));
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

/** Runs the worker to completion with a near-zero retry schedule. */
function runWorker(projectDir: string, home: string) {
  const r = spawnSync(process.execPath, [WORKER, projectDir], {
    cwd: projectDir,
    env: childEnv(home, projectDir, { CAIRN_TASK_MIRROR_BACKOFF_MS: "1,1" }),
    encoding: "utf8",
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function cairnProject(): string {
  const proj = freshDir("cairn-taskmirror-proj-");
  writeFileSync(join(proj, "cairn.json"),
    JSON.stringify({ tracker: { type: "local", config: {} } }));
  return proj;
}

function localTracker(proj: string) {
  return make(configSchema.parse({}), proj);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("task-mirror-spool hook", () => {
  it("appends one well-formed JSON row per event, silently, with no .tmp residue", () => {
    const proj = cairnProject();
    const home = freshDir("cairn-taskmirror-home-");

    const r1 = runSpoolHook(proj, home, payload("TaskCreated", "s-1", "1", "build the thing", "the details"));
    const r2 = runSpoolHook(proj, home, payload("TaskCompleted", "s-1", "1", "build the thing", "the details"));
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);
    expect(r1.stdout).toBe("");

    const spool = spoolPathFor(home, proj);
    const rows = readFileSync(spool, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      event: "TaskCreated", session_id: "s-1", task_id: "1",
      subject: "build the thing", description: "the details", project_dir: proj,
    });
    expect(rows[1]).toMatchObject({ event: "TaskCompleted", session_id: "s-1", task_id: "1" });
    expect(typeof rows[0].ts).toBe("string");

    const files = readdirSync(dirname(spool));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("storm test: 5 concurrent hook invocations land 5 whole, parseable rows", async () => {
    const proj = cairnProject();
    const home = freshDir("cairn-taskmirror-home-");

    const statuses = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      runSpoolHookAsync(proj, home, payload("TaskCreated", `s-${i}`, "1", `task ${i}`))));
    expect(statuses.every((s) => s === 0)).toBe(true);

    const rows = readFileSync(spoolPathFor(home, proj), "utf8").trim().split("\n");
    expect(rows).toHaveLength(5);
    // Every line parses whole -- O_APPEND kept concurrent writes from interleaving.
    const sessions = rows.map((l) => JSON.parse(l).session_id).sort();
    expect(sessions).toEqual(["s-0", "s-1", "s-2", "s-3", "s-4"]);
  });

  it("is a no-op outside cairn projects and on malformed/irrelevant payloads", () => {
    const bare = freshDir("cairn-taskmirror-bare-"); // no cairn.json
    const home = freshDir("cairn-taskmirror-home-");
    expect(runSpoolHook(bare, home, payload("TaskCreated", "s-1", "1", "x")).status).toBe(0);
    expect(existsSync(join(home, ".cairn"))).toBe(false);

    const proj = cairnProject();
    expect(runSpoolHook(proj, home, "not json").status).toBe(0);
    expect(runSpoolHook(proj, home, "{}").status).toBe(0);
    expect(runSpoolHook(proj, home,
      payload("TaskUpdated", "s-1", "1", "x")).status).toBe(0); // event doesn't exist -- never spool it
    expect(existsSync(spoolPathFor(home, proj))).toBe(false);
  });
});

describe("task-mirror-worker", () => {
  it("drains the spool: creates labeled issues keyed on (session_id, task_id) -- no cross-session collision", async () => {
    const proj = cairnProject();
    const home = freshDir("cairn-taskmirror-home-");

    // Two sessions, SAME task_id "1" -- the per-session counter that collides
    // when keyed on task_id alone (probe #84 constraint 2).
    runSpoolHook(proj, home, payload("TaskCreated", "sess-a", "1", "task from session a", "desc a"));
    runSpoolHook(proj, home, payload("TaskCreated", "sess-b", "1", "task from session b", "desc b"));

    expect(runWorker(proj, home).status).toBe(0);

    const issues = await localTracker(proj).listIssues();
    expect(issues).toHaveLength(2);
    const titles = issues.map((i) => i.title).sort();
    expect(titles).toEqual(["task from session a", "task from session b"]);
    for (const issue of issues) {
      expect(issue.labels).toContain("cairn:task");
      expect(issue.category).toBe("open");
      expect(issue.body).toContain("in-session task list"); // plain-language provenance note
    }
    const a = issues.find((i) => i.title.endsWith("session a"))!;
    expect(a.body).toContain("desc a");

    // Map keys both sessions to distinct issues; spool fully drained.
    const map = JSON.parse(readFileSync(mapPathFor(home, proj), "utf8"));
    expect(Object.keys(map).sort()).toEqual(["sess-a:1", "sess-b:1"]);
    expect(map["sess-a:1"]).not.toBe(map["sess-b:1"]);
    expect(remainingRows(home, proj)).toHaveLength(0);
  });

  it("TaskCompleted trues up a renamed subject and closes only that session's issue", async () => {
    const proj = cairnProject();
    const home = freshDir("cairn-taskmirror-home-");

    runSpoolHook(proj, home, payload("TaskCreated", "sess-a", "1", "original subject"));
    runSpoolHook(proj, home, payload("TaskCreated", "sess-b", "1", "bystander task"));
    // Rename is invisible until close -- completion carries the FINAL subject.
    runSpoolHook(proj, home, payload("TaskCompleted", "sess-a", "1", "renamed subject"));

    expect(runWorker(proj, home).status).toBe(0);

    const issues = await localTracker(proj).listIssues();
    const closed = issues.find((i) => i.category === "closed")!;
    expect(closed.title).toBe("renamed subject"); // trued up, not the create-time name
    const open = issues.find((i) => i.category !== "closed")!;
    expect(open.title).toBe("bystander task"); // sess-b untouched
    expect(remainingRows(home, proj)).toHaveLength(0);
  });

  it("offline durability: a broken tracker leaves every spool line in place", () => {
    const proj = freshDir("cairn-taskmirror-proj-");
    // Invalid adapter config -- makeTracker rejects it, mirroring is impossible.
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "local", config: { prefix: "NOT-VALID!" } } }));
    const home = freshDir("cairn-taskmirror-home-");

    runSpoolHook(proj, home, payload("TaskCreated", "s-1", "1", "stranded task"));
    runSpoolHook(proj, home, payload("TaskCompleted", "s-1", "1", "stranded task"));

    const r = runWorker(proj, home);
    expect(r.status).toBe(0); // never crashes loudly
    expect(remainingRows(home, proj)).toHaveLength(2); // nothing lost
    expect(existsSync(mapPathFor(home, proj))).toBe(false);
  });

  it("mid-drain tracker failure keeps the failed row and everything after it", async () => {
    const proj = cairnProject();
    const home = freshDir("cairn-taskmirror-home-");

    runSpoolHook(proj, home, payload("TaskCreated", "s-1", "1", "first task"));
    expect(runWorker(proj, home).status).toBe(0);
    expect((await localTracker(proj).listIssues())).toHaveLength(1);

    // Break the tracker store (a file where its directory belongs), then spool more.
    rmSync(join(proj, ".tracker"), { recursive: true, force: true });
    writeFileSync(join(proj, ".tracker"), "not a directory");
    runSpoolHook(proj, home, payload("TaskCreated", "s-1", "2", "second task"));

    expect(runWorker(proj, home).status).toBe(0);
    const rows = remainingRows(home, proj).map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "TaskCreated", task_id: "2" });

    // Tracker comes back (breaking it wiped the store, so it's empty now) --
    // the stranded row delivers on the next run.
    rmSync(join(proj, ".tracker"), { force: true });
    expect(runWorker(proj, home).status).toBe(0);
    const recovered = await localTracker(proj).listIssues();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].title).toBe("second task");
    expect(remainingRows(home, proj)).toHaveLength(0);
  });

  it("crash replay is idempotent: a re-delivered TaskCreated does not duplicate the issue", async () => {
    const proj = cairnProject();
    const home = freshDir("cairn-taskmirror-home-");
    const row = payload("TaskCreated", "s-1", "1", "only once");

    runSpoolHook(proj, home, row);
    expect(runWorker(proj, home).status).toBe(0);
    // Simulate a crash after the tracker write but before the spool rewrite:
    // the same row shows up again on the next run.
    runSpoolHook(proj, home, row);
    expect(runWorker(proj, home).status).toBe(0);

    expect((await localTracker(proj).listIssues())).toHaveLength(1);
  });

  it("end to end: the hook itself spawns a detached worker that mirrors the task", async () => {
    const proj = cairnProject();
    const home = freshDir("cairn-taskmirror-home-");

    // No CAIRN_TASK_MIRROR_NO_SPAWN here -- the hook must launch the worker.
    const r = spawnSync(process.execPath, [SPOOL_HOOK], {
      cwd: proj,
      env: childEnv(home, proj, { CAIRN_TASK_MIRROR_BACKOFF_MS: "1,1" }),
      input: payload("TaskCreated", "s-e2e", "1", "hands-free mirror"),
      encoding: "utf8",
      timeout: 5000,
    });
    expect(r.status).toBe(0);

    // The worker runs detached -- poll until the issue lands.
    const deadline = Date.now() + 10000;
    let issues: Awaited<ReturnType<ReturnType<typeof localTracker>["listIssues"]>> = [];
    while (Date.now() < deadline) {
      issues = await localTracker(proj).listIssues().catch(() => []);
      if (issues.length > 0 && remainingRows(home, proj).length === 0) break;
      await sleep(100);
    }
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe("hands-free mirror");
    expect(issues[0].labels).toContain("cairn:task");
    expect(remainingRows(home, proj)).toHaveLength(0);
    expect(existsSync(`${spoolPathFor(home, proj)}.lock`)).toBe(false); // worker cleaned up
  }, 15000);
});
