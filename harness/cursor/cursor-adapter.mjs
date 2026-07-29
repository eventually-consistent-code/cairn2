#!/usr/bin/env node

/**
 * Purpose: Cursor hooks adapter (CRN-71 wave 3) -- one entry point for every
 *   Cursor hook event. Translates Cursor's hook payload (hook_event_name,
 *   workspace_roots, command/file_path/...) into the Claude-hook shape
 *   cairn's hook scripts already consume, runs the right script, and
 *   translates exit codes back into Cursor's response contract
 *   ({permission} for before* events, {additional_context} for sessionStart).
 *   Any internal error answers safely (allow / {}) -- hooks must never
 *   break the session because THEY broke.
 * Author(s): John Reed
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Scripts live next to this adapter when installed (.cursor/hooks/cairn/),
// or in hooks/scripts/ when running from a cairn repo clone.
const here = dirname(fileURLToPath(import.meta.url));
function scriptPath(name) {
  const installed = join(here, name);
  if (existsSync(installed)) return installed;
  return join(here, "..", "..", "hooks", "scripts", name);
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// Runs a cairn hook script with a Claude-shaped payload on stdin.
function runScript(name, childPayload, projectDir) {
  return spawnSync(process.execPath, [scriptPath(name)], {
    input: JSON.stringify(childPayload),
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const event = payload?.hook_event_name ?? "";
  const projectDir = payload?.workspace_roots?.[0] ?? payload?.cwd ?? process.cwd();

  if (event === "sessionStart") {
    const r = runScript("sessionstart-continuity.mjs", payload, projectDir);
    // The script emits Claude's {hookSpecificOutput: {additionalContext}} --
    // remap to Cursor's {additional_context}; silence means nothing to add.
    try {
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      if (ctx) respond({ additional_context: ctx });
    } catch { /* no banner, no handoff */ }
    respond({});
  }

  if (event === "beforeShellExecution") {
    const r = runScript("pretooluse-leakguard.mjs", {
      tool_name: "Bash",
      tool_input: { command: payload.command ?? "" },
      cwd: payload.cwd,
    }, projectDir);
    if (r.status === 2) {
      respond({
        permission: "deny",
        user_message: "cairn leak guard blocked this commit — staged changes reference cairn internals.",
        agent_message: (r.stderr || "cairn leak guard: staged changes leak internal refs.").trim(),
      });
    }
    respond({ permission: "allow" });
  }

  if (event === "afterShellExecution" || event === "afterFileEdit") {
    const childPayload = event === "afterShellExecution"
      ? {
          tool_name: "Bash",
          tool_input: { command: payload.command ?? "" },
          tool_response: { output: payload.output ?? "" },
          session_id: payload.conversation_id,
        }
      : {
          tool_name: "Edit",
          tool_input: { file_path: payload.file_path ?? "", edits: payload.edits ?? [] },
          tool_response: {},
          session_id: payload.conversation_id,
        };
    runScript("posttooluse-breadcrumb.mjs", childPayload, projectDir);
    runScript("posttooluse-observe.mjs", childPayload, projectDir);
    respond({});
  }

  if (event === "preCompact") {
    runScript("precompact-refresh.mjs", payload, projectDir);
    respond({});
  }

  // stop is deliberately unwired: the cost tracker reads Claude's transcript
  // JSONL for token usage, and Cursor's transcript format is not that.
  respond({});
} catch {
  respond({});
}
