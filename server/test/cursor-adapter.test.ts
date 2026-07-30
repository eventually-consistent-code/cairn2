// Cursor hooks adapter (CRN-71 wave 3): translates Cursor hook payloads to
// the Claude-hook shape cairn's hook scripts consume, and translates their
// exit codes back to Cursor's response contract. Runs the real adapter with
// a fake HOME so no real handoff/metrics state is touched.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "harness", "cursor", "cursor-adapter.mjs");

const dirs: string[] = [];
function fresh(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runAdapter(payload: object, home: string): string {
  return execFileSync(process.execPath, [ADAPTER], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home },
  });
}

describe("cursor-adapter", () => {
  it("beforeShellExecution: allows a harmless command", () => {
    const proj = fresh("cairn-cursor-");
    const home = fresh("cairn-home-");
    const out = runAdapter({
      hook_event_name: "beforeShellExecution",
      command: "ls -la",
      cwd: proj,
      workspace_roots: [proj],
    }, home);
    expect(JSON.parse(out)).toEqual({ permission: "allow" });
  });

  it("beforeShellExecution: denies a git commit whose staged diff leaks internal refs", () => {
    const proj = fresh("cairn-cursor-");
    const home = fresh("cairn-home-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: proj, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      leakGuard: { enabled: true },
    }));
    writeFileSync(join(proj, "src.ts"), "// see .cairn/plans/PROJECT.md for details\n");
    git("add", "src.ts");

    const out = runAdapter({
      hook_event_name: "beforeShellExecution",
      command: "git commit -m 'leaky'",
      cwd: proj,
      workspace_roots: [proj],
    }, home);
    const resp = JSON.parse(out);
    expect(resp.permission).toBe("deny");
    expect(resp.agent_message).toContain("leak");
  });

  it("sessionStart: returns additional_context when a handoff banner exists", () => {
    const proj = fresh("cairn-cursor-");
    const home = fresh("cairn-home-");
    // The banner path scheme is basename + sha256(abs)[0:16] under ~/.cairn/banner.
    const hash = createHash("sha256").update(proj).digest("hex").slice(0, 16);
    const bannerDir = join(home, ".cairn", "banner");
    mkdirSync(bannerDir, { recursive: true });
    writeFileSync(join(bannerDir, `${basename(proj)}-${hash}.md`), "## cairn banner test\n");

    const out = runAdapter({
      hook_event_name: "sessionStart",
      session_id: "s1",
      workspace_roots: [proj],
    }, home);
    const resp = JSON.parse(out);
    expect(resp.additional_context).toContain("cairn banner test");
  });

  // Documented posture, now pinned by a test: when the leak guard ITSELF
  // breaks (corrupt cairn.json here), the answer is allow — the guard must
  // never block work because it broke. Same fail-open rule as the Claude
  // Code hook it wraps.
  it("beforeShellExecution fails OPEN when the guard itself errors", () => {
    const proj = fresh("cairn-cursor-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, "cairn.json"), "{ not json");
    const out = runAdapter({
      hook_event_name: "beforeShellExecution",
      command: "git commit -m 'x'",
      cwd: proj,
      workspace_roots: [proj],
    }, home);
    expect(JSON.parse(out)).toEqual({ permission: "allow" });
  });

  it("unknown events and adapter-internal errors never fail the hook", () => {
    const home = fresh("cairn-home-");
    const out = runAdapter({ hook_event_name: "someFutureEvent" }, home);
    expect(JSON.parse(out)).toEqual({});
  });
});
