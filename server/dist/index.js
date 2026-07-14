#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CairnError } from "./errors.js";
import { loadConfig } from "./config.js";
import { ActiveContext } from "./active-context.js";
import { makeTracker } from "./tracker/registry.js";
import { CachedTracker } from "./tracker/cached.js";
import { scaffoldProject, scaffoldPhase, writePlanIssues } from "./planning/artifacts.js";
import { projectStatus } from "./planning/status.js";
import { driftReport, ensurePhase } from "./planning/mirror.js";
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
    server.registerTool("plan_scaffold_project", { description: "Create .cairn/plans/PROJECT.md + roadmap.md (never overwrites)",
        inputSchema: { name: z.string() } }, wrap((a) => scaffoldProject(deps.projectDir, a.name)));
    server.registerTool("plan_scaffold_phase", { description: "Create phases/NN-slug/ with CONTEXT.md + PLAN.md (+RESEARCH.md)",
        inputSchema: { number: z.number().int(), name: z.string(),
            research: z.boolean().optional() } }, wrap((a) => scaffoldPhase(deps.projectDir, a.number, a.name, { research: a.research })));
    server.registerTool("plan_status", { description: "Phases, artifact presence, and referenced tracker issues",
        inputSchema: {} }, wrap(() => projectStatus(deps.projectDir)));
    server.registerTool("plan_phase_ensure", { description: "Ensure the tracker has a phase named 'Phase N: <name>' (idempotent)",
        inputSchema: { number: z.number().int(), name: z.string() } }, wrap(async (a) => ensurePhase(await getTracker(), a.number, a.name)));
    server.registerTool("plan_drift", { description: "Flag plan-referenced issues that are missing or closed-unverified",
        inputSchema: {} }, wrap(async () => driftReport(await getTracker(), deps.projectDir)));
    const PHASE_DIR_RE = /^\d{2}-[a-z0-9-]+$/;
    server.registerTool("plan_issues_set", { description: "Set the tracker issue ids a phase's PLAN.md advances",
        inputSchema: { phaseDir: z.string(), issues: z.array(z.string()) } }, wrap((a) => {
        if (!PHASE_DIR_RE.test(a.phaseDir)) {
            throw new CairnError("CONFIG_INVALID", `phaseDir must look like 01-name, got '${a.phaseDir}'`);
        }
        const planPath = join(deps.projectDir, ".cairn", "plans", "phases", a.phaseDir, "PLAN.md");
        if (!existsSync(planPath)) {
            throw new CairnError("NOT_FOUND", `no PLAN.md at phaseDir '${a.phaseDir}' — scaffold it first with plan_scaffold_phase`);
        }
        writePlanIssues(deps.projectDir, a.phaseDir, a.issues);
        return { ok: true };
    }));
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
