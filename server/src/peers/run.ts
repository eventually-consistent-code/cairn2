/**
 * Purpose: allow-listed external-CLI adapters (codex/opencode/antigravity/
 * grok) — runs each as a fixed-argv child process with a hard cap on input
 * size and a timeout, cwd pinned to the project dir. Never exec, never
 * shell interpolation — argv is always one of the four fixed templates
 * below plus (for argv-mode peers) the capped input as the single final
 * element; stdin-mode peers get input piped instead, per each CLI's
 * verified prompt convention. A peer's non-zero exit is a result, not an
 * error: peers are advisory, and the caller (the `peers` verb) is the one
 * that judges what they say. Missing binaries and disabled providers
 * degrade to PRECONDITION_FAILED — nothing here assumes a peer CLI is
 * actually installed.
 * Author(s): John Reed
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { CairnError } from "../errors.js";
import { loadConfig } from "../config.js";
import { PROVIDERS, type Provider } from "./providers.js";

export { PROVIDERS };
export type { Provider };

export interface PeerResult {
  provider: Provider;
  output: string;
  exitCode: number;
  truncatedInput: boolean;
  durationMs: number;
}

// Fixed argv templates — first element is the binary name, resolved via
// PATH by execFile itself. These are constants, never built from user
// input. Input reaches each CLI per its REAL convention (verified against
// the live CLIs, CRN-76 and #56 — the old all-stdin assumption sent
// grok/opencode a literal "-" as their prompt):
//   codex       — `codex exec -` reads instructions from stdin
//                 (documented). `--skip-git-repo-check` rides along because
//                 codex otherwise refuses to run in any directory the host
//                 hasn't marked trusted — reviews died with "Not inside a
//                 trusted directory" depending on where the server sat.
//   antigravity — binary is `agy`; `-p <prompt>` runs one prompt headless
//                 and prints the response. Ignores piped stdin — input
//                 rides as the final argv element, same rules as grok.
//   grok        — `-p <prompt>` takes the prompt as the flag's value; its
//                 headless mode does not consume piped stdin. Input rides
//                 as the final argv element — still execFile with an argv
//                 array, so there is no shell and no interpolation; the
//                 200k default cap keeps well under ARG_MAX on macOS/Linux.
//   opencode    — `run [message..]` takes the prompt positionally; same
//                 argv-mode rules as grok.
const TEMPLATES: Record<Provider, { argv: readonly string[]; inputVia: "stdin" | "argv" }> = {
  codex: { argv: ["codex", "exec", "--skip-git-repo-check", "-"], inputVia: "stdin" },
  opencode: { argv: ["opencode", "run"], inputVia: "argv" },
  antigravity: { argv: ["agy", "-p"], inputVia: "argv" },
  grok: { argv: ["grok", "-p"], inputVia: "argv" },
};

const INSTALL_HINTS: Record<Provider, string> = {
  codex: "install the Codex CLI and put it on PATH (npm i -g @openai/codex)",
  opencode: "install the opencode CLI and put it on PATH (see https://opencode.ai)",
  antigravity: "install the Antigravity CLI ('agy') and put it on PATH (see antigravity docs)",
  grok: "install the Grok CLI and put it on PATH (see xAI's grok-cli docs)",
};

// What to tell the user when a peer blows the timeout. opencode gets a
// specific hint because the cause was verified live (#59, opencode 1.18.10):
// headless `opencode run` never blocks on a TTY — with no credentials in
// auth.json and no opencode.json it silently auto-selects the free-tier
// model ("build · deepseek-v4-flash-free" observed) and that endpoint's
// latency is wildly variable — 5s vs 31s for a one-word reply on back-to-
// back runs, 100s+ in the original report. So an opencode timeout almost
// always means "no default model configured", not a wedged CLI.
const TIMEOUT_HINTS: Record<Provider, string> = {
  codex: "raise timeoutMs, or check that the codex CLI responds on stdin",
  opencode: "raise timeoutMs, or configure a default model for opencode — with none " +
    "configured, headless runs auto-pick a free-tier model with unpredictable " +
    "latency (verified 5-31s+ for a one-word reply, #59); check `opencode auth list` " +
    "and pin a model in opencode.json",
  antigravity: "raise timeoutMs, or check that the antigravity CLI responds on stdin",
  grok: "raise timeoutMs, or check that the grok CLI responds on stdin",
};

const DEFAULT_MAX_INPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

// Probes PATH entries for a binary of this name. POSIX-only — no PATHEXT /
// .exe suffix handling. Windows support for peer adapters is a non-goal.
function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, bin)));
}

// Head-truncates input to maxChars and appends the truncation marker line
// verbatim. Marker text is part of the security contract — don't reword it.
function capInput(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (input.length <= maxChars) return { text: input, truncated: false };
  const marker = `[cairn: input truncated at ${maxChars} chars]`;
  return { text: `${input.slice(0, maxChars)}\n${marker}`, truncated: true };
}

/**
 * Reports detection/config state for every allow-listed provider — never
 * throws for an absent CLI. A missing peer is a DETECTED state, not an
 * error.
 */
