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
/**
 * Reports detection/config state for every allow-listed provider — never
 * throws for an absent CLI. A missing peer is a DETECTED state, not an
 * error.
 */
export declare function peerList(projectDir: string): Array<{
    provider: Provider;
    onPath: boolean;
    enabled: boolean;
    maxInputChars: number;
    execCapable: boolean;
}>;
/**
 * Runs one peer CLI with `input` on stdin, honoring its configured cap and
 * the given (or default) timeout. Resolves with the child's real exit code
 * on success AND on a non-zero exit — peers are advisory, so a bad exit is
 * data, not a failure. Only genuinely precondition-failed states (disabled
 * provider, missing binary, timeout) throw.
 */
export declare function peerRun(projectDir: string, provider: Provider, input: string, timeoutMs?: number): Promise<PeerResult>;
