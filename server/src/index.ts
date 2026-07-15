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
import type { Tracker, IssueState } from "./tracker/types.js";
import { scaffoldProject, scaffoldPhase, writePlanIssues } from "./planning/artifacts.js";
import { projectStatus } from "./planning/status.js";
import { driftReport, ensurePhase } from "./planning/mirror.js";
import { MemoryIndex, indexDbPath } from "./memory/index-store.js";
import { createCard, listCards } from "./memory/cards.js";
import { checkCardStaleness } from "./memory/staleness.js";

const StateEnum = z.enum(["open", "in_progress", "closed"]);

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

export function buildServer(deps: { projectDir: string; tracker?: Tracker }): McpServer {
  const server = new McpServer({ name: "cairn", version: VERSION });
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

  server.registerTool("plan_scaffold_project",
    { description: "Create .cairn/plans/PROJECT.md + roadmap.md (never overwrites)",
      inputSchema: { name: z.string() } },
    wrap((a: { name: string }) => scaffoldProject(deps.projectDir, a.name)));

  server.registerTool("plan_scaffold_phase",
    { description: "Create phases/NN-slug/ with CONTEXT.md + PLAN.md (+RESEARCH.md)",
      inputSchema: { number: z.number().int(), name: z.string(),
                     research: z.boolean().optional() } },
    wrap((a: { number: number; name: string; research?: boolean }) =>
      scaffoldPhase(deps.projectDir, a.number, a.name, { research: a.research })));

  server.registerTool("plan_status",
    { description: "Phases, artifact presence, and referenced tracker issues",
      inputSchema: {} },
    wrap(() => projectStatus(deps.projectDir)));

  server.registerTool("plan_phase_ensure",
    { description: "Ensure the tracker has a phase named 'Phase N: <name>' (idempotent)",
      inputSchema: { number: z.number().int(), name: z.string() } },
    wrap(async (a: { number: number; name: string }) =>
      ensurePhase(await getTracker(), a.number, a.name)));

  server.registerTool("plan_drift",
    { description: "Flag plan-referenced issues that are missing or closed-unverified",
      inputSchema: {} },
    wrap(async () => driftReport(await getTracker(), deps.projectDir)));

  const PHASE_DIR_RE = /^\d{2}-[a-z0-9-]+$/;
  server.registerTool("plan_issues_set",
    { description: "Set the tracker issue ids a phase's PLAN.md advances",
      inputSchema: { phaseDir: z.string(), issues: z.array(z.string()) } },
    wrap((a: { phaseDir: string; issues: string[] }) => {
      if (!PHASE_DIR_RE.test(a.phaseDir)) {
        throw new CairnError("CONFIG_INVALID",
          `phaseDir must look like 01-name, got '${a.phaseDir}'`);
      }
      const planPath = join(deps.projectDir, ".cairn", "plans", "phases", a.phaseDir, "PLAN.md");
      if (!existsSync(planPath)) {
        throw new CairnError("NOT_FOUND",
          `no PLAN.md at phaseDir '${a.phaseDir}' — scaffold it first with plan_scaffold_phase`);
      }
      writePlanIssues(deps.projectDir, a.phaseDir, a.issues);
      return { ok: true };
    }));

  let memIndex: MemoryIndex | undefined;
  const getMemIndex = (): MemoryIndex => {
    if (!memIndex) memIndex = new MemoryIndex(indexDbPath(deps.projectDir));
    return memIndex;
  };

  server.registerTool("mem_index",
    { description: "Index reference material into the searchable memory store (disposable, rebuildable)",
      inputSchema: { content: z.string(), source: z.string(),
                     phase: z.number().int().optional(), issueId: z.string().optional() } },
    wrap((a: { content: string; source: string; phase?: number; issueId?: string }) => {
      getMemIndex().index({
        content: a.content, source: a.source,
        phase: a.phase ?? null, issueId: a.issueId ?? null,
        createdAt: new Date().toISOString(),
      });
      return { ok: true };
    }));

  server.registerTool("mem_search",
    { description: "Full-text search the memory index, optionally scoped to a phase/issue",
      inputSchema: { query: z.string(), phase: z.number().int().optional(),
                     issueId: z.string().optional(), limit: z.number().int().positive().optional() } },
    wrap((a: { query: string; phase?: number; issueId?: string; limit?: number }) =>
      getMemIndex().search(a.query, { phase: a.phase, issueId: a.issueId }, a.limit ?? 10)));

  server.registerTool("mem_stats",
    { description: "Memory index size — chunk count and approximate token usage (capacity guard signal)",
      inputSchema: {} },
    wrap(() => getMemIndex().stats()));

  server.registerTool("mem_card_create",
    { description: "Write a durable memory card (decision/constraint/gotcha/reference) with provenance",
      inputSchema: {
        type: z.enum(["decision", "constraint", "gotcha", "reference"]),
        body: z.string(),
        scopePhase: z.number().int().optional(),
        scopeIssue: z.string().optional(),
        provenance: z.array(z.object({ file: z.string(), commit: z.string() })).optional(),
      } },
    wrap((a: { type: "decision" | "constraint" | "gotcha" | "reference"; body: string;
               scopePhase?: number; scopeIssue?: string;
               provenance?: Array<{ file: string; commit: string }> }) =>
      createCard(deps.projectDir, a)));

  server.registerTool("mem_card_list",
    { description: "List memory cards, optionally filtered by phase/issue scope",
      inputSchema: { scopePhase: z.number().int().optional(), scopeIssue: z.string().optional() } },
    wrap((a: { scopePhase?: number; scopeIssue?: string }) => listCards(deps.projectDir, a)));

  server.registerTool("mem_card_recall",
    { description: "List memory cards with staleness checked against their provenance (the anti-rot check)",
      inputSchema: { scopePhase: z.number().int().optional(), scopeIssue: z.string().optional() } },
    wrap((a: { scopePhase?: number; scopeIssue?: string }) =>
      listCards(deps.projectDir, a).map((card) => {
        const provenance = card.frontmatter.provenanceFiles.map((file, i) => ({
          file, commit: card.frontmatter.provenanceCommits[i],
        }));
        const check = checkCardStaleness(deps.projectDir, provenance);
        return { ...card, stale: check.stale, staleReasons: check.reasons };
      })));

  return server;
}

// CLI entry — stdio transport; config loads lazily per tool call.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const server = buildServer({ projectDir });
  await server.connect(new StdioServerTransport());
}