export function peerList(projectDir: string): Array<{
  provider: Provider;
  onPath: boolean;
  enabled: boolean;
  maxInputChars: number;
  execCapable: boolean;
}> {
  const cfg = loadConfig(projectDir);
  return PROVIDERS.map((provider) => {
    const peerCfg = cfg.peers?.[provider] ?? {};
    return {
      provider,
      onPath: onPath(TEMPLATES[provider].argv[0]),
      enabled: peerCfg.enabled ?? true,
      maxInputChars: peerCfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
      // Trust flag from config only (#67) — default untrusted, never probed.
      execCapable: peerCfg.execCapable ?? false,
    };
  });
}

/**
 * Runs one peer CLI with `input` on stdin, honoring its configured cap and
 * the given (or default) timeout. Resolves with the child's real exit code
 * on success AND on a non-zero exit — peers are advisory, so a bad exit is
 * data, not a failure. Only genuinely precondition-failed states (disabled
 * provider, missing binary, timeout) throw.
 */
export async function peerRun(projectDir: string, provider: Provider,
  input: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<PeerResult> {
  const cfg = loadConfig(projectDir);
  const peerCfg = cfg.peers?.[provider] ?? {};

  if (peerCfg.enabled === false) {
    throw new CairnError("PRECONDITION_FAILED",
      `peer '${provider}' is disabled in cairn.json`,
      `enable it — set peers.${provider}.enabled to true, or drop the override`);
  }

  const { argv, inputVia } = TEMPLATES[provider];
  const [bin, ...templateArgs] = argv;
  if (!onPath(bin)) {
    throw new CairnError("PRECONDITION_FAILED",
      `peer '${provider}' CLI ('${bin}') not found on PATH`,
      INSTALL_HINTS[provider]);
  }

  const maxInputChars = peerCfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const { text: sendInput, truncated: truncatedInput } = capInput(input, maxInputChars);

  // argv-mode peers get the capped input as the final argv element (execFile
  // argv array — no shell ever sees it); stdin-mode peers get it piped.
  const args = inputVia === "argv" ? [...templateArgs, sendInput] : [...templateArgs];

  const start = Date.now();
  return new Promise<PeerResult>((resolve, reject) => {
    // cwd pinned to the project dir — children used to inherit whatever
    // cwd the MCP server process had, so codex's directory-trust check and
    // any peer's relative file reads made results depend on where the
    // server happened to be sitting (#56).
    const child = execFile(bin, args,
      { cwd: projectDir, timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;

        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new CairnError("PRECONDITION_FAILED",
            `peer '${provider}' CLI ('${bin}') not found on PATH`,
            INSTALL_HINTS[provider]));
          return;
        }
        if (error && (error as { killed?: boolean }).killed) {
          reject(new CairnError("PRECONDITION_FAILED",
            `peer '${provider}' timed out after ${durationMs}ms`,
            TIMEOUT_HINTS[provider]));
          return;
        }

        // Non-zero exit is a passthrough result, never a throw — the
        // caller (the peers verb) judges peer output, this layer doesn't.
        // But only a genuine child exit code counts as a result: anything
        // else (string errnos like EACCES/EMFILE, maxBuffer overruns) means
        // the process never really ran, so that's a precondition failure,
        // not advisory peer output.
        const rawCode = error ? (error as { code?: unknown }).code : 0;
        if (error && typeof rawCode !== "number") {
          reject(new CairnError("PRECONDITION_FAILED",
            `peer '${provider}' failed to run (${String(rawCode)})`,
            "check the peer CLI installation/environment"));
          return;
        }
        const exitCode = typeof rawCode === "number" ? rawCode : 0;
        const output = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
        resolve({ provider, output, exitCode, truncatedInput, durationMs });
      });
    // Swallow stdin write errors (EPIPE and friends) — if the peer exits
    // without draining stdin, or the timeout SIGKILLs it mid-write, Node
    // fires an uncaught 'error' event on the stream unless something is
    // listening. The exec callback above already handles the process-level
    // outcome; a broken pipe here isn't a new failure, just a side effect
    // of one we're already reporting.
    child.stdin?.on("error", () => {});
    if (inputVia === "stdin") child.stdin?.write(sendInput);
    child.stdin?.end(); // argv-mode children get instant EOF so nothing blocks on a TTY read
  });
}
