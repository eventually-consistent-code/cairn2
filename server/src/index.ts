#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CairnError } from "./errors.js";
import { loadConfig } from "./config.js";
import { ActiveContext } from "./active-context.js";
import { makeTracker } from "./tracker/registry.js";
import { CachedTracker } from "./tracker/cached.js";
import type { Tracker, IssueState } from "./tracker/types.js";

const StateEnum = z.enum(["open", "in_progress", "closed"]);

export function buildServer(deps: { projectDir: string; tracker?: Tracker }): McpServer {
  const server = new McpServer({ name: "cairn", version: "2.0.0-alpha.0" });
  const ctx = new ActiveContext(deps.projectDir);
  let tracker: Tracker | undefined = deps.tracker;

  const getTracker = async (): Promise<Tracker> => {
    if (!tracker) tracker = new CachedTracker(await makeTracker(loadConfig(deps.projectDir)));
    return tracker;
  };

  const ok = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  const wrap = <A>(fn: (args: A) => Promise<unknown> | unknown) =>
    async (args: A) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        const body = e instanceof CairnError
          ? { code: e.code, message: e.message, nextAction: e.nextAction }
          : { code: "TRACKER_DOWN", message: String(e) };
        return { ...ok(body), isError: true };
      }
    };

  server.registerTool("context_get",
    { description: "Get the active cairn context (phase, issue)", inputSchema: {} },
    wrap(() => ctx.get()));

  server.registerTool("context_set",
    { description: "Set/clear active cairn context fields (null clears)",
      inputSchema: { phase: z.number().nullable().optional(),
                     issueId: z.string().nullable().optional() } },
    wrap((a: { phase?: number | null; issueId?: string | null }) => {
      ctx.set(a); return ctx.get();
    }));

  server.registerTool("issue_create",
    { description: "Create an issue in the configured tracker",
      inputSchema: { title: z.string(), body: z.string().optional(),
                     labels: z.array(z.string()).optional(),
                     phase: z.string().optional() } },
    wrap(async (a: { title: string; body?: string; labels?: string[]; phase?: string }) =>
      (await getTracker()).createIssue(a)));

  server.registerTool("issue_get",
    { description: "Fetch one issue", inputSchema: { id: z.string() } },
    wrap(async (a: { id: string }) => (await getTracker()).getIssue(a.id)));

  server.registerTool("issue_update",
    { description: "Update an issue (title/body/state/labels/assignee)",
      inputSchema: { id: z.string(), title: z.string().optional(),
                     body: z.string().optional(), state: StateEnum.optional(),
                     labels: z.array(z.string()).optional(),
                     assignee: z.string().optional() } },
    wrap(async (a: { id: string; title?: string; body?: string; state?: IssueState;
               labels?: string[]; assignee?: string }) => {
      const { id, ...patch } = a;
      return (await getTracker()).updateIssue(id, patch);
    }));

  server.registerTool("issue_close",
    { description: "Close an issue", inputSchema: { id: z.string() } },
    wrap(async (a: { id: string }) => (await getTracker()).closeIssue(a.id)));

  server.registerTool("issue_list",
    { description: "List issues, optionally by phase/state",
      inputSchema: { phase: z.string().optional(), state: StateEnum.optional() } },
    wrap(async (a: { phase?: string; state?: IssueState }) => (await getTracker()).listIssues(a)));

  server.registerTool("phase_create",
    { description: "Create a phase (milestone/epic/list per backend)",
      inputSchema: { name: z.string() } },
    wrap(async (a: { name: string }) => (await getTracker()).createPhase(a.name)));

  server.registerTool("phase_list",
    { description: "List phases", inputSchema: {} },
    wrap(async () => (await getTracker()).listPhases()));

  return server;
}

// CLI entry — stdio transport; config loads lazily per tool call.
const isMain = process.argv[1]?.endsWith("index.js");
if (isMain) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const server = buildServer({ projectDir });
  await server.connect(new StdioServerTransport());
}
