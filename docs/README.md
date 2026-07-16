# cairn 2.0 — documentation index

← back to the [project README](../README.md)

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

## Implementation plans (`superpowers/plans/`)

| Doc | Delivered |
|---|---|
| [P0–P1a](superpowers/plans/2026-07-12-cairn-2-p0-p1a.md) | Server skeleton, config, active-context, tracker contract + GitHub adapter |
| [P1b](superpowers/plans/2026-07-12-cairn-2-p1b.md) | Remaining five adapters against the contract |
| [P2](superpowers/plans/2026-07-13-cairn-2-p2.md) | Planning engine: artifacts, mirroring, depth dial, lifecycle verbs |
| [P3](superpowers/plans/2026-07-14-cairn-2-p3.md) | Memory: FTS5 index, provenance-checked cards, staleness, distill lifecycle |
| [P4](superpowers/plans/2026-07-15-cairn-2-p4.md) | Collaboration: unplanned-work surfacing, import, assignee awareness |
| [Tier 0](superpowers/plans/2026-07-15-cairn-2-tier-0.md) | Trailhead: single /cairn entrypoint, routing skill, shims, conformance ratchet |
| [Tier A0](superpowers/plans/2026-07-15-cairn-2-tier-a0.md) | Continuity: handoff engine, ledger, recall banner, mem_timeline, hooks, waypoint (next up) |

## Research (`superpowers/research/`)

| Doc | What it covers |
|---|---|
| [2026-07-15 — competitor gap analysis](superpowers/research/2026-07-15-competitor-gap-analysis.md) | Five-competitor deep dive (Superpowers, gstack, Buildomator, claude-mem, headroom); 11 adopted gaps, prioritized integration plan, anti-pattern record |

## Reference

| Doc | What it covers |
|---|---|
| [server/README.md](../server/README.md) | Adapter live-status matrix, full MCP tool reference, artifact layout, drift semantics, test rings |
