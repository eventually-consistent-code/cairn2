#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CairnError } from "./errors.js";
import { loadConfig, writeConfigPatch } from "./config.js";
import type { CairnConfig } from "./config.js";
import { ActiveContext } from "./active-context.js";
import { makeTracker } from "./tracker/registry.js";
import { CachedTracker } from "./tracker/cached.js";
import { probeVerdictForError } from "./tracker/probe.js";
import type { Tracker, IssuePatch, IssueState, LinkType, ProbeResult } from "./tracker/types.js";
import { danglingEdges, effectivePriorities, lineage, readyFrontier } from "./tracker/graph.js";
import { finalizeMigration, migrateTracker } from "./tracker/migrate.js";
import { makeDocsConnector } from "./docs/registry.js";
import type { DocsConnector } from "./docs/types.js";
import { defaultProjectName, publishTree } from "./docs/publish.js";
import {
  scaffoldProject, scaffoldPhase, writePlanIssues, readPlanMeta, writePlanMeta,
  isValidPhaseNumber, parsePhaseDirName, PHASE_NUMBER_ERROR,
} from "./planning/artifacts.js";
import { projectStatus } from "./planning/status.js";
import { driftReport, ensurePhase } from "./planning/mirror.js";
import { unplannedReport } from "./planning/collab.js";
import { importPhase } from "./planning/import.js";
import { milestoneCreate, milestoneList, milestoneComplete } from "./planning/milestones.js";
import { resyncReport } from "./planning/resync.js";
import { snapshotNote, trackerDelta } from "./planning/tracker-delta.js";
import { MemoryIndex, indexDbPath, type SearchResult } from "./memory/index-store.js";
import { createCard, listCards, readCard, updateCardConfidence } from "./memory/cards.js";
import { checkCardStaleness } from "./memory/staleness.js";
import { readHandoff, writeHandoff, clearHandoff } from "./core/continuity.js";
import type { Handoff } from "./core/continuity.js";
import { appendLedger } from "./planning/ledger.js";
import { writeBanner, bannerStats } from "./memory/banner.js";
import { startTrace, appendTrace, listTraces, closeTrace } from "./trace/store.js";
import { KIND_SPECS, appendSession, closeSession, sessionLandscape, startSession } from "./sessions/store.js";
import { planCheck } from "./planning/check.js";
import { writeAuditRecord, type AuditFinding } from "./audit/record.js";
import { mapGet, mapQuery, mapSet, type EdgeType, type MapEdge, type MapNode, type MapQuery, type NodeType } from "./map/store.js";
import { findWorkspace, resolveProjectDir, setFocus } from "./workspace/context.js";
import { boardGet, boardUpdate, type Workstream } from "./workspace/board.js";
import { PROVIDERS, peerList, peerRun, type Provider } from "./peers/run.js";
import {
  VERDICTS, runStart, runAbandon, runStatus, runClose,
  recordPeerOutput, recordFindings, recordVerdict, type Verdict,
} from "./peers/state.js";
import type { Finding } from "./peers/findings.js";
import { parseSections, flipSection, type SectionState } from "./research/sections.js";

// Widened (CRN-26): canonical three or a backend-defined custom state name.
const StateEnum = z.string().min(1);
const HandoffSourceEnum = z.enum(["tool", "posttooluse", "precompact", "waypoint"]);
// Phase numbers are widened to accept decimals (integers 1..99, or exactly
// one fractional digit .1-.9 with integer part 1..98 -- lets a phase slot in
// (1.5) between 1 and 2 without renumbering the roadmap). Deliberately NOT a
// Zod .refine() here: MCP SDK schema rejection happens before wrap() ever
// runs, so a refine failure surfaces as a raw SDK -32602 string, never the
// structured {code, message, nextAction} envelope every other CONFIG_INVALID
// case produces. plan_scaffold_phase/plan_phase_ensure let a bare z.number()
// through and rely on phaseDirName/ensurePhase (both call isValidPhaseNumber
// from planning/artifacts.ts) to throw a genuine CairnError, which wrap()
// converts correctly. continuity_checkpoint has no such downstream guard
// (writeHandoff doesn't validate), so its handler checks explicitly below.
const HandoffPhaseRefSchema = z.object({ number: z.number(), slug: z.string() });

// Shared handler-level guard for every plain-number phase param above (CRN-40:
// plan_check's phase filter, mem_index/mem_search's phase, mem_card_create/
// mem_card_list/mem_card_recall's scopePhase, context_set's phase all
// converge on this instead of each hand-rolling the same isValidPhaseNumber
// check). null/undefined pass through untouched -- context_set relies on
// null surviving here to still mean "clear the field".
const assertValidPhase = (n: number | null | undefined): void => {
  if (n !== null && n !== undefined && !isValidPhaseNumber(n)) {
    throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(n));
  }
};

// Zod mirrors of map/store.ts's NodeType/EdgeType/MapNode/MapEdge -- kept in
// sync by hand (the store module owns the types; this is just the MCP-layer
// schema for them, same duplication tradeoff as the mem_timeline helpers above).
const NodeTypeEnum = z.enum(["module", "phase", "issue", "decision", "person"]);
const EdgeTypeEnum = z.enum(["depends-on", "implements", "decided-in", "owns"]);
const NodeSchema = z.object({ type: NodeTypeEnum, label: z.string(), detail: z.string().optional() });
const EdgeSchema = z.object({ from: z.string(), to: z.string(), type: EdgeTypeEnum });

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

// mem_timeline support -- title/cost derivation mirrors memory/banner.ts's private
// helpers (duplicated rather than exported to keep this task's footprint to the
// files it's scoped to).
function timelineCardTitle(body: string): string {
  const firstLine = (body.split("\n")[0] ?? "").trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}
function timelineCardCost(body: string): number {
  return Math.ceil(body.length / 4);
}

interface TimelineCardItem { id: string; type: string; title: string; created: string; cost: number }
interface TimelineChunkItem { source: string; createdAt: string }
type TimelineItem = TimelineCardItem | TimelineChunkItem;

const timelineCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Cards carry a day-precision `created` string; chunks carry a full ISO `createdAt`
// string. Comparing them as plain strings is the "day-precision caveat" the tool
// description calls out: same-day chunks sort after same-day cards (a day string
// is a lexicographic prefix of, and therefore less than, any timestamp on that same
// day). Same-day cards are true ties, so they tie-break on id.
const timelineSortKey = (item: TimelineItem): [string, string] =>
  "created" in item ? [item.created, item.id] : [item.createdAt, item.source];

const timelineMergeSort = (items: TimelineItem[]): TimelineItem[] =>
  [...items].sort((a, b) => {
    const [ka, sa] = timelineSortKey(a);
    const [kb, sb] = timelineSortKey(b);
    return ka === kb ? timelineCmp(sa, sb) : timelineCmp(ka, kb);
  });

