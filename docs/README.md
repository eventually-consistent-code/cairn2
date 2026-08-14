# cairn 2.0 — documentation index

← back to the [project README](../README.md)

## Start here

- **[Quickstart](00-quickstart.md)** — zero to a tracker-mirrored project in
  ~15 minutes: install, credentials, cairn.json, first phase.
- **[Runbook](01-runbook.md)** — the complete operating manual: every verb,
  every flag, every backend, every error code.
- **[How cairn compares](comparison.md)** — mechanism-by-mechanism against
  the nearest alternatives, every competitor claim carrying a
  last-verified date.
- **[Council case study](case-study-council.md)** — the 2026-08-12
  four-vendor product council: 58 findings, source-verified claims, and
  the dispositions — including the one the tool argued against and lost.

Docs follow the spec → plan → build → review cycle: every phase/tier gets a
design spec, then an implementation plan, then ships. Specs are decision
records — status lines say whether a doc is approved or draft.

## Design specs (`superpowers/specs/`)

| Doc | What it decides |
|---|---|
| [2026-07-12 — cairn 2.0 design](superpowers/specs/2026-07-12-cairn-2-design.md) | The umbrella: plugin + MCP server architecture, tracker as source of truth, two-tier memory, six adapters, build sequencing P0–P5 |
| [2026-07-15 — parity roadmap & differentiation](superpowers/specs/2026-07-15-cairn-2-parity-roadmap-design.md) | Full GSD parity as the goal, single `/cairn` entrypoint, trail vocabulary, tier structure 0/A–F, 14 folded community ideas |
| [2026-07-15 — Tier 0: Trailhead](superpowers/specs/2026-07-15-cairn-2-tier-0-trailhead.md) | Single-entrypoint restructure: routing skill, per-verb subroutines, shims, dogfood plugin manifest, surface-conformance CI ratchet |
| [2026-07-15 — Tier A0: Continuity](superpowers/specs/2026-07-15-cairn-2-tier-a0-continuity.md) | Crash-proof auto-resume (HANDOFF + ledger + hooks), recall index with per-card fetch costs, `mem_timeline` |
| [2026-07-18 — Tier A: Planning depth](superpowers/specs/2026-07-18-cairn-2-tier-a-planning-depth.md) | `scout` `route` `summit` `auto` `fast` `resync`, milestone mechanics, TDD evidence gates, waves, stage-aware model routing |
| [2026-07-20 — Tier B: Lightweight subsystems](superpowers/specs/2026-07-20-cairn-2-tier-b-lightweight-subsystems.md) | `mark` `retro` `distill` `brief` `tune`, leak guard, card schema |
| [2026-07-21 — Tier C1: Trace](superpowers/specs/2026-07-21-cairn-2-tier-c1-trace.md) | Persistent debugging sessions — evidence → hypothesis → test, tracker-mirrored |
| [2026-07-22 — Tier C2: Probe & draft](superpowers/specs/2026-07-22-cairn-2-tier-c2-probe-draft.md) | Spike/sketch sessions, `session_landscape` |
| [2026-07-22 — Tier C3: Audits](superpowers/specs/2026-07-22-cairn-2-tier-c3-audits.md) | `audit` `review` governance, `plan_check`, `audit_record` |
| [2026-07-22 — Tier D: Triage](superpowers/specs/2026-07-22-cairn-2-tier-d-triage.md) | Open-issue sweep against project conventions, safe `--apply` subset |
| [2026-07-22 — Tier E: Knowledge & diagnostics](superpowers/specs/2026-07-22-cairn-2-tier-e-knowledge-diagnostics.md) | `map` `thread` `profile` `medic` `backtrack`, `audit docs`, `status --stats` |
| [2026-07-22 — Tier F1: Basecamp](superpowers/specs/2026-07-22-cairn-2-tier-f1-basecamp.md) | Multi-project workspaces, dispatch board, focus switch |
| [2026-07-22 — Tier F2: Cross-AI peers](superpowers/specs/2026-07-22-cairn-2-tier-f2-cross-ai.md) | External AI CLIs as reviewers — convergence with adversarial judgment, outbound leak gate |
| [2026-07-22 — Tier F3: Frontend loop](superpowers/specs/2026-07-22-cairn-2-tier-f3-frontend-loop.md) | `cairn-designer` + `cairn-uat` agents, design-token discipline, requirements traceability |
| [2026-07-22 — P5′ cutover](superpowers/specs/2026-07-22-cairn-2-p5-prime-cutover.md) | Shim removal, `/cairn` as the only command, dogfood + publish as human gates |
| [2026-07-23 — Tracker-mirror fidelity](superpowers/specs/2026-07-23-cairn-2-tracker-mirror-fidelity-design.md) | Inbound PM-delta ingest (`plan_tracker_delta` cursor, edits integrate forward) + outbound paper trail (comment lifecycle, Jira worklog, `timeSpentMinutes`) |
| [2026-07-23 — Engineer mode](superpowers/specs/2026-07-23-cairn-2-engineer-mode-design.md) | `user.mode` vibe/engineer posture: work pairing, review both ways (no self-merge), decision surfacing |

