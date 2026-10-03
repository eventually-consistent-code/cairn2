/**
 * Purpose: #254 -- the harness guard must see through a wrapper's own flags
 *   (sudo -u root, env -i, nice -n 5, timeout 5 ...) and through shell flag
 *   clusters that carry -c (bash -lc), the way it did before the #240
 *   rewrite. Every wrapped write is paired with the wrapped READ of the same
 *   path, so closing the gap never brings back the #240 false positives.
 *   Only command strings are fed to the hook; nothing is ever run.
 * Author(s): John Reed
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Constants
const HARNESSGUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..",
  "hooks", "scripts", "pretooluse-harnessguard.mjs");

// Variables
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A bare temp dir is a complete fixture -- the guard reads no project state. */
function proj(): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-harnessguard-wrappers-"));
  dirs.push(d);
  return d;
}

/** Exit status of the guard for one Bash command string. */
function guard(projectDir: string, command: string): number | null {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete env.CAIRN_HARNESS_EDIT;
  const r = spawnSync(process.execPath, [HARNESSGUARD], {
    cwd: projectDir,
    env,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" }),
    encoding: "utf8",
    timeout: 5000,
  });
  return r.status;
}

describe("harness guard sees through wrapper flags (#254)", () => {
  it("the reported bypasses are refused again", () => {
    const p = proj();
    for (const c of [
      "sudo -u root tee hooks/a",
      "env -i FOO=1 rm hooks/a",
      "bash -lc 'echo x > hooks/a'",
    ]) {
      expect(guard(p, c), c).toBe(2);
    }
  });

  // Each row: [wrapped write, wrapped read of the same path]. The write must
  // be refused exactly like its plain form; the read must pass like its
  // plain form (#240 stays intact).
  it("a wrapped write is refused and the same wrapper around a read passes", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["sudo -u root tee hooks/a", "sudo -u root cat hooks/a"],
      ["sudo -uroot rm hooks/a", "sudo -uroot cat hooks/a"],
      ["sudo -E -g wheel mv /tmp/x .mcp.json", "sudo -E -g wheel cat .mcp.json"],
      ["sudo --user=root rm hooks/a", "sudo --user=root cat hooks/a"],
      ["sudo --user root rm hooks/a", "sudo --user root cat hooks/a"],
      ["sudo -- rm hooks/a", "sudo -- cat hooks/a"],
      ["/usr/bin/sudo -n rm hooks/a", "/usr/bin/sudo -n cat hooks/a"],
      ["env -i FOO=1 rm hooks/a", "env -i FOO=1 cat hooks/a"],
      ["env -u HOME rm hooks/a", "env -u HOME cat hooks/a"],
      ["env -C /tmp rm hooks/a", "env -C /tmp cat hooks/a"],
      ["env -S 'rm hooks/a'", "env -S 'cat hooks/a'"],
      ["env - rm hooks/a", "env - cat hooks/a"],
      ["nice -n 5 rm hooks/a", "nice -n 5 cat hooks/a"],
      ["nice -10 rm hooks/a", "nice -10 cat hooks/a"],
      ["timeout 5 rm hooks/a", "timeout 5 cat hooks/a"],
      ["timeout -s KILL -k 2 5s rm hooks/a", "timeout -s KILL -k 2 5s cat hooks/a"],
      ["xargs -n 1 -I{} rm hooks/a", "xargs -n 1 -I{} cat hooks/a"],
      ["exec -a name rm hooks/a", "exec -a name cat hooks/a"],
      ["command -p rm hooks/a", "command -p cat hooks/a"],
      ["nohup sudo -u root env -i nice -n 1 rm hooks/a",
        "nohup sudo -u root env -i nice -n 1 cat hooks/a"],
      ["sudo -u root bash -c 'rm hooks/a'", "sudo -u root bash -c 'cat hooks/a'"],
      ["time -p rm hooks/a", "time -p cat hooks/a"],
      ["doas -u root rm hooks/a", "doas -u root cat hooks/a"],
      ["stdbuf -oL tee hooks/a", "stdbuf -oL grep x hooks/a"],
      ["setsid rm hooks/a", "setsid cat hooks/a"],
      ["builtin command rm hooks/a", "builtin command cat hooks/a"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("GNU time -o names a file it writes", () => {
    const p = proj();
    expect(guard(p, "time -o hooks/a ls")).toBe(2);
    expect(guard(p, "time -o /tmp/t.txt cat hooks/a")).toBe(0);
  });

  it("any shell flag cluster carrying c runs its string as a command", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["bash -lc 'echo x > hooks/a'", "bash -lc 'cat hooks/a'"],
      ["bash -ic 'rm hooks/a'", "bash -ic 'cat hooks/a'"],
      ["sh -ec 'rm hooks/a'", "sh -ec 'cat hooks/a'"],
      ["bash -l -c 'rm hooks/a'", "bash -l -c 'cat hooks/a'"],
      ["bash -o pipefail -c 'rm hooks/a'", "bash -o pipefail -c 'cat hooks/a'"],
      ["zsh -xc 'tee hooks/a'", "zsh -xc 'grep x hooks/a'"],
    ];
    for (const [write, read] of pairs) {
      expect(guard(p, write), write).toBe(2);
      expect(guard(p, read), read).toBe(0);
    }
  });

  it("a shell with no -c never reads a script path as its command string", () => {
    const p = proj();
    // Before #254, a missing -c made indexOf return -1 and the guard computed
    // args[0] as the inner command (a later includes("-c") check kept it
    // unused). The string is now only looked for once a -c cluster is seen.
    for (const c of [
      "bash hooks/scripts/check.sh",
      "sh -x hooks/scripts/check.sh 'rm hooks/a'",
      "bash -o pipefail hooks/scripts/check.sh",
    ]) {
      expect(guard(p, c), c).toBe(0);
    }
  });
});
