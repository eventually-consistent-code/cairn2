# cairn 2.0

**Converged work management for Claude Code** — one tool where deep planning,
durable memory, tracker truth, and session continuity meet in a single
deterministic engine.

> This repo is the cairn 2.0 rebuild; the earlier 1.x plugin lives in the
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

**Docs connectors** — publish repo documentation outward through the same
pluggable-adapter pattern: `/cairn:docs publish` mirrors README + `docs/`
into Confluence (per-project folder, landing page + child-page tree,
generated contents sections, space-wide title-conflict handling) or into a
local Docusaurus site checkout (markdown + `_category_.json`, native
sidebar, optional auto-commit — never push). Idempotent re-publish on both.
The SPI is product-neutral — Notion, GitBook, Slite, and SharePoint
connectors slot in behind the same contract suite.

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

**Verbs (37 live):** `plan` `work` `verify` `ship` `status` `new` `import`
`remember` `recall` `help` `do` `waypoint` `scout` `route` `summit` `auto`
`fast` `resync` `mark` `retro` `distill` `brief` `tune` `trace` `probe`
`draft` `audit` `review` `triage` `map` `thread` `profile` `medic`
`backtrack` `basecamp` `peers` `docs` — each a `/cairn:<verb>` command, generated
from the routing table.
The routing table is complete: the reserved verb set is now empty.

**Server:** 65 typed MCP tools, 555 passing tests (env-gated live-backend
suites skip without creds), three dependencies (`@modelcontextprotocol/sdk`,
`better-sqlite3`, `zod`). Fail loud, never fake state.

**Agents (2 live):** the plugin's first `agents/` dir — specialist roles
dispatched by existing verbs, zero new tools or verbs.

| Agent | Role | Dispatched by |
|---|---|---|
| `cairn-designer` | Turns a design question into a decided direction with artifacts — wireframes, design tokens (`themes/default.css` + `tokens.json`, always both), coded prototypes — inside a `draft` session, recording `implements`/`decided-in` map edges as it goes | `draft` (non-trivial design questions) |
| `cairn-uat` | Proves shipped flows meet requirements, platform-aware — walks each flow as a user on a named viewport matrix, sweeps requirement traceability via map edges, hands fidelity divergence off to `audit ui` | `audit uat` (acceptance walks), `audit ui` (fidelity checks) |

## Roadmap

Full parity with GSD's ~60-command surface, restructured behind a per-verb
`/cairn:<verb>` surface with a trail-themed vocabulary — plus the
highest-value ideas from GSD's community backlog and a five-competitor gap
analysis. See the
[parity roadmap](docs/superpowers/specs/2026-07-15-cairn-2-parity-roadmap-design.md)
and [gap analysis](docs/superpowers/research/2026-07-15-competitor-gap-analysis.md).

| Stage | Scope | Status |
|---|---|---|
| P0–P4 | Server core: tracker, planning, memory, collaboration | ✅ shipped |
| Tier 0 | Trailhead — `/cairn` entrypoint + routing skill | ✅ shipped |
| Tier A0 | Continuity — crash-proof auto-resume + recall index/timeline | ✅ shipped |
| Tier A | Planning depth — `scout` `auto` `fast` `resync` `route` `summit`, TDD gates, stage-aware model routing | ✅ shipped |
| Tier B | `mark` `waypoint` `retro` `distill` `brief` `tune`, leak guard | ✅ shipped |
| Tier C1 | `trace` — persistent debugging sessions | ✅ shipped |
| Tier C2 | `probe` `draft` — spike/sketch sessions, `session_landscape` | ✅ shipped |
| Tier C3 | Audits & review governance — `audit` `review`, `plan_check`, `audit_record` | ✅ shipped |
| Tier D | `triage` — tracker-loop triage | ✅ shipped |
| Tier E | `map` `thread` `profile` `medic` `backtrack`, `audit docs`, `status --stats` | ✅ shipped |
| Tier F1 | `basecamp` — workspace awareness, focus switch, dispatch board | ✅ shipped |
| Tier F2 | `peers` — cross-AI review/plan convergence, adversarial judgment, outbound leak gate | ✅ shipped |
| Tier F3 | Frontend quality loop — `cairn-designer` + `cairn-uat` agents, design-token discipline, requirements traceability | ✅ shipped |
| P5′ | Dogfood gate → 1.x cutover → publish | ✅ shipped (`2.0.0` — live dogfood + community-marketplace submission) |
| P5″ | Per-verb surface — plugin `cairn`, 36 generated `/cairn:<verb>` shims, conformance check (f) | ✅ shipped (`2.0.0`) |
| Fidelity | Tracker-mirror fidelity — inbound PM-delta ingest (`plan_tracker_delta`), outbound paper trail + Jira worklog | ✅ shipped |
| Eng. mode | `user.mode` vibe/engineer — work pairing, no-self-merge gate, decision surfacing | ✅ shipped |

**P5′ status:** the seven transition shims are gone, P5″ replaced the
single `/cairn2:cairn` router with per-verb commands — the plugin is named
`cairn` and each live verb is a generated `/cairn:<verb>` shim
(`scripts/gen-commands.mjs`, enforced by check-surface) — and the
tracker-mirror fidelity + engineer-mode features are in (semi-live drill
records in VERIFICATION.md). Two gates remain, both owner actions:
(1) the **live dogfood pass** — a real session with the plugin installed,
running the Tier 0 drill (`/cairn:new → plan → work → verify → ship`,
`/cairn:do`, a typo'd verb, one waypoint resume) plus the fidelity and
engineer-mode checklists in VERIFICATION.md; (2) **publish** — swapping
cairn 1.x (and its `/cairn:gsd` passthrough) for cairn 2.0 in the plugin
marketplace. `2.0.0` follows both.

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
commands/   per-verb /cairn:<verb> shims — generated by scripts/gen-commands.mjs
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
