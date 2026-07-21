#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CairnError } from "./errors.js";
import { loadConfig, writeConfigPatch } from "./config.js";
import { ActiveContext } from "./active-context.js";
import { makeTracker } from "./tracker/registry.js";
import { CachedTracker } from "./tracker/cached.js";
import type { Tracker, IssueState } from "./tracker/types.js";
import { scaffoldProject, scaffoldPhase, writePlanIssues, readPlanMeta, writePlanMeta } from "./planning/artifacts.js";
import { projectStatus } from "./planning/status.js";
import { driftReport, ensurePhase } from "./planning/mirror.js";
import { unplannedReport } from "./planning/collab.js";
import { importPhase } from "./planning/import.js";
import { milestoneCreate, milestoneList, milestoneComplete } from "./planning/milestones.js";
import { resyncReport } from "./planning/resync.js";
import { MemoryIndex, indexDbPath, type SearchResult } from "./memory/index-store.js";
import { createCard, listCards, readCard, updateCardConfidence } from "./memory/cards.js";
import { checkCardStaleness } from "./memory/staleness.js";
import { readHandoff, writeHandoff, clearHandoff } from "./core/continuity.js";
import type { Handoff } from "./core/continuity.js";
import { appendLedger } from "./planning/ledger.js";
import { writeBanner, bannerStats } from "./memory/banner.js";
import { startTrace, appendTrace, listTraces, closeTrace } from "./trace/store.js";

