import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { peerList, peerRun } from "../src/peers/run.js";

// Stub CLIs are shell scripts prepended onto PATH per test, so no real
// codex/opencode/gemini/grok binary is ever assumed. Restore PATH after
// each test so stubs never leak into the next one.
const ORIGINAL_PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
});

function projectDir(config: Record<string, unknown> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-peers-"));
  writeFileSync(join(d, "cairn.json"), JSON.stringify({
    tracker: { type: "github", config: { repo: "o/r" } },
    ...config,
  }));
  return d;
}

function stubBinDir(scripts: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-stub-"));
  for (const [name, script] of Object.entries(scripts)) {
    const p = join(d, name);
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
  return d;
}

// For tests that actually spawn the stub (as opposed to just PATH-probing
// it): prepend the stub dir so it wins provider-name lookups, but keep the
// real PATH behind it so the stub's own #!/bin/sh shebang and its `cat` /
// `wc` / `tr` / `sleep` / `echo` calls still resolve.
function runnableStubPath(scripts: Record<string, string>): void {
  const d = stubBinDir(scripts);
  process.env.PATH = `${d}${delimiter}${ORIGINAL_PATH}`;
}

const OK_ECHO = "#!/bin/sh\ncat > /dev/null\necho \"stub:$0 ok\"\n";
const STDIN_LENGTH = "#!/bin/sh\nlen=$(cat | wc -c | tr -d ' ')\necho \"len:$len\"\n";
const SLEEPER = "#!/bin/sh\ncat > /dev/null\nsleep 5\necho done\n";
const EXIT_3 = "#!/bin/sh\ncat > /dev/null\nexit 3\n";
const STDERR_AND_STDOUT = "#!/bin/sh\ncat > /dev/null\necho err 1>&2\necho out\n";

describe("peerList", () => {
  it("reports onPath: false for every provider when none are on PATH", () => {
    process.env.PATH = stubBinDir({}); // empty stub dir, no real CLIs reachable
    const d = projectDir();
    for (const entry of peerList(d)) expect(entry.onPath).toBe(false);
  });

  it("reports onPath: true only for the provider whose stub is present", () => {
    process.env.PATH = stubBinDir({ codex: OK_ECHO });
    const d = projectDir();
    const list = peerList(d);
    expect(list.find((p) => p.provider === "codex")?.onPath).toBe(true);
    expect(list.find((p) => p.provider === "opencode")?.onPath).toBe(false);
    expect(list.find((p) => p.provider === "gemini")?.onPath).toBe(false);
    expect(list.find((p) => p.provider === "grok")?.onPath).toBe(false);
  });

  it("defaults enabled: true and maxInputChars: 200000 when unconfigured", () => {
    process.env.PATH = stubBinDir({});
    const d = projectDir();
    const codex = peerList(d).find((p) => p.provider === "codex");
    expect(codex?.enabled).toBe(true);
    expect(codex?.maxInputChars).toBe(200_000);
  });

  it("reflects a configured override for enabled and maxInputChars", () => {
    process.env.PATH = stubBinDir({});
    const d = projectDir({ peers: { gemini: { enabled: false, maxInputChars: 900_000 } } });
    const gemini = peerList(d).find((p) => p.provider === "gemini");
    expect(gemini?.enabled).toBe(false);
    expect(gemini?.maxInputChars).toBe(900_000);
  });
});

describe("peerRun", () => {
  it("throws PRECONDITION_FAILED when the provider is disabled in config", async () => {
    process.env.PATH = stubBinDir({ codex: OK_ECHO });
    const d = projectDir({ peers: { codex: { enabled: false } } });
    await expect(peerRun(d, "codex", "hello")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("codex"),
    });
  });

  it("throws PRECONDITION_FAILED with an install hint when the binary is missing", async () => {
    process.env.PATH = stubBinDir({}); // no grok stub present
    const d = projectDir();
    let caught: unknown;
    try {
      await peerRun(d, "grok", "hello");
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((caught as { nextAction?: string }).nextAction).toMatch(/install/i);
  });

  it("truncates input at the configured cap and appends the exact marker", async () => {
    runnableStubPath({ codex: STDIN_LENGTH });
    const d = projectDir({ peers: { codex: { maxInputChars: 40 } } });
    const input = "x".repeat(100);
    const result = await peerRun(d, "codex", input);
    const marker = "[cairn: input truncated at 40 chars]";
    const expectedLen = 40 + 1 + marker.length; // cap + "\n" + marker, verbatim
    expect(result.truncatedInput).toBe(true);
    expect(result.output.trim()).toBe(`len:${expectedLen}`);
    expect(result.exitCode).toBe(0);
  });

  it("does not truncate when input is within the cap", async () => {
    runnableStubPath({ codex: STDIN_LENGTH });
    const d = projectDir({ peers: { codex: { maxInputChars: 40 } } });
    const input = "x".repeat(10);
    const result = await peerRun(d, "codex", input);
    expect(result.truncatedInput).toBe(false);
    expect(result.output.trim()).toBe(`len:${input.length}`);
  });

  it("kills a hung peer at the timeout and reports PRECONDITION_FAILED naming the provider", async () => {
    runnableStubPath({ gemini: SLEEPER });
    const d = projectDir();
    let caught: unknown;
    try {
      await peerRun(d, "gemini", "hello", 200);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((caught as Error).message).toMatch(/gemini/);
    expect((caught as Error).message).toMatch(/timed out/i);
  });

  it("passes through a non-zero exit code as a result, never a throw", async () => {
    runnableStubPath({ opencode: EXIT_3 });
    const d = projectDir();
    const result = await peerRun(d, "opencode", "hello");
    expect(result.exitCode).toBe(3);
  });

  it("appends the stderr divider only when stderr is non-empty", async () => {
    runnableStubPath({ codex: STDERR_AND_STDOUT });
    const d = projectDir();
    const result = await peerRun(d, "codex", "hello");
    expect(result.output).toBe("out\n\n--- stderr ---\nerr\n");
  });

  it("omits the stderr divider when stderr is empty", async () => {
    runnableStubPath({ codex: OK_ECHO });
    const d = projectDir();
    const result = await peerRun(d, "codex", "hello");
    expect(result.output).not.toContain("--- stderr ---");
  });
});
