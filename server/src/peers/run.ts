/**
 * Purpose: allow-listed external-CLI adapters (codex/opencode/gemini/grok) —
 * runs each as a fixed-argv, stdin-only child process with a hard cap on
 * input size and a timeout. Never exec, never shell interpolation — argv is
 * always one of the four fixed templates below, and the only data that ever
 * crosses the child-process boundary goes in via stdin. A peer's non-zero
 * exit is a result, not an error: peers are advisory, and the caller (the
 * `peers` verb) is the one that judges what they say. Missing binaries and
 * disabled providers degrade to PRECONDITION_FAILED — nothing here assumes
 * a peer CLI is actually installed.
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
// input, and input to the CLI always rides in on stdin (the trailing "-"
// / "-p -" tells each CLI to read the prompt from stdin).
const TEMPLATES: Record<Provider, readonly string[]> = {
  codex: ["codex", "exec", "-"],
  opencode: ["opencode", "run", "-"],
  gemini: ["gemini", "-p", "-"],
  grok: ["grok", "-p", "-"],
};

const INSTALL_HINTS: Record<Provider, string> = {
  codex: "install the Codex CLI and put it on PATH (npm i -g @openai/codex)",
  opencode: "install the opencode CLI and put it on PATH (see https://opencode.ai)",
  gemini: "install the Gemini CLI and put it on PATH (npm i -g @google/gemini-cli)",
  grok: "install the Grok CLI and put it on PATH (see xAI's grok-cli docs)",
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
}> {
  const cfg = loadConfig(projectDir);
  return PROVIDERS.map((provider) => {
    const peerCfg = cfg.peers?.[provider] ?? {};
    return {
      provider,
      onPath: onPath(TEMPLATES[provider][0]),
      enabled: peerCfg.enabled ?? true,
      maxInputChars: peerCfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
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

  const [bin, ...args] = TEMPLATES[provider];
  if (!onPath(bin)) {
    throw new CairnError("PRECONDITION_FAILED",
      `peer '${provider}' CLI ('${bin}') not found on PATH`,
      INSTALL_HINTS[provider]);
  }

  const maxInputChars = peerCfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const { text: sendInput, truncated: truncatedInput } = capInput(input, maxInputChars);

  const start = Date.now();
  return new Promise<PeerResult>((resolve, reject) => {
    const child = execFile(bin, args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" },
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
            `raise timeoutMs, or check that the ${provider} CLI responds on stdin`));
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
    child.stdin?.write(sendInput);
    child.stdin?.end();
  });
}