const StateEnum = z.enum(["open", "in_progress", "closed"]);
const HandoffSourceEnum = z.enum(["tool", "posttooluse", "precompact", "waypoint"]);
const HandoffPhaseRefSchema = z.object({ number: z.number().int(), slug: z.string() });

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

  // Best-effort handoff refresh for the write-through points below. Continuity
  // is a hint, never authority (trust order: tracker + git > ledger > handoff)
  // -- so a refresh failure (unwritable ~/.cairn/handoff, corrupt file, etc.)
  // must never fail the primary tool call that triggered it.
  const refreshHandoff = (patch: Partial<Handoff> & { source: Handoff["source"] }): void => {
    try {
      writeHandoff(deps.projectDir, patch);
    } catch {
      // swallowed by design -- see comment above.
    }
  };

  // Resolves a phase number to the {number, slug} shape the handoff wants, by
  // matching against locally scaffolded phase dirs (NN-slug). Returns
  // undefined when the phase hasn't been scaffolded locally -- best-effort,
  // same spirit as the rest of write-through refresh.
  const phaseHandoffRef = (number: number): { number: number; slug: string } | undefined => {
    const match = projectStatus(deps.projectDir).phases.find((p) => p.number === number);
    return match ? { number, slug: match.dir.slice(3) } : undefined;
  };

  server.registerTool("context_get",
    { description: "Get the active cairn context (phase, issue)", inputSchema: {} },
    wrap(() => ctx.get()));

  server.registerTool("context_set",
    { description: "Set/clear active cairn context fields (null clears)",
      inputSchema: { phase: z.number().nullable().optional(),
                     issueId: z.string().nullable().optional() } },
    wrap((a: { phase?: number | null; issueId?: string | null }) => {
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
        const ref = phaseHandoffRef(state.phase);
        if (ref) patch.phase = ref;
      }
      if (a.issueId === null) {
        patch.issue = undefined;
      } else if (a.issueId !== undefined) {
        patch.issue = state.issueId;
      }
      refreshHandoff(patch);
      writeBanner(deps.projectDir);
      return state;
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
      const result = await (await getTracker()).updateIssue(id, patch);
      refreshHandoff({ source: "tool", issue: id });
      return result;
    }));

  server.registerTool("issue_close",
    { description: "Close an issue", inputSchema: { id: z.string() } },
    wrap(async (a: { id: string }) => {
      const result = await (await getTracker()).closeIssue(a.id);
      refreshHandoff({ source: "tool", issue: a.id });
      return result;
    }));

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
      refreshHandoff({
        source: "tool",
        phase: { number: Number(a.phaseDir.slice(0, 2)), slug: a.phaseDir.slice(3) },
        plan: join(".cairn", "plans", "phases", a.phaseDir, "PLAN.md"),
      });
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
    { description: "Memory index size — chunk count and approximate token usage (capacity guard signal), "
        + "plus recall-banner token accounting",
      inputSchema: {} },
    wrap(() => ({ ...getMemIndex().stats(), ...bannerStats(deps.projectDir) })));

  server.registerTool("mem_card_create",
    { description: "Write a durable memory card (decision/constraint/gotcha/reference/note) with provenance",
      inputSchema: {
        type: z.enum(["decision", "constraint", "gotcha", "reference", "note"]),
        body: z.string(),
        scopePhase: z.number().int().optional(),
        scopeIssue: z.string().optional(),
        confidence: z.enum(["high", "medium", "low"]).optional(),
        provenance: z.array(z.object({ file: z.string(), commit: z.string() })).optional(),
      } },
    wrap((a: { type: "decision" | "constraint" | "gotcha" | "reference" | "note"; body: string;
               scopePhase?: number; scopeIssue?: string; confidence?: "high" | "medium" | "low";
               provenance?: Array<{ file: string; commit: string }> }) => {
      const card = createCard(deps.projectDir, a);
      const patch: Partial<Handoff> & { source: Handoff["source"] } = { source: "tool" };
      if (a.scopePhase !== undefined) {
        const ref = phaseHandoffRef(a.scopePhase);
        if (ref) patch.phase = ref;
      }
      if (a.scopeIssue !== undefined) patch.issue = a.scopeIssue;
      refreshHandoff(patch);
      writeBanner(deps.projectDir);
      return card;
    }));

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

  server.registerTool("mem_card_update",
    { description: "Adjust a memory card's confidence (frontmatter-only; body and id are immutable)",
      inputSchema: { id: z.string(),
                     confidence: z.enum(["high", "medium", "low"]) } },
    wrap((a: { id: string; confidence: "high" | "medium" | "low" }) => {
      const card = updateCardConfidence(deps.projectDir, a.id, a.confidence);
      writeBanner(deps.projectDir);
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
      const before = a.before ?? 3;
      const after = a.after ?? 3;

      let anchorCreatedAt: string;
      let anchorCardId: string | undefined;
      try {
        const card = readCard(deps.projectDir, a.anchor);
        anchorCreatedAt = card.frontmatter.created;
        anchorCardId = card.id;
      } catch {
        const chunkCreatedAt = getMemIndex().sourceCreatedAt(a.anchor);
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

      const cardItems: TimelineCardItem[] = listCards(deps.projectDir)
        .filter((c) => c.id !== anchorCardId)
        .map((c) => ({
          id: c.id, type: c.frontmatter.type, title: timelineCardTitle(c.body),
          created: c.frontmatter.created, cost: timelineCardCost(c.body),
        }));
      const cardsBefore = cardItems.filter((c) => isBeforeAnchor(c.created, c.id));
      const cardsAfter = cardItems.filter((c) => isAfterAnchor(c.created, c.id));

      const chunkNeighbors: SearchResult[] = getMemIndex().timeline(anchorCreatedAt, before, after);
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
    wrap(async () => unplannedReport(await getTracker(), deps.projectDir)));

  server.registerTool("plan_import",
    { description: "Reverse-mirror a tracker phase (by id or name substring) into .cairn/plans/ artifacts",
      inputSchema: { phaseRef: z.string() } },
    wrap(async (a: { phaseRef: string }) => {
      const result = await importPhase(await getTracker(), deps.projectDir, a.phaseRef);
      refreshHandoff({
        source: "tool",
        phase: { number: result.number, slug: result.dir.slice(3) },
        plan: join(".cairn", "plans", "phases", result.dir, "PLAN.md"),
      });
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
      writeHandoff(deps.projectDir, { ...a, source: a.source ?? "tool" });
      return readHandoff(deps.projectDir);
    }));

  server.registerTool("continuity_get",
    { description: "Read the current session handoff, if any (flags handoffs older than 14 days as stale, never errors on staleness)",
      inputSchema: {} },
    wrap(() => readHandoff(deps.projectDir)));

  server.registerTool("continuity_clear",
    { description: "Delete the session handoff for this project, if any",
      inputSchema: {} },
    wrap(() => ({ cleared: clearHandoff(deps.projectDir) })));

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
      const { phaseDir, ...entry } = a;
      const result = appendLedger(deps.projectDir, phaseDir, entry);
      refreshHandoff({
        source: "tool",
        phase: { number: Number(phaseDir.slice(0, 2)), slug: phaseDir.slice(3) },
        issue: entry.issueId,
      });
      return result;
    }));

  server.registerTool("milestone_create",
    { description: "Start the next milestone — native tracker object when the backend supports it; stamps milestone_id into roadmap.md",
      inputSchema: { name: z.string() } },
    wrap(async (a: { name: string }) =>
      milestoneCreate(await getTracker(), deps.projectDir, a.name)));

  server.registerTool("milestone_list",
    { description: "Current milestone number, archived milestones, and the tracker's native list when supported",
      inputSchema: {} },
    wrap(async () => milestoneList(await getTracker(), deps.projectDir)));

  server.registerTool("milestone_complete",
    { description: "Complete the current milestone: gate on all-phases-verified, close tracker phases, "
        + "release the native milestone when supported, archive phases/ to milestones/vN/, bump roadmap. "
        + "Idempotent — safe to re-run after a partial tracker failure",
      inputSchema: { summary: z.string() } },
    wrap(async (a: { summary: string }) =>
      milestoneComplete(await getTracker(), deps.projectDir, a.summary)));

  server.registerTool("plan_resync",
    { description: "Detect out-of-band commits (covered by no LEDGER.md range) since the last resync marker; "
        + "advances the marker. First run initializes the marker and reports nothing",
      inputSchema: {} },
    wrap(() => resyncReport(deps.projectDir)));

  server.registerTool("plan_meta_set",
    { description: "Set wave grouping (wave_N frontmatter) and/or the TDD-eligible task list on a phase's PLAN.md",
      inputSchema: { phaseDir: z.string(),
                     waves: z.array(z.array(z.string())).optional(),
                     tdd: z.array(z.string()).optional() } },
    wrap((a: { phaseDir: string; waves?: string[][]; tdd?: string[] }) => {
      if (!PHASE_DIR_RE.test(a.phaseDir)) {
        throw new CairnError("CONFIG_INVALID",
          `phaseDir must look like 01-name, got '${a.phaseDir}'`);
      }
      writePlanMeta(deps.projectDir, a.phaseDir, { waves: a.waves, tdd: a.tdd });
      refreshHandoff({
        source: "tool",
        phase: { number: Number(a.phaseDir.slice(0, 2)), slug: a.phaseDir.slice(3) },
      });
      return { ok: true, ...readPlanMeta(deps.projectDir, a.phaseDir) };
    }));

  server.registerTool("config_get",
    { description: "Read cairn.json as the validated, post-defaults effective config",
      inputSchema: {} },
    wrap(() => loadConfig(deps.projectDir)));

  server.registerTool("config_set",
    { description: "Merge-patch cairn.json (null deletes a key). Validates the merged result before "
        + "writing; refuses secret-looking keys/values — credentials live in env vars",
      inputSchema: { patch: z.record(z.unknown()) } },
    wrap((a: { patch: Record<string, unknown> }) =>
      writeConfigPatch(deps.projectDir, a.patch)));

  server.registerTool("issue_comment",
    { description: "Post a plain-language comment on a tracker issue (management-visible progress note)",
      inputSchema: { id: z.string(), text: z.string() } },
    wrap(async (a: { id: string; text: string }) =>
      (await getTracker()).commentIssue(a.id, a.text)));

  server.registerTool("trace_start",
    { description: "Open a persistent debugging session (.cairn/trace/<id>.md). Creates the tracker "
        + "bug issue (label cairn:bug) when no issueId is given. Survives /clear by construction",
      inputSchema: { description: z.string(), issueId: z.string().optional() } },
    wrap(async (a: { description: string; issueId?: string }) => {
      let issueId = a.issueId;
      if (!issueId) {
        const issue = await (await getTracker()).createIssue({
          title: a.description, labels: ["cairn:bug"] });
        issueId = issue.id;
      }
      const { id } = startTrace(deps.projectDir, a.description, issueId);
      refreshHandoff({ source: "tool", issue: issueId });
      return { id, issue: issueId };
    }));

  server.registerTool("trace_log",
    { description: "Append a typed entry (evidence|hypothesis|test|verdict) to an open trace — append-only",
      inputSchema: { id: z.string(),
                     kind: z.enum(["evidence", "hypothesis", "test", "verdict"]),
                     text: z.string() } },
    wrap((a: { id: string; kind: "evidence" | "hypothesis" | "test" | "verdict"; text: string }) => {
      const out = appendTrace(deps.projectDir, a.id, a.kind, a.text);
      refreshHandoff({ source: "tool" });
      return out;
    }));

  server.registerTool("trace_list",
    { description: "List trace sessions (open and/or resolved) with entry counts",
      inputSchema: { status: z.enum(["open", "resolved"]).optional() } },
    wrap((a: { status?: "open" | "resolved" }) => listTraces(deps.projectDir, a.status)));

  server.registerTool("trace_close",
    { description: "Resolve a trace: requires a verdict entry; archives the session, comments the "
        + "resolution on the bug issue and closes it",
      inputSchema: { id: z.string(), resolution: z.string() } },
    wrap(async (a: { id: string; resolution: string }) => {
      const out = closeTrace(deps.projectDir, a.id, a.resolution);
      let issueClosed = false;
      if (out.issue) {
        const tracker = await getTracker();
        try {
          await tracker.commentIssue(out.issue, `Resolved: ${a.resolution}`);
        } catch {
          // comment is best-effort mirror; close is the state change that matters
        }
        await tracker.closeIssue(out.issue);
        issueClosed = true;
      }
      return { ...out, issueClosed };
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
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const server = buildServer({ projectDir });
  await server.connect(new StdioServerTransport());
}
