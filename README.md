# cairn 2.0

**Converged work management for Claude Code** — one tool where deep planning,
durable memory, tracker truth, and session continuity meet in a single
deterministic engine.

> **Private until launch.** This repo is the cairn 2.0 rebuild; the shipped
> 1.x plugin lives in the public
> [claude-plugins](https://github.com/eventually-consistent-code/claude-plugins)
> marketplace repo. Full docs index: **[docs/README.md](docs/README.md)**.

## What it is

Cairn 2.0 is a Claude Code plugin backed by a real TypeScript MCP server.
External work trackers are the single source of truth for work items, git
owns all prose (plans, memory cards), and the server owns every mechanism
with a wrong answer — state transitions, mirroring, drift math, staleness
checks — while skills own judgment. No prompt-glue, no sync engine, no
sidecar processes.

```
plugin (thin)     commands + skills + hooks — policy and judgment
      │ typed MCP tools
cairn-server      tracker/ · planning/ · memory/ · core/   (one process)
      │
tracker API (work truth) · git repo (prose truth) · ~/.cairn/ (disposable cache)
```

## Features (shipped — P0–P4)

**Tracker layer** — six adapters behind one normalized interface: GitHub,
GitLab, Jira, Asana, Azure Boards, ClickUp. Capability matrix per backend
(declare, don't flatten), write-through with cached reads, shared HTTP core
with retry/backoff, and a single contract test suite every adapter must pass
— fixtures in CI, live sandboxes before release.

**Planning engine** — GSD-depth planning on native Claude Code muscles.
Git-owned artifacts (`PROJECT.md`, `roadmap.md`, per-phase
`CONTEXT.md`/`RESEARCH.md`/`PLAN.md`/`VERIFICATION.md`), tracker mirroring
(phase → milestone/epic/list, requirement → issue), a quick/standard/deep
depth dial, model routing for agent fan-out, and drift detection when plans
reference missing or unverified-closed issues.

**Memory module** — two tiers engineered against context rot. Tier 1: a
disposable SQLite FTS5 index outside the repo (bulk tool output, research
dumps — searchable, rebuildable, never in context wholesale). Tier 2:
git-committed memory cards, one fact each, with **provenance + staleness
checking** — recall diffs each card's source files against the recorded
commit and serves a `STALE` flag when the code moved. Memory can be wrong;
it can never silently lie.

**Collaboration** — the tracker's multi-user machinery, made lifecycle-aware:
unplanned-work surfacing (tracker issues no plan references), `import`
(reverse-mirror an existing epic/milestone/list into a cairn project),
assignee-aware claiming, and plans/cards that collaborate through ordinary
git PRs.

**Verbs (18 live):** `plan` `work` `verify` `ship` `status` `new` `import`
`remember` `recall` `help` `do` `waypoint` `scout` `route` `summit` `auto`
`fast` `resync` — behind a single `/cairn <verb>` entrypoint. Ten more
verbs are reserved (mapped in the routing skill, not yet built).

**Server:** 33 typed MCP tools, 328 passing tests (6 skipped — env-gated
live-backend suites), three dependencies (`@modelcontextprotocol/sdk`,
`better-sqlite3`, `zod`). Fail loud, never fake state.

## Roadmap

Full parity with GSD's ~60-command surface, restructured behind a single
`/cairn <verb>` entrypoint with a trail-themed vocabulary — plus the
highest-value ideas from GSD's community backlog and a five-competitor gap
analysis. See the
[parity roadmap](docs/superpowers/specs/2026-07-15-cairn-2-parity-roadmap-design.md)
and [gap analysis](docs/superpowers/research/2026-07-15-competitor-gap-analysis.md).

| Stage | Scope | Status |
|---|---|---|
| P0–P4 | Server core: tracker, planning, memory, collaboration | ✅ shipped |
| Tier 0 | Trailhead — single `/cairn` entrypoint + routing skill | 📐 specced |
| Tier A0 | Continuity — crash-proof auto-resume + recall index/timeline | 📐 specced |
| Tier A | Planning depth — `scout` `auto` `fast` `resync` `route` `summit`, TDD gates, stage-aware model routing | planned |
| Tier B | `mark` `waypoint` `retro` `distill` `brief` `tune`, leak guard | planned |
| Tier C | `trace` `probe` `draft`, audits & review governance | planned |
| Tier D | `triage` — tracker-loop triage | planned |
| Tier E | Knowledge graph, diagnostics | planned |
| Tier F | `basecamp` multi-project, cross-AI review, frontend quality loop | planned |
| P5′ | Dogfood gate → 1.x cutover → publish | planned |

## Development

```bash
cd server
npm ci
npm test          # unit + contract (no network)
npm run test:live # live contract vs a real backend (env-gated)
npm run build
```

Adapter live-status, tool reference, and artifact layout:
[server/README.md](server/README.md).

## Repository layout

```
server/     TypeScript MCP server (tracker adapters, planning, memory, core)
commands/   plugin command surface (migrating to single /cairn entrypoint — Tier 0)
skills/     cairn-planning, cairn-memory (policy; mechanism lives in the server)
templates/  cairn.json.example
docs/       specs, implementation plans, research — see docs/README.md
.mcp.json   launches cairn-server for the plugin
```

## Documentation

Everything is indexed at **[docs/README.md](docs/README.md)** — design specs
(umbrella design, parity roadmap, tier specs), per-phase implementation
plans, and competitive research.

## License

MIT — same posture as 1.x: local-first, env-var-name-only secrets, data goes
only to the tracker you configure.
