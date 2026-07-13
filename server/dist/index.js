#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CairnError } from "./errors.js";
import { loadConfig } from "./config.js";
import { ActiveContext } from "./active-context.js";
import { makeTracker } from "./tracker/registry.js";
import { CachedTracker } from "./tracker/cached.js";
const StateEnum = z.enum(["open", "in_progress", "closed"]);
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export function buildServer(deps) {
    const server = new McpServer({ name: "cairn", version: VERSION });
    const ctx = new ActiveContext(deps.projectDir);
    let tracker = deps.tracker;
    const getTracker = async () => {
        if (!tracker)
            tracker = new CachedTracker(await makeTracker(loadConfig(deps.projectDir)));
        return tracker;
    };
    const ok = (value) => ({
        content: [{ type: "text", text: JSON.stringify(value) }],
    });
    const wrap = (fn) => async (args) => {
        try {
            return ok(await fn(args));
        }
        catch (e) {
            const body = e instanceof CairnError
                ? { code: e.code, message: e.message, nextAction: e.nextAction }
                : { code: "TRACKER_DOWN", message: String(e) };
            return { ...ok(body), isError: true };
        }
    };
    server.registerTool("context_get", { description: "Get the active cairn context (phase, issue)", inputSchema: {} }, wrap(() => ctx.get()));
    server.registerTool("context_set", { description: "Set/clear active cairn context fields (null clears)",
        inputSchema: { phase: z.number().nullable().optional(),
            issueId: z.string().nullable().optional() } }, wrap((a) => {
        ctx.set(a);
        return ctx.get();
    }));
    server.registerTool("issue_create", { description: "Create an issue in the configured tracker",
        inputSchema: { title: z.string(), body: z.string().optional(),
            labels: z.array(z.string()).optional(),
            phase: z.string().optional() } }, wrap(async (a) => (await getTracker()).createIssue(a)));
    server.registerTool("issue_get", { description: "Fetch one issue", inputSchema: { id: z.string() } }, wrap(async (a) => (await getTracker()).getIssue(a.id)));
    server.registerTool("issue_update", { description: "Update an issue (title/body/state/labels/assignee)",
        inputSchema: { id: z.string(), title: z.string().optional(),
            body: z.string().optional(), state: StateEnum.optional(),
            labels: z.array(z.string()).optional(),
            assignee: z.string().optional() } }, wrap(async (a) => {
        const { id, ...patch } = a;
        return (await getTracker()).updateIssue(id, patch);
    }));
    server.registerTool("issue_close", { description: "Close an issue", inputSchema: { id: z.string() } }, wrap(async (a) => (await getTracker()).closeIssue(a.id)));
    server.registerTool("issue_list", { description: "List issues, optionally by phase/state",
        inputSchema: { phase: z.string().optional(), state: StateEnum.optional() } }, wrap(async (a) => (await getTracker()).listIssues(a)));
    server.registerTool("phase_create", { description: "Create a phase (milestone/epic/list per backend)",
        inputSchema: { name: z.string() } }, wrap(async (a) => (await getTracker()).createPhase(a.name)));
    server.registerTool("phase_list", { description: "List phases", inputSchema: {} }, wrap(async () => (await getTracker()).listPhases()));
    return server;
}
// CLI entry — stdio transport; config loads lazily per tool call.
const isMain = (() => {
    const argv1 = process.argv[1];
    if (!argv1)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
    }
    catch {
        return false;
    }
})();
if (isMain) {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const server = buildServer({ projectDir });
    await server.connect(new StdioServerTransport());
}