## Implementation plans (`superpowers/plans/`)

| Doc | Delivered |
|---|---|
| [P0–P1a](superpowers/plans/2026-07-12-cairn-2-p0-p1a.md) | Server skeleton, config, active-context, tracker contract + GitHub adapter |
| [P1b](superpowers/plans/2026-07-12-cairn-2-p1b.md) | Remaining five adapters against the contract |
| [P2](superpowers/plans/2026-07-13-cairn-2-p2.md) | Planning engine: artifacts, mirroring, depth dial, lifecycle verbs |
| [P3](superpowers/plans/2026-07-14-cairn-2-p3.md) | Memory: FTS5 index, provenance-checked cards, staleness, distill lifecycle |
| [P4](superpowers/plans/2026-07-15-cairn-2-p4.md) | Collaboration: unplanned-work surfacing, import, assignee awareness |
| [Tier 0](superpowers/plans/2026-07-15-cairn-2-tier-0.md) | Trailhead: single /cairn entrypoint, routing skill, shims, conformance ratchet |
| [Tier A0](superpowers/plans/2026-07-15-cairn-2-tier-a0.md) | Continuity: handoff engine, ledger, recall banner, mem_timeline, hooks, waypoint |
| [Tier A](superpowers/plans/2026-07-18-cairn-2-tier-a.md) | Planning depth: six verbs, milestone mech + git-state, TDD evidence, waves |
| [Tier B](superpowers/plans/2026-07-20-cairn-2-tier-b.md) | Lightweight subsystems: five verbs, leak guard, card schema |
| [Tier C1](superpowers/plans/2026-07-21-cairn-2-tier-c1.md) | Trace: session store, typed entries, tracker mirror |
| [Tier C2](superpowers/plans/2026-07-22-cairn-2-tier-c2.md) | Probe/draft sessions, `session_landscape` |
| [Tier C3](superpowers/plans/2026-07-22-cairn-2-tier-c3.md) | Audits & review governance |
| [Tier D](superpowers/plans/2026-07-22-cairn-2-tier-d.md) | Triage sweep + safe apply subset |
| [Tier E](superpowers/plans/2026-07-22-cairn-2-tier-e.md) | Knowledge graph, threads, profile, medic, backtrack |
| [Tier F1](superpowers/plans/2026-07-22-cairn-2-tier-f1.md) | Basecamp workspaces + dispatch board |
| [Tier F2](superpowers/plans/2026-07-22-cairn-2-tier-f2.md) | Peers: cross-AI review/plan convergence |
| [Tier F3](superpowers/plans/2026-07-22-cairn-2-tier-f3.md) | Frontend quality loop: designer + uat agents |
| [Fidelity](superpowers/plans/2026-07-23-cairn-2-tracker-mirror-fidelity.md) | Tracker-mirror fidelity: tracker-delta cursor module, write-through no-echo, worklog capability, verb-doc lifecycle |
| [Engineer mode](superpowers/plans/2026-07-23-cairn-2-engineer-mode.md) | `user.mode` key + pairing/no-self-merge/decision-surfacing verb-doc overlays |

## Research (`superpowers/research/`)

| Doc | What it covers |
|---|---|
| [2026-07-15 — competitor gap analysis](superpowers/research/2026-07-15-competitor-gap-analysis.md) | Five-competitor deep dive (Superpowers, gstack, Buildomator, claude-mem, headroom); 11 adopted gaps, prioritized integration plan, anti-pattern record |

## Reference

| Doc | What it covers |
|---|---|
| [server/README.md](../server/README.md) | Adapter live-status matrix, full MCP tool reference, artifact layout, drift semantics, test rings |
| [VERIFICATION.md](../VERIFICATION.md) | Drill records per tier, semi-live dogfood runs, pending human-gate checklists |
