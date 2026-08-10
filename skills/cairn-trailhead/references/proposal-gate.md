# Proposal gate — research → roadmap changes

The single specification for how research findings become roadmap changes.
`survey` Stage 2/3 follows this file; other verbs that turn research into
roadmap surgery (peers council, phase 9) will reference this same file —
extend here, not in a verb doc. NOTHING mutates before the gate, in any
mode.

## Typed proposals

Distill findings into concrete proposals. Each proposal is exactly one of:

- **new phase N.5** — insert a phase between neighbors
- **rescope phase N** — change an existing phase's scope
- **new issues in phase N** — add work items to an existing phase
- **no action** — finding recorded, nothing changes

Each proposal carries an id (`P1`, `P2`, … numbered per run) and points at
the research section that motivates it — no proposal without evidence.

## The gate

ONE batched AskUserQuestion covering every proposal — multiSelect per
proposal, cairn's recommendation first with trade-offs. This gate holds in
vibe mode too: roadmap surgery from research is always "a peer would have
wanted a say." Never split it into per-proposal questions, never apply
anything before the answer comes back.

## Apply mechanics (approved proposals only)

- **New phase:** `plan_scaffold_phase` with a DECIMAL number between
  neighbors (route's rule — never renumber) + `plan_phase_ensure` for the
  tracker object + a roadmap.md row between its neighbors.
- **Rescope:** CONTEXT.md edits recorded as locked decisions with source
  links back to the research artifact — what changed and why.
- **New issues:** `issue_create` + `plan_issues_set`, estimates per the
  plan verb's convention (points + minutes, always both).
- **No action:** nothing to apply — the disposition line is the record.

## Disposition recording

After apply, write a **Dispositions** footer into the run's block of the
research artifact — one line per proposal:

```
## Dispositions
- P1 — new phase 3.5 — approved 2026-08-10 — .cairn/plans/phases/3.5-auth-hardening/
- P2 — new issues in phase 4 — approved 2026-08-10 — CRN-121, CRN-122
- P3 — rescope phase 5 — rejected 2026-08-10 — scope already covered by phase 6's locked decisions
- P4 — no action — deferred 2026-08-10 — —
```

Shape of a line: id — typed shape — decision (approved/rejected/deferred +
date) — applied artifact (phase dir / issue ids / `—` when nothing was
created). Rejected entries carry a one-line why in the artifact slot.
Future runs read prior Dispositions and never re-raise a rejected proposal
without new evidence; deferred proposals are fair game to re-raise as-is.