export function buildServer(deps: {
  projectDir: string; tracker?: Tracker; docsConnector?: DocsConnector;
}): McpServer {
  const server = new McpServer({ name: "cairn", version: VERSION });

  // Workspace resolution: the injected projectDir is the LAUNCH dir, fixed for the
  // server's lifetime. Every tool call resolves its effective project dir
  // through dir() -- workspace focus redirects it, no workspace (or no focus)
  // falls through to the launch dir byte-identically (single-project compat).
  const launchDir = deps.projectDir;
  const dir = (): string => resolveProjectDir(launchDir);

  // Per-dir memos -- focus can move between members mid-session, so trackers,
  // memory indexes, and active context all key off the resolved dir, never a
  // build-time singleton. A test-injected tracker binds to the launch dir.
  const trackers = new Map<string, Tracker>();
  if (deps.tracker) trackers.set(launchDir, deps.tracker);
  // Accepts an optional pre-resolved dir -- handlers that already snapshotted
  // `dir()` once (to survive a mid-call workspace_focus flip) pass it through
  // here instead of letting this resolve dir() again on its own.
  const getTracker = async (dOverride?: string): Promise<Tracker> => {
    const d = dOverride ?? dir();
    let t = trackers.get(d);
    if (!t) {
      t = new CachedTracker(await makeTracker(loadConfig(d), d));
      trackers.set(d, t);
    }
    return t;
  };

  // Docs connectors memo per resolved dir, same lifecycle as trackers.
  const docsConnectors = new Map<string, DocsConnector>();
  if (deps.docsConnector) docsConnectors.set(launchDir, deps.docsConnector);
  const getDocsConnector = async (dOverride?: string): Promise<DocsConnector> => {
    const d = dOverride ?? dir();
    let c = docsConnectors.get(d);
    if (!c) {
      c = await makeDocsConnector(loadConfig(d));
      docsConnectors.set(d, c);
    }
    return c;
  };

  const getCtx = (d: string = dir()): ActiveContext => new ActiveContext(d);

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

  // Best-effort handoff refresh for the write-through points below. Continuity
  // is a hint, never authority (trust order: tracker + git > ledger > handoff)
  // -- so a refresh failure (unwritable ~/.cairn/handoff, corrupt file, etc.)
  // must never fail the primary tool call that triggered it.
  const refreshHandoff = (patch: Partial<Handoff> & { source: Handoff["source"] },
                           d: string = dir()): void => {
    try {
      writeHandoff(d, patch);
    } catch {
      // swallowed by design -- see comment above.
    }
  };

  // Resolves a phase number to the {number, slug} shape the handoff wants, by
  // matching against locally scaffolded phase dirs (NN-slug). Returns
  // undefined when the phase hasn't been scaffolded locally -- best-effort,
  // same spirit as the rest of write-through refresh.
  const phaseHandoffRef = (number: number, d: string = dir()): { number: number; slug: string } | undefined => {
    const match = projectStatus(d).phases.find((p) => p.number === number);
    return match ? { number, slug: parsePhaseDirName(match.dir)?.slug ?? match.dir } : undefined;
  };

  server.registerTool("context_get",
    { description: "Get the active cairn context (phase, issue)", inputSchema: {} },
    wrap(() => getCtx().get()));

  server.registerTool("context_set",
    { description: "Set/clear active cairn context fields (null clears)",
      inputSchema: { phase: z.number().nullable().optional(),
                     issueId: z.string().nullable().optional() } },
    wrap((a: { phase?: number | null; issueId?: string | null }) => {
      // CRN-40: reject an invalid phase number (over-precise decimal, etc.)
      // as a structured CONFIG_INVALID before it ever reaches active-context
      // -- null still passes through untouched (that's the clear-the-field
      // signal handled below).
      assertValidPhase(a.phase);
      // Snapshot once -- this handler touches active-context, handoff, and the
      // banner; a workspace_focus flip mid-call must not split those three
      // writes across two different member projects.
      const d = dir();
      const ctx = getCtx(d);
      ctx.set(a);
      const state = ctx.get();
      const patch: Partial<Handoff> & { source: Handoff["source"] } = { source: "tool" };
      // Explicit null means "clear this field" -- map it to an own-property `undefined`
      // on the patch so the {...base, ...patch} merge in writeHandoff overwrites the
      // stale value and JSON.stringify drops it, instead of silently omitting the key
      // (which would leave the prior phase/issue in the handoff forever).
      if (a.phase === null) {
        patch.phase = undefined;
      } else if (a.phase !== undefined && state.phase !== undefined) {
        const ref = phaseHandoffRef(state.phase, d);
        if (ref) patch.phase = ref;
      }
      if (a.issueId === null) {
        patch.issue = undefined;
      } else if (a.issueId !== undefined) {
        patch.issue = state.issueId;
      }
      refreshHandoff(patch, d);
      writeBanner(d);
      return state;
    }));

  server.registerTool("issue_create",
    { description: "Create an issue in the configured tracker. Estimates "
        + "(story points / original minutes) land in the backend's native "
        + "fields where supported; elsewhere they're skipped and the result "
        + "says so via estimateSkipped",
      inputSchema: { title: z.string(), body: z.string().optional(),
                     labels: z.array(z.string()).optional(),
                     phase: z.string().optional(),
                     estimatePoints: z.number().positive().optional(),
                     estimateMinutes: z.number().int().positive().optional() } },
    wrap(async (a: { title: string; body?: string; labels?: string[]; phase?: string;
      estimatePoints?: number; estimateMinutes?: number }) => {
      const d = dir();
      const { estimatePoints, estimateMinutes, ...input } = a;
      const wantsEstimate = estimatePoints !== undefined || estimateMinutes !== undefined;
      const tracker = await getTracker(d);
      const estimate = wantsEstimate && tracker.capabilities.hasEstimates
        ? { points: estimatePoints, minutes: estimateMinutes } : undefined;
      const result = await tracker.createIssue({ ...input, estimate });
      snapshotNote(d, result);
      // mirrors the worklogError note on issue_close -- a silently dropped
      // estimate reads as a bug, so say why it never reached the backend.
      const estimateSkipped = wantsEstimate && !tracker.capabilities.hasEstimates
        ? "backend has no estimate support; fold points/minutes into the issue body"
        : undefined;
      return { ...result, ...(estimateSkipped ? { estimateSkipped } : {}) };
    }));

  server.registerTool("issue_get",
    { description: "Fetch one issue", inputSchema: { id: z.string() } },
    wrap(async (a: { id: string }) => (await getTracker()).getIssue(a.id)));

  server.registerTool("issue_update",
    { description: "Update an issue (title/body/state/labels/assignee/estimate)",
      inputSchema: { id: z.string(), title: z.string().optional(),
                     body: z.string().optional(), state: StateEnum.optional(),
                     labels: z.array(z.string()).optional(),
                     assignee: z.string().optional(),
                     estimatePoints: z.number().positive().optional(),
                     estimateMinutes: z.number().int().positive().optional() } },
    wrap(async (a: { id: string; title?: string; body?: string; state?: IssueState;
               labels?: string[]; assignee?: string;
               estimatePoints?: number; estimateMinutes?: number }) => {
      const d = dir();
      const { id, estimatePoints, estimateMinutes, ...rest } = a;
      const wantsEstimate = estimatePoints !== undefined || estimateMinutes !== undefined;
      const tracker = await getTracker(d);
      const patch: IssuePatch = wantsEstimate && tracker.capabilities.hasEstimates
        ? { ...rest, estimate: { points: estimatePoints, minutes: estimateMinutes } }
        : rest;
      let autoAssigned = false;
      if (patch.state === "in_progress" && patch.assignee === undefined) {
        // best-effort claim attribution — identity failures never block the claim
        try {
          const current = await tracker.getIssue(id);
          if (!current.assignee) {
            const who = loadConfig(d).user?.handle ?? await tracker.resolveSelf?.();
            if (who) { patch.assignee = who; autoAssigned = true; }
          }
        } catch { /* claim proceeds unassigned */ }
      }
      const result = await tracker.updateIssue(id, patch);
      snapshotNote(d, result);
      refreshHandoff({ source: "tool", issue: id }, d);
      // mirrors the worklogError note on issue_close -- a silently dropped
      // estimate reads as a bug, so say why it never reached the backend.
      const estimateSkipped = wantsEstimate && !tracker.capabilities.hasEstimates
        ? "backend has no estimate support; fold points/minutes into the issue body"
        : undefined;
      return { ...result, ...(autoAssigned ? { autoAssigned: true } : {}),
        ...(estimateSkipped ? { estimateSkipped } : {}) };
    }));

  const LinkTypeEnum = z.enum(["blocks", "parent-of", "relates-to", "supersedes"]);

  const linkCapable = async (): Promise<Tracker> => {
    const t = await getTracker(dir());
    if (!t.capabilities.hasDependencies || !t.linkIssues) {
      throw new CairnError("UNSUPPORTED", "this tracker has no dependency links",
        "issue links need a backend with hasDependencies (e.g. tracker.type: local)");
    }
    return t;
  };

  server.registerTool("issue_link",
    { description: "Link two issues (blocks/parent-of/relates-to/supersedes); "
        + "UNSUPPORTED unless the tracker hasDependencies",
      inputSchema: { from: z.string(), type: LinkTypeEnum, to: z.string() } },
    wrap(async (a: { from: string; type: LinkType; to: string }) => {
      const t = await linkCapable();
      await t.linkIssues!(a.from, a.type, a.to);
      return { linked: { from: a.from, type: a.type, to: a.to } };
    }));

  server.registerTool("issue_unlink",
    { description: "Remove an issue link; UNSUPPORTED unless the tracker hasDependencies",
      inputSchema: { from: z.string(), type: LinkTypeEnum, to: z.string() } },
    wrap(async (a: { from: string; type: LinkType; to: string }) => {
      const t = await linkCapable();
      await t.unlinkIssues!(a.from, a.type, a.to);
      return { unlinked: { from: a.from, type: a.type, to: a.to } };
    }));

  server.registerTool("issue_links",
    { description: "List issue links — for one issue (either direction) or the whole project",
      inputSchema: { id: z.string().optional() } },
    wrap(async (a: { id?: string }) => {
      const t = await linkCapable();
      return { links: await t.listLinks!(a.id) };
    }));

  server.registerTool("graph_report",
    { description: "Dependency-graph report: ready frontier (open issues with no open "
        + "blockers), inherited effective priorities, dangling edges, and optionally "
        + "one issue's supersedes lineage. UNSUPPORTED unless the tracker hasDependencies",
      inputSchema: { lineageOf: z.string().optional() } },
    wrap(async (a: { lineageOf?: string }) => {
      const t = await linkCapable();
      const [issues, links] = await Promise.all([t.listIssues(), t.listLinks!()]);
      return {
        frontier: readyFrontier(issues, links),
        priorities: effectivePriorities(issues, links),
        dangling: danglingEdges(issues, links),
        ...(a.lineageOf ? { lineage: lineage(issues, links, a.lineageOf) } : {}),
      };
    }));

  server.registerTool("tracker_migrate",
    { description: "Promote a local-tracker project to a hosted backend: phases, "
        + "issues, comments, worklogs, and links carry over with an id remap and "
        + "provenance backlinks. Source must be tracker.type: local. dryRun reports "
        + "what would migrate without writing anything.",
      inputSchema: {
        targetType: z.enum(["github", "gitlab", "jira", "asana", "azure-boards", "clickup", "linear"]),
        targetConfig: z.record(z.unknown()),
        dryRun: z.boolean().optional(),
      } },
    wrap(async (a: { targetType: string; targetConfig: Record<string, unknown>;
      dryRun?: boolean }) => {
      const d = dir();
      const cfg = loadConfig(d);
      if (cfg.tracker.type !== "local") {
        throw new CairnError("CONFIG_INVALID",
          `source tracker is not local (found '${cfg.tracker.type}')`,
          "tracker_migrate promotes a local store; nothing to do here");
      }
      const src = await getTracker(d);
      if (a.dryRun) {
        const [issues, phases, links] = await Promise.all([
          src.listIssues(), src.listPhases(), src.listLinks?.() ?? []]);
        return { dryRun: true, wouldMigrate: {
          phases: phases.length, issues: issues.length, links: links.length } };
      }
      const dst = await makeTracker({
        ...cfg, tracker: { type: a.targetType, config: a.targetConfig },
      } as CairnConfig, d);
      const result = await migrateTracker(src, dst);
      const storeDir = resolve(d, (cfg.tracker.config as { dir?: string }).dir ?? ".tracker");
      const recordPath = finalizeMigration(storeDir, a.targetType, result);
      return { ...result, record: recordPath };
    }));

  server.registerTool("issue_close",
    { description: "Close an issue; optionally log time spent (worklog on supporting "
        + "backends, otherwise the caller folds time into the close comment)",
      inputSchema: { id: z.string(), timeSpentMinutes: z.number().int().positive().optional() } },
    wrap(async (a: { id: string; timeSpentMinutes?: number }) => {
      const d = dir();
      const tracker = await getTracker(d);
      const result = await tracker.closeIssue(a.id);
      snapshotNote(d, result);
      let worklogLogged = false;
      let worklogError: string | undefined;
      if (a.timeSpentMinutes && tracker.capabilities.hasWorklog && tracker.logWork) {
        try {
          await tracker.logWork(a.id, a.timeSpentMinutes);
          worklogLogged = true;
        } catch (e) {
          // worklog is best-effort — the close comment already carries the time
          // line as fallback, so a worklog failure must never fail the close.
          worklogError = e instanceof Error ? e.message : String(e);
        }
      } else if (a.timeSpentMinutes) {
        // a silent worklogLogged:false is indistinguishable from a bug — say
        // why the worklog was skipped so the time isn't presumed recorded.
        worklogError = tracker.capabilities.hasWorklog
          ? "tracker advertises hasWorklog but exposes no logWork method"
          : "backend has no worklog support; time recorded in the close comment only";
      }
      refreshHandoff({ source: "tool", issue: a.id }, d);
      return { ...result, worklogLogged, ...(worklogError ? { worklogError } : {}) };
    }));

  server.registerTool("issue_list",
    { description: "List issues, optionally by phase/state (state matches the semantic category — open/in_progress/closed — or an exact state name)",
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
    wrap((a: { name: string }) => scaffoldProject(dir(), a.name)));

  server.registerTool("plan_scaffold_phase",
    { description: "Create phases/NN-slug/ (or NN.F-slug/ for a decimal insert) with "
        + "CONTEXT.md + PLAN.md (+RESEARCH.md)",
      inputSchema: { number: z.number(), name: z.string(),
                     research: z.boolean().optional() } },
    wrap((a: { number: number; name: string; research?: boolean }) =>
      scaffoldPhase(dir(), a.number, a.name, { research: a.research })));

  server.registerTool("plan_status",
    { description: "Phases, artifact presence, and referenced tracker issues",
      inputSchema: {} },
    wrap(() => projectStatus(dir())));

  server.registerTool("plan_phase_ensure",
    { description: "Ensure the tracker has a phase named 'Phase N: <name>' (idempotent)",
      inputSchema: { number: z.number(), name: z.string() } },
    wrap(async (a: { number: number; name: string }) =>
      ensurePhase(await getTracker(), a.number, a.name)));

  server.registerTool("plan_drift",
    { description: "Flag plan-referenced issues that are missing or closed-unverified",
      inputSchema: {} },
    wrap(async () => {
      const d = dir();
      return driftReport(await getTracker(d), d);
    }));

  server.registerTool("plan_issues_set",
    { description: "Set the tracker issue ids a phase's PLAN.md advances",
      inputSchema: { phaseDir: z.string(), issues: z.array(z.string()) } },
    wrap((a: { phaseDir: string; issues: string[] }) => {
      const parsed = parsePhaseDirName(a.phaseDir);
      if (!parsed) {
        throw new CairnError("CONFIG_INVALID",
          `phaseDir must look like 01-name or 01.5-name, got '${a.phaseDir}'`);
      }
      const d = dir();
      const planPath = join(d, ".cairn", "plans", "phases", a.phaseDir, "PLAN.md");
      if (!existsSync(planPath)) {
        throw new CairnError("NOT_FOUND",
          `no PLAN.md at phaseDir '${a.phaseDir}' — scaffold it first with plan_scaffold_phase`);
      }
      writePlanIssues(d, a.phaseDir, a.issues);
      refreshHandoff({
        source: "tool",
        phase: { number: parsed.number, slug: parsed.slug },
        plan: join(".cairn", "plans", "phases", a.phaseDir, "PLAN.md"),
      }, d);
      return { ok: true };
    }));

  const memIndexes = new Map<string, MemoryIndex>();
  const getMemIndex = (d: string = dir()): MemoryIndex => {
    const path = indexDbPath(d);
    let idx = memIndexes.get(path);
    if (!idx) {
      idx = new MemoryIndex(path);
      memIndexes.set(path, idx);
    }
    return idx;
  };

  server.registerTool("mem_index",
    { description: "Index reference material into the searchable memory store (disposable, rebuildable)",
      inputSchema: { content: z.string(), source: z.string(),
                     // CRN-40: widened from .int() -- a decimal phase (1.5) must
                     // tag a memory chunk same as an integer one. Deliberately not
                     // a Zod .refine() -- see the HandoffPhaseRefSchema comment
                     // above for why that produces a raw SDK -32602 instead of a
                     // structured CONFIG_INVALID envelope.
                     phase: z.number().optional(), issueId: z.string().optional() } },
    wrap((a: { content: string; source: string; phase?: number; issueId?: string }) => {
      assertValidPhase(a.phase);
      getMemIndex().index({
        content: a.content, source: a.source,
        phase: a.phase ?? null, issueId: a.issueId ?? null,
        createdAt: new Date().toISOString(),
      });
      return { ok: true };
    }));

  server.registerTool("mem_search",
    { description: "Full-text search the memory index, optionally scoped to a phase/issue",
      inputSchema: { query: z.string(), phase: z.number().optional(), // CRN-40: widened from .int()
                     issueId: z.string().optional(), limit: z.number().int().positive().optional() } },
    wrap((a: { query: string; phase?: number; issueId?: string; limit?: number }) => {
      assertValidPhase(a.phase);
      return getMemIndex().search(a.query, { phase: a.phase, issueId: a.issueId }, a.limit ?? 10);
    }));

  server.registerTool("mem_stats",
    { description: "Memory index size — chunk count and approximate token usage (capacity guard signal), "
        + "plus recall-banner token accounting",
      inputSchema: {} },
    wrap(() => {
      const d = dir();
      return { ...getMemIndex(d).stats(), ...bannerStats(d) };
    }));

  server.registerTool("mem_card_create",
    { description: "Write a durable memory card (decision/constraint/gotcha/reference/note) with provenance",
      inputSchema: {
        type: z.enum(["decision", "constraint", "gotcha", "reference", "note"]),
        body: z.string(),
        scopePhase: z.number().optional(), // CRN-40: widened from .int()
        scopeIssue: z.string().optional(),
        confidence: z.enum(["high", "medium", "low"]).optional(),
        provenance: z.array(z.object({ file: z.string(), commit: z.string() })).optional(),
      } },
    wrap((a: { type: "decision" | "constraint" | "gotcha" | "reference" | "note"; body: string;
               scopePhase?: number; scopeIssue?: string; confidence?: "high" | "medium" | "low";
               provenance?: Array<{ file: string; commit: string }> }) => {
      assertValidPhase(a.scopePhase);
      const d = dir();
      const card = createCard(d, a);
      const patch: Partial<Handoff> & { source: Handoff["source"] } = { source: "tool" };
      if (a.scopePhase !== undefined) {
        const ref = phaseHandoffRef(a.scopePhase, d);
        if (ref) patch.phase = ref;
      }
      if (a.scopeIssue !== undefined) patch.issue = a.scopeIssue;
      refreshHandoff(patch, d);
      writeBanner(d);
      return card;
    }));

  server.registerTool("mem_card_list",
    { description: "List memory cards, optionally filtered by phase/issue scope",
      inputSchema: { scopePhase: z.number().optional(), scopeIssue: z.string().optional() } }, // CRN-40: widened from .int()
    wrap((a: { scopePhase?: number; scopeIssue?: string }) => {
      assertValidPhase(a.scopePhase);
      return listCards(dir(), a);
    }));

  server.registerTool("mem_card_recall",
    { description: "List memory cards with staleness checked against their provenance (the anti-rot check)",
      inputSchema: { scopePhase: z.number().optional(), scopeIssue: z.string().optional() } }, // CRN-40: widened from .int()
    wrap((a: { scopePhase?: number; scopeIssue?: string }) => {
      assertValidPhase(a.scopePhase);
      const d = dir();
      return listCards(d, a).map((card) => {
        const provenance = card.frontmatter.provenanceFiles.map((file, i) => ({
          file, commit: card.frontmatter.provenanceCommits[i],
        }));
        const check = checkCardStaleness(d, provenance);
        return { ...card, stale: check.stale, staleReasons: check.reasons };
      });
    }));

  server.registerTool("mem_card_update",
    { description: "Adjust a memory card's confidence (frontmatter-only; body and id are immutable)",
      inputSchema: { id: z.string(),
                     confidence: z.enum(["high", "medium", "low"]) } },
    wrap((a: { id: string; confidence: "high" | "medium" | "low" }) => {
      const d = dir();
      const card = updateCardConfidence(d, a.id, a.confidence);
      writeBanner(d);
      return card;
    }));

  server.registerTool("mem_timeline",
    { description: "Chronological neighbors around an anchor (a memory card id or an index chunk source) -- "
        + "answers \"what was happening around this decision?\" at index cost. Day-precision caveat: cards "
        + "carry a day-precision created date while index chunks carry a full ISO timestamp, so entries are "
        + "ordered by whatever precision they actually carry (a same-day chunk timestamp sorts after a "
        + "same-day card); same-day cards tie-break by id.",
      inputSchema: {
        anchor: z.string(),
        before: z.number().int().nonnegative().optional(),
        after: z.number().int().nonnegative().optional(),
      } },
    wrap((a: { anchor: string; before?: number; after?: number }) => {
      // Snapshot once -- this handler resolves the dir up to four times
      // (card lookup, chunk lookup, card list, chunk timeline); a mid-call
      // focus flip must not stitch a timeline together from two members.
      const d = dir();
      const before = a.before ?? 3;
      const after = a.after ?? 3;

      let anchorCreatedAt: string;
      let anchorCardId: string | undefined;
      try {
        const card = readCard(d, a.anchor);
        anchorCreatedAt = card.frontmatter.created;
        anchorCardId = card.id;
      } catch {
        const chunkCreatedAt = getMemIndex(d).sourceCreatedAt(a.anchor);
        if (chunkCreatedAt === undefined) {
          throw new CairnError("NOT_FOUND", `no card or index chunk '${a.anchor}'`,
            "check the id with mem_card_list or the source with mem_search");
        }
        anchorCreatedAt = chunkCreatedAt;
      }

      const isBeforeAnchor = (created: string, id: string): boolean =>
        created < anchorCreatedAt
        || (created === anchorCreatedAt && anchorCardId !== undefined && id < anchorCardId);
      const isAfterAnchor = (created: string, id: string): boolean =>
        created > anchorCreatedAt
        || (created === anchorCreatedAt && anchorCardId !== undefined && id > anchorCardId);

      const cardItems: TimelineCardItem[] = listCards(d)
        .filter((c) => c.id !== anchorCardId)
        .map((c) => ({
          id: c.id, type: c.frontmatter.type, title: timelineCardTitle(c.body),
          created: c.frontmatter.created, cost: timelineCardCost(c.body),
        }));
      const cardsBefore = cardItems.filter((c) => isBeforeAnchor(c.created, c.id));
      const cardsAfter = cardItems.filter((c) => isAfterAnchor(c.created, c.id));

      const chunkNeighbors: SearchResult[] = getMemIndex(d).timeline(anchorCreatedAt, before, after);
      const chunksBefore: TimelineChunkItem[] = chunkNeighbors
        .filter((c) => c.createdAt < anchorCreatedAt)
        .map((c) => ({ source: c.source, createdAt: c.createdAt }));
      const chunksAfter: TimelineChunkItem[] = chunkNeighbors
        .filter((c) => c.createdAt > anchorCreatedAt)
        .map((c) => ({ source: c.source, createdAt: c.createdAt }));

      const beforeMerged = before > 0
        ? timelineMergeSort([...cardsBefore, ...chunksBefore]).slice(-before) : [];
      const afterMerged = after > 0
        ? timelineMergeSort([...cardsAfter, ...chunksAfter]).slice(0, after) : [];

      return [...beforeMerged, ...afterMerged];
    }));

  server.registerTool("plan_unplanned",
    { description: "Tracker issues (non-closed) that no phase's PLAN.md references — work at risk of being missed",
      inputSchema: {} },
    wrap(async () => {
      const d = dir();
      return unplannedReport(await getTracker(d), d);
    }));

  server.registerTool("plan_import",
    { description: "Reverse-mirror a tracker phase (by id or name substring) into .cairn/plans/ artifacts",
      inputSchema: { phaseRef: z.string() } },
    wrap(async (a: { phaseRef: string }) => {
      const d = dir();
      const result = await importPhase(await getTracker(d), d, a.phaseRef);
      refreshHandoff({
        source: "tool",
        phase: { number: result.number, slug: parsePhaseDirName(result.dir)?.slug ?? result.dir },
        plan: join(".cairn", "plans", "phases", result.dir, "PLAN.md"),
      }, d);
      return result;
    }));

  server.registerTool("continuity_checkpoint",
    { description: "Write/refresh the session handoff (checkpoint) for this project",
      inputSchema: {
        source: HandoffSourceEnum.optional(),
        phase: HandoffPhaseRefSchema.optional(),
        issue: z.string().optional(),
        plan: z.string().optional(),
        task: z.object({ current: z.string(), title: z.string() }).optional(),
        tasks_completed: z.array(z.string()).optional(),
        tasks_remaining: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
        decisions_in_flight: z.array(z.string()).optional(),
        uncommitted_files: z.array(z.string()).optional(),
        next_action: z.string().optional(),
        notes: z.string().optional(),
        partial: z.boolean().optional(),
      } },
    wrap((a: Partial<Handoff>) => {
      // writeHandoff doesn't independently validate -- unlike phaseDirName/
      // ensurePhase, there's no downstream CairnError to catch a bad phase
      // number here, so check explicitly before it ever reaches disk.
      if (a.phase && !isValidPhaseNumber(a.phase.number)) {
        throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(a.phase.number));
      }
      const d = dir();
      writeHandoff(d, { ...a, source: a.source ?? "tool" });
      return readHandoff(d);
    }));

  server.registerTool("continuity_get",
    { description: "Read the current session handoff, if any (flags handoffs older than 14 days as stale, never errors on staleness)",
      inputSchema: {} },
    wrap(() => readHandoff(dir())));

  server.registerTool("continuity_clear",
    { description: "Delete the session handoff for this project, if any",
      inputSchema: {} },
    wrap(() => ({ cleared: clearHandoff(dir()) })));

  server.registerTool("ledger_append",
    { description: "Append a verified-task line to a phase's LEDGER.md (append-only; creates the file with a header on first write)",
      inputSchema: {
        phaseDir: z.string(),
        taskRef: z.string(),
        summary: z.string(),
        baseCommit: z.string(),
        headCommit: z.string(),
        issueId: z.string(),
        closedDate: z.string(),
        redCommit: z.string().optional(),
        greenCommit: z.string().optional(),
      } },
    wrap((a: { phaseDir: string; taskRef: string; summary: string; baseCommit: string;
               headCommit: string; issueId: string; closedDate: string;
               redCommit?: string; greenCommit?: string }) => {
      const d = dir();
      const { phaseDir, ...entry } = a;
      const result = appendLedger(d, phaseDir, entry);
      const parsed = parsePhaseDirName(phaseDir);
      refreshHandoff({
        source: "tool",
        phase: { number: parsed?.number ?? Number(phaseDir.slice(0, 2)),
                 slug: parsed?.slug ?? phaseDir.slice(3) },
        issue: entry.issueId,
      }, d);
      return result;
    }));

  server.registerTool("milestone_create",
    { description: "Start the next milestone — native tracker object when the backend supports it; stamps milestone_id into roadmap.md",
      inputSchema: { name: z.string() } },
    wrap(async (a: { name: string }) => {
      const d = dir();
      return milestoneCreate(await getTracker(d), d, a.name);
    }));

  server.registerTool("milestone_list",
    { description: "Current milestone number, archived milestones, and the tracker's native list when supported",
      inputSchema: {} },
    wrap(async () => {
      const d = dir();
      return milestoneList(await getTracker(d), d);
    }));

  server.registerTool("milestone_complete",
    { description: "Complete the current milestone: gate on all-phases-verified, close tracker phases, "
        + "release the native milestone when supported, archive phases/ to milestones/vN/, bump roadmap. "
        + "Idempotent — safe to re-run after a partial tracker failure",
      inputSchema: { summary: z.string() } },
    wrap(async (a: { summary: string }) => {
      const d = dir();
      return milestoneComplete(await getTracker(d), d, a.summary);
    }));

  server.registerTool("plan_resync",
    { description: "Detect out-of-band commits (covered by no LEDGER.md range) since the last resync marker; "
        + "advances the marker. First run initializes the marker and reports nothing",
      inputSchema: {} },
    wrap(() => resyncReport(dir())));

  server.registerTool("plan_tracker_delta",
    { description: "Diff the live tracker against the last-seen snapshot cursor: new issues/phases, "
        + "field edits, external state changes. Peek by default; ack: true advances the cursor. "
        + "First run initializes the cursor and reports nothing",
      inputSchema: { ack: z.boolean().optional() } },
    wrap(async (a: { ack?: boolean }) => {
      const d = dir();
      return trackerDelta(d, await getTracker(d), { ack: a.ack });
    }));

  server.registerTool("plan_meta_set",
    { description: "Set wave grouping (wave_N frontmatter) and/or the TDD-eligible task list on a phase's PLAN.md",
      inputSchema: { phaseDir: z.string(),
                     waves: z.array(z.array(z.string())).optional(),
                     tdd: z.array(z.string()).optional() } },
    wrap((a: { phaseDir: string; waves?: string[][]; tdd?: string[] }) => {
      const parsed = parsePhaseDirName(a.phaseDir);
      if (!parsed) {
        throw new CairnError("CONFIG_INVALID",
          `phaseDir must look like 01-name or 01.5-name, got '${a.phaseDir}'`);
      }
      const d = dir();
      writePlanMeta(d, a.phaseDir, { waves: a.waves, tdd: a.tdd });
      refreshHandoff({
        source: "tool",
        phase: { number: parsed.number, slug: parsed.slug },
      }, d);
      return { ok: true, ...readPlanMeta(d, a.phaseDir) };
    }));

  server.registerTool("config_get",
    { description: "Read cairn.json as the validated, post-defaults effective config",
      inputSchema: {} },
    wrap(() => loadConfig(dir())));

  server.registerTool("config_set",
    { description: "Merge-patch cairn.json (null deletes a key). Validates the merged result before "
        + "writing; refuses secret-looking keys/values — credentials live in env vars",
      inputSchema: { patch: z.record(z.unknown()) } },
    wrap((a: { patch: Record<string, unknown> }) => {
      const d = dir();
      const result = writeConfigPatch(d, a.patch);
      // The tracker memo binds an adapter to the config it was built from --
      // a config write may change backend or baseUrl, so drop it and let the
      // next call rebuild. A test-injected tracker is config-independent.
      if (!(deps.tracker && d === launchDir)) trackers.delete(d);
      if (!(deps.docsConnector && d === launchDir)) docsConnectors.delete(d);
      return result;
    }));

  // Best-effort probe runner: construction failures (bad adapter type/config,
  // CONFIG_MISSING, an import that fails to load) are exactly as much "the
  // backend isn't reachable right now" as a network error mid-call, so they
  // fold into the same verdict mapping instead of a distinct failure shape.
  const safeProbe = async (fn: () => Promise<ProbeResult>): Promise<ProbeResult> => {
    try {
      return await fn();
    } catch (e) {
      return probeVerdictForError(e);
    }
  };

  server.registerTool("config_probe",
    { description: "Credential preflight (CRN-48) -- one cheap authenticated call to the configured "
        + "tracker (and docs connector, when configured), each mapped to a specific verdict: "
        + "ok / bad_host / bad_token / missing_scope / rate_limited / down. A probe failure IS "
        + "the result -- this tool never throws for a bad backend",
      inputSchema: {} },
    wrap(async () => {
      const d = dir();
      const tracker: { tracker: ProbeResult } = {
        tracker: await safeProbe(async () => {
          const t = await getTracker(d);
          return t.probe ? t.probe() : { verdict: "ok" };
        }),
      };
      const cfg = loadConfig(d);
      if (!cfg.docs) return tracker;
      const docs = await safeProbe(async () => {
        const connector = await getDocsConnector(d);
        return connector.probe ? connector.probe() : { verdict: "ok" };
      });
      return { ...tracker, docs };
    }));

  server.registerTool("issue_comment",
    { description: "Post a plain-language comment on a tracker issue (management-visible progress note)",
      inputSchema: { id: z.string(), text: z.string() } },
    wrap(async (a: { id: string; text: string }) =>
      (await getTracker()).commentIssue(a.id, a.text)));

  const ATTACH_MEDIA_TYPES: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".pdf": "application/pdf", ".txt": "text/plain",
  };
  server.registerTool("issue_attach",
    { description: "Attach a file (screenshot, render, visual evidence) to a tracker issue. "
        + "UNSUPPORTED on backends without native attachments",
      inputSchema: { id: z.string(), path: z.string(),
                     filename: z.string().optional() } },
    wrap(async (a: { id: string; path: string; filename?: string }) => {
      const d = dir();
      const tracker = await getTracker(d);
      if (!tracker.capabilities.hasIssueAttachments || !tracker.attachFile) {
        throw new CairnError("UNSUPPORTED", "this tracker has no attachment support",
          "attachments need a backend with hasIssueAttachments (jira, local)");
      }
      const abs = resolve(d, a.path);
      let data: Buffer;
      try {
        data = readFileSync(abs);
      } catch {
        throw new CairnError("NOT_FOUND", `no file at ${abs}`,
          "path resolves against the project directory");
      }
      const filename = a.filename ?? basename(abs);
      const mediaType = ATTACH_MEDIA_TYPES[extname(abs).toLowerCase()];
      return tracker.attachFile(a.id, filename, data, mediaType);
    }));

  server.registerTool("trace_start",
    { description: "Open a persistent debugging session (.cairn/trace/<id>.md). Creates the tracker "
        + "bug issue (label cairn:bug) when no issueId is given. Survives /clear by construction",
      inputSchema: { description: z.string(), issueId: z.string().optional() } },
    wrap(async (a: { description: string; issueId?: string }) => {
      const d = dir();
      let issueId = a.issueId;
      if (!issueId) {
        const issue = await (await getTracker(d)).createIssue({
          title: a.description, labels: ["cairn:bug"] });
        snapshotNote(d, issue);
        issueId = issue.id;
      }
      const { id } = startTrace(d, a.description, issueId);
      refreshHandoff({ source: "tool", issue: issueId }, d);
      return { id, issue: issueId };
    }));

  server.registerTool("trace_log",
    { description: "Append a typed entry (evidence|hypothesis|test|verdict) to an open trace — append-only",
      inputSchema: { id: z.string(),
                     kind: z.enum(["evidence", "hypothesis", "test", "verdict"]),
                     text: z.string().min(1) } },
    wrap((a: { id: string; kind: "evidence" | "hypothesis" | "test" | "verdict"; text: string }) => {
      const d = dir();
      const out = appendTrace(d, a.id, a.kind, a.text);
      refreshHandoff({ source: "tool" }, d);
      return out;
    }));

  server.registerTool("trace_list",
    { description: "List trace sessions (open and/or resolved) with entry counts",
      inputSchema: { status: z.enum(["open", "resolved"]).optional() } },
    wrap((a: { status?: "open" | "resolved" }) => listTraces(dir(), a.status)));

  server.registerTool("trace_close",
    { description: "Resolve a trace: requires a verdict entry; archives the session, comments the "
        + "resolution on the bug issue and closes it",
      inputSchema: { id: z.string(), resolution: z.string() } },
    wrap(async (a: { id: string; resolution: string }) => {
      const d = dir();
      const out = closeTrace(d, a.id, a.resolution);
      let issueClosed = false;
      if (out.issue) {
        const tracker = await getTracker(d);
        try {
          await tracker.commentIssue(out.issue, `Resolved: ${a.resolution}`);
        } catch {
          // comment is best-effort mirror; close is the state change that matters
        }
        const closed = await tracker.closeIssue(out.issue);
        snapshotNote(d, closed);
        issueClosed = true;
      }
      return { ...out, issueClosed };
    }));

  const registerSessionTools = (kind: "probe" | "draft" | "thread", label: string) => {
    const spec = KIND_SPECS[kind];
    server.registerTool(`${kind}_start`,
      { description: `Open a persistent ${kind} session (.cairn/${kind}/<id>.md). Creates the tracker `
          + `issue (label ${label}) when no issueId is given. Survives /clear by construction`,
        inputSchema: { description: z.string(), issueId: z.string().optional() } },
      wrap(async (a: { description: string; issueId?: string }) => {
        const d = dir();
        let issueId = a.issueId;
        if (!issueId) {
          const issue = await (await getTracker(d)).createIssue({
            title: a.description, labels: [label] });
          snapshotNote(d, issue);
          issueId = issue.id;
        }
        const active = getCtx(d).get();
        const phase = active.phase !== undefined ? String(active.phase) : undefined;
        const { id } = startSession(d, kind, a.description, issueId, phase);
        refreshHandoff({ source: "tool", issue: issueId }, d);
        return { id, issue: issueId };
      }));

    server.registerTool(`${kind}_log`,
      { description: `Append a typed entry (${spec.entryKinds.join("|")}) to an open ${kind} session — append-only`,
        inputSchema: { id: z.string(),
                       kind: z.enum(spec.entryKinds as [string, ...string[]]),
                       text: z.string().min(1) } },
      wrap((a: { id: string; kind: string; text: string }) => {
        const d = dir();
        const out = appendSession(d, kind, a.id, a.kind, a.text);
        refreshHandoff({ source: "tool" }, d);
        return out;
      }));

    server.registerTool(`${kind}_close`,
      { description: `Resolve a ${kind} session: requires a ${spec.closeGate} entry; archives it, comments `
          + `the resolution on the issue and closes it`,
        inputSchema: { id: z.string(), resolution: z.string() } },
      wrap(async (a: { id: string; resolution: string }) => {
        const d = dir();
        const out = closeSession(d, kind, a.id, a.resolution);
        let issueClosed = false;
        if (out.issue) {
          const tracker = await getTracker(d);
          try { await tracker.commentIssue(out.issue, `Resolved: ${a.resolution}`); }
          catch { /* best-effort mirror; close is the state change that matters */ }
          const closed = await tracker.closeIssue(out.issue);
          snapshotNote(d, closed);
          issueClosed = true;
        }
        return { ...out, issueClosed };
      }));
  };
  registerSessionTools("probe", "cairn:spike");
  registerSessionTools("draft", "cairn:sketch");
  registerSessionTools("thread", "cairn:thread");

  server.registerTool("session_landscape",
    { description: "Deterministic join over trace/probe/draft/thread sessions — open + resolved with "
        + "resolutions, counts by kind, phase linkage. Frontier-mode grounding: never re-propose "
        + "an archived stop-verdict probe",
      inputSchema: {} },
    wrap(() => sessionLandscape(dir())));

  server.registerTool("plan_check",
    { description: "Deterministic plan-quality scan (#2891): cross-plan contract drift "
        + "(Produces/Consumes without a shared fixture) and unanchored quantitative thresholds",
      // CRN-40: widened from .int().positive() -- a decimal phase filter (1.5)
      // must match its real 01.5-slug dir instead of dying as a raw SDK -32602.
      inputSchema: { phase: z.number().optional() } },
    wrap((a: { phase?: number }) => {
      assertValidPhase(a.phase);
      return planCheck(dir(), a.phase);
    }));

  server.registerTool("audit_record",
    { description: "Write the audit record file (.cairn/audit/<scope>-<date>.md) — single writer; "
        + "same scope+date supersedes, prior dates immutable",
      inputSchema: { scope: z.string(), verdict: z.enum(["pass", "findings"]),
        findings: z.array(z.object({
          severity: z.enum(["critical", "important", "minor"]),
          title: z.string().min(1),
          detail: z.string().optional(), issue: z.string().optional(),
        })).default([]) } },
    wrap((a: { scope: string; verdict: "pass" | "findings"; findings: AuditFinding[] }) =>
      writeAuditRecord(dir(), a.scope, a.verdict, a.findings)));

  server.registerTool("map_set",
    { description: "Merge-patch the project knowledge graph (.cairn/map/map.json) -- nodes merge by id "
        + "(null deletes). Edge ops: edgesAdd/edgesRemove patch by exact from+to+type triple (removes "
        + "before adds; adds dedupe silently; removing a missing edge is a no-op); edges replaces the "
        + "list wholesale (rebuilds only) and can't be combined with the edge ops (CONFIG_INVALID). "
        + "Validates edge endpoints exist and rejects deleting a node still edged in the final list. "
        + "Every write stamps meta (updatedAt, generation++); rebuild: true marks a from-scratch "
        + "rebuild (resets builtAt, generation restarts at 1)",
      inputSchema: { patch: z.object({
        nodes: z.record(z.union([NodeSchema, z.null()])).optional(),
        edges: z.array(EdgeSchema).optional(),
        edgesAdd: z.array(EdgeSchema).optional(),
        edgesRemove: z.array(EdgeSchema).optional(),
      }), rebuild: z.boolean().optional() } },
    wrap((a: { patch: { nodes?: Record<string, MapNode | null>; edges?: MapEdge[];
      edgesAdd?: MapEdge[]; edgesRemove?: MapEdge[] }; rebuild?: boolean }) =>
      mapSet(dir(), a.patch, { rebuild: a.rebuild })));

  server.registerTool("map_get",
    { description: "Read the project knowledge graph, optionally filtered by nodeType, edgeType, or a "
        + "node id (self + touching edges + neighbor nodes). Missing store reads as empty",
      inputSchema: {
        nodeType: NodeTypeEnum.optional(),
        edgeType: EdgeTypeEnum.optional(),
        node: z.string().optional(),
      } },
    wrap((a: { nodeType?: NodeType; edgeType?: EdgeType; node?: string }) =>
      mapGet(dir(), a)));

  server.registerTool("map_query",
    { description: "Composite graph query: node + depth (0-3, default 1) walks a BFS neighborhood over "
        + "edges in both directions; nodeType/edgeType/label (case-insensitive substring) filters AND "
        + "together. Returns { nodes, edges, meta } with edges limited to both endpoints in the result",
      inputSchema: {
        node: z.string().optional(),
        depth: z.number().int().min(0).max(3).optional(),
        nodeType: NodeTypeEnum.optional(),
        edgeType: EdgeTypeEnum.optional(),
        label: z.string().optional(),
      } },
    wrap((a: MapQuery) => mapQuery(dir(), a)));

  // ---- workspace tools (basecamp) -- these operate on the LAUNCH dir, never
  // the focus-resolved dir: they are the layer that manages focus itself.

  server.registerTool("workspace_list",
    { description: "Workspace name, root, members (name/path/configured), and current focus. "
        + "No workspace resolves to { workspace: null } — never an error",
      inputSchema: {} },
    wrap(() => findWorkspace(launchDir) ?? { workspace: null }));

  server.registerTool("workspace_focus",
    { description: "Set (or clear, with project: null) the workspace focus — every tool then "
        + "operates on the focused member's project dir. Validates the member exists and is configured",
      inputSchema: { project: z.string().nullable() } },
    wrap((a: { project: string | null }) => setFocus(launchDir, a.project)));

  server.registerTool("workspace_status",
    { description: "Curated cross-project read: per configured member { name, phase, openIssues, "
        + "openSessions } from that member's own stores/tracker. Read-only, never switches focus; "
        + "a member whose tracker errors reports { name, error } instead of failing the call",
      inputSchema: {} },
    wrap(async () => {
      const info = findWorkspace(launchDir);
      if (!info) return { workspace: null, members: [] };
      const members: Array<Record<string, unknown>> = [];
      for (const m of info.members.filter((member) => member.configured)) {
        try {
          // per-member paths/trackers constructed directly -- no focus switch
          let t = trackers.get(m.absPath);
          if (!t) {
            t = new CachedTracker(await makeTracker(loadConfig(m.absPath), m.absPath));
            trackers.set(m.absPath, t);
          }
          const openIssues = (await t.listIssues({ state: "open" })).length;
          const phase = new ActiveContext(m.absPath).get().phase ?? null;
          const { openByKind } = sessionLandscape(m.absPath);
          const openSessions = Object.values(openByKind).reduce((sum, n) => sum + n, 0);
          members.push({ name: m.name, phase, openIssues, openSessions });
        } catch (e) {
          members.push({ name: m.name, error: e instanceof CairnError ? e.message : String(e) });
        }
      }
      return { workspace: info.workspace, focus: info.focus, members };
    }));

  const WorkstreamPatchSchema = z.object({
    title: z.string().optional(),
    project: z.string().optional(),
    status: z.enum(["queued", "active", "blocked", "done"]).optional(),
    issue: z.string().optional(),
    session: z.string().optional(),
    note: z.string().optional(),
  });

  server.registerTool("board_get",
    { description: "Read the workspace dispatch board (.cairn/basecamp/board.json) — workstreams "
        + "sorted by id plus counts by status. Missing board reads as empty",
      inputSchema: {} },
    wrap(() => boardGet(launchDir)));

  server.registerTool("board_update",
    { description: "Merge-patch the dispatch board: workstreams merge by id (null deletes); "
        + "title+project required on create; project must name a workspace member. Rejected "
        + "patches leave the board untouched",
      inputSchema: { patch: z.record(z.union([WorkstreamPatchSchema, z.null()])) } },
    wrap((a: { patch: Record<string, Partial<Workstream> | null> }) =>
      boardUpdate(launchDir, a.patch)));

  server.registerTool("peer_list",
    { description: "Detected external AI peer CLIs (codex/opencode/antigravity/grok) — on PATH, enabled, input cap",
      inputSchema: {} },
    wrap(() => peerList(dir())));

  server.registerTool("peer_run",
    { description: "Run one external peer CLI with capped stdin input — advisory output, non-zero exit is a result. "
        + "Outbound content leaves the machine; callers MUST leak-scan the input first — this layer does not scan",
      inputSchema: { provider: z.enum(PROVIDERS),
                     input: z.string().min(1),
                     timeoutMs: z.number().int().positive().optional() } },
    wrap(async (a: { provider: Provider; input: string; timeoutMs?: number }) => {
      const d = dir();
      return peerRun(d, a.provider, a.input, a.timeoutMs);
    }));

  server.registerTool("peer_state",
    { description: "Per-run peers convergence state (.cairn/peers/<slug>/) — ops: start (mode/target/"
        + "focus/peers; refuses an unfinished run on the slug), record_output (peer/round raw reply, "
        + "verbatim file), record_findings (peer/round, stable ids f1, f2, ...), verdict (findingId + "
        + "verified|dead|disputed|open-disagreement; verified/dead terminal), status (what's recorded + "
        + "what's missing to resume), close (blocks on unresolved findings; returns audit_record-shaped "
        + "provenance), abandon",
      // Permissive envelope on purpose -- op-specific requirements are
      // checked in-handler so a missing field comes back as a structured
      // CONFIG_INVALID naming the op, not a raw SDK -32602.
      inputSchema: {
        slug: z.string().min(1),
        op: z.enum(["start", "record_output", "record_findings", "verdict", "status", "close", "abandon"]),
        mode: z.enum(["review", "plan"]).optional(),
        target: z.string().optional(),
        focus: z.string().optional(),
        peers: z.array(z.string()).optional(),
        peer: z.string().optional(),
        round: z.number().int().optional(),
        output: z.string().optional(),
        findings: z.array(z.record(z.unknown())).optional(),
        findingId: z.string().optional(),
        verdict: z.enum(VERDICTS).optional(),
        note: z.string().optional(),
      } },
    wrap((a: { slug: string;
      op: "start" | "record_output" | "record_findings" | "verdict" | "status" | "close" | "abandon";
      mode?: "review" | "plan"; target?: string; focus?: string; peers?: string[];
      peer?: string; round?: number; output?: string; findings?: Array<Record<string, unknown>>;
      findingId?: string; verdict?: Verdict; note?: string }) => {
      const d = dir();
      const need = <T>(value: T | undefined, name: string): T => {
        if (value === undefined) {
          throw new CairnError("CONFIG_INVALID",
            `op '${a.op}' requires '${name}'`,
            `pass ${name} alongside slug + op`);
        }
        return value;
      };
      switch (a.op) {
        case "start":
          return runStart(d, a.slug, { mode: need(a.mode, "mode"),
            target: need(a.target, "target"), focus: a.focus, peers: need(a.peers, "peers") });
        case "record_output":
          return recordPeerOutput(d, a.slug, need(a.peer, "peer"),
            need(a.round, "round"), need(a.output, "output"));
        case "record_findings":
          // recordFindings re-validates each element against FindingSchema,
          // so the loose Record shape here can't smuggle in a bad finding.
          return recordFindings(d, a.slug, need(a.peer, "peer"),
            need(a.round, "round"), need(a.findings, "findings") as unknown as Finding[]);
        case "verdict":
          return recordVerdict(d, a.slug, need(a.findingId, "findingId"),
            need(a.verdict, "verdict"), a.note);
        case "status":
          return runStatus(d, a.slug);
        case "close":
          return runClose(d, a.slug);
        case "abandon":
          return runAbandon(d, a.slug);
      }
    }));

  server.registerTool("research_sections",
    { description: "Parse a research artifact's ##+ section markers "
        + "(<!-- namespace: done|pending|failed [date] [model] [— note] -->) for one "
        + "namespace (scout, survey, ...). Unmarked sections report state 'unmarked'; a "
        + "typo'd marker is CONFIG_INVALID, never silently done. With flip, rewrites that "
        + "section's marker atomically and returns the re-parsed sections",
      inputSchema: { path: z.string(), namespace: z.string(),
        flip: z.object({
          heading: z.string(),
          state: z.enum(["done", "pending", "failed"]),
          date: z.string().optional(),
          model: z.string().optional(),
          note: z.string().optional(),
        }).optional() } },
    wrap((a: { path: string; namespace: string;
      flip?: { heading: string; state: SectionState; date?: string; model?: string; note?: string } }) => {
      const d = dir();
      // Containment: the artifact must live under the project dir -- a
      // ..-escape (or an absolute path outside it) is a config error, not a read.
      const abs = resolve(d, a.path);
      const rel = relative(d, abs);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new CairnError("CONFIG_INVALID",
          `path '${a.path}' escapes the project directory`,
          "pass a path relative to the project root, e.g. .cairn/plans/phases/07-x/RESEARCH.md");
      }
      let markdown: string;
      try {
        markdown = readFileSync(abs, "utf8");
      } catch {
        throw new CairnError("NOT_FOUND", `no research artifact at ${abs}`,
          "path resolves against the project directory");
      }
      if (!a.flip) return { path: rel, sections: parseSections(markdown, a.namespace) };
      const { heading, state, ...meta } = a.flip;
      const flipped = flipSection(markdown, a.namespace, heading, state, meta);
      // tmp+rename so a crash mid-write never leaves a half-written artifact
      // (same idiom as map/store.ts).
      const tmp = `${abs}.tmp`;
      writeFileSync(tmp, flipped);
      renameSync(tmp, abs);
      return { path: rel, flipped: heading, sections: parseSections(flipped, a.namespace) };
    }));

  server.registerTool("docs_publish",
    { description: "Publish project documentation to the configured docs connector — "
        + "README.md becomes the landing page, docs/ (+ CHANGELOG.md) becomes the child "
        + "page tree, and the landing page gains a Documentation contents section. Idempotent",
      inputSchema: { projectName: z.string().optional() } },
    wrap(async (a: { projectName?: string }) => {
      const d = dir();
      return publishTree(await getDocsConnector(d), d, a.projectName);
    }));

  server.registerTool("docs_status",
    { description: "Docs connector status — configured connector and the project's landing page, when one exists. "
        + "A configured-but-unreachable connector reports {configured:true, reachable:false, error, message} "
        + "instead of throwing",
      inputSchema: { projectName: z.string().optional() } },
    wrap(async (a: { projectName?: string }) => {
      const d = dir();
      const cfg = loadConfig(d);
      if (!cfg.docs) return { configured: false };
      try {
        const connector = await getDocsConnector(d);
        const root = await connector.findPage(a.projectName ?? defaultProjectName(d));
        return { configured: true, connector: cfg.docs.connector, root };
      } catch (e) {
        // The connector is configured but couldn't be reached (auth, network,
        // rate limit, ...) -- report that gracefully rather than rethrowing;
        // an unreachable docs backend shouldn't look like a crashed tool.
        if (e instanceof CairnError) {
          const message = e.message.length > 200 ? `${e.message.slice(0, 200)}…` : e.message;
          return { configured: true, reachable: false, error: e.code, message };
        }
        throw e;
      }
    }));

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
  // Resolve to an absolute path up front -- the workspace resolver's
  // no-workspace compat branch returns the launch dir verbatim, so a relative
  // CLAUDE_PROJECT_DIR would otherwise leak relative paths into every store.
  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const server = buildServer({ projectDir });
  await server.connect(new StdioServerTransport());
}
