---
name: cairn-trailhead
description: Use when routing /cairn <verb> invocations — owns the verb registry and shared execution rules for every cairn subroutine.
---

# cairn trailhead (verb registry + shared rules)

One entrypoint, every verb. `/cairn <verb> [args]` routes here; each live verb
has a subroutine file executed with the remaining arguments. This table is the
canonical registry — `help` renders from it and CI enforces it.

## Routing table

| verb | purpose | args | subroutine | status |
|---|---|---|---|---|
| `new` | Start a project — interview, plan artifacts, tracker mirror, issues | `[project name]` | verbs/new.md | live |
| `plan` | Plan a phase — research per depth, write PLAN.md, reconcile tracker | `<N> [--quick\|--deep] [--model <auto\|haiku\|sonnet\|opus>] [--tdd] [--mvp] [--prd <file>] [--ingest <glob>] [--gaps]` | verbs/plan.md | live |
| `work` | Execute a phase — claim issues, do the work, close on verified done | `<N> [--wave [N]]` | verbs/work.md | live |
| `verify` | Goal-backward phase check, drift clean, write VERIFICATION.md | `<N>` | verbs/verify.md | live |
| `ship` | Gate on drift-clean + no open issues in verified phases, then push | | verbs/ship.md | live |
| `status` | One view — phases, issue states, drift, unplanned work | | verbs/status.md | live |
| `import` | Reverse-mirror a tracker epic/milestone/list into plan artifacts | `<phase url, id, or name>` | verbs/import.md | live |
| `remember` | Store a durable fact as a memory card (or bulk into the index) | `"<fact>" [--type decision\|constraint\|gotcha\|reference]` | verbs/remember.md | live |
| `recall` | Search memory, scoped to the active context, with staleness flags | `"<query>" [--phase N] [--issue <id>]` | verbs/recall.md | live |
| `help` | Render this verb reference | `[verb]` | verbs/help.md | live |
| `do` | Freeform smart router — classify intent, dispatch the right verb | `"<request>"` | verbs/do.md | live |
| `waypoint` | Pause/resume session continuity | `[resume]` | verbs/waypoint.md | live |
| `scout` | Research a phase only — resumable RESEARCH.md checkpoints | `<N>` | verbs/scout.md | live |
| `route` | Re-route the roadmap — insert/remove/edit phases | `insert\|remove\|edit <N> ["name"]` | verbs/route.md | live |
| `probe` | Risk-ordered throwaway spike experiments with verdicts | | verbs/probe.md | reserved-C |
| `draft` | Multi-variant mockups on a shared theme | | verbs/draft.md | reserved-C |
| `summit` | Complete the milestone — verify gate, tracker close/release, archive, tag | | verbs/summit.md | live |
| `auto` | Chained hands-off execution of remaining phases (opt-in) | | verbs/auto.md | live |
| `fast` | Trivial inline change — no artifacts, atomic commit | | verbs/fast.md | reserved-A |
| `resync` | Detect out-of-band code changes; refresh plan context | | verbs/resync.md | reserved-A |
| `mark` | Zero-friction capture — notes, seeds, backlog | | verbs/mark.md | reserved-B |
| `retro` | Retrospective that writes provenance-backed memory cards | | verbs/retro.md | reserved-B |
| `distill` | Ship-time knowledge synthesis into docs/ | | verbs/distill.md | reserved-B |
| `brief` | Onboarding briefing from cards + plans | | verbs/brief.md | reserved-B |
| `tune` | Configure cairn.json — models, workflow toggles, surface | | verbs/tune.md | reserved-B |
| `trace` | Persistent debugging sessions that survive /clear | | verbs/trace.md | reserved-C |
| `triage` | Open issue/PR triage against project templates | | verbs/triage.md | reserved-D |
| `basecamp` | Multi-project workspaces and parallel workstreams | | verbs/basecamp.md | reserved-F |

Reserved verbs have no subroutine file yet — each lands with its tier. Invoking
one: say which tier ships it and show `/cairn help`.

## Shared rules (inherited by every subroutine)

- **Errors surface, never stack-trace.** Server tools fail with typed codes
  (`AUTH_MISSING`, `RATE_LIMITED`, `NOT_FOUND`, `TRACKER_DOWN`, …) — report the
  code and the user's next action. One backend being down never blocks
  git-side operations.
- **Precedence.** On conflict, git plan docs (CONTEXT.md, PLAN.md) win over
  tracker issue text — update the issue via `issue_update`, never silently
  follow it.
- **Batch questions.** Related questions go in one AskUserQuestion — never
  one-checkbox-at-a-time friction.
- **Active context.** Verbs operate on the active project/phase/issue
  (`context_get`) unless arguments override; verbs that change focus call
  `context_set`.
- **Policy lives in the policy skills.** Depth dial, model routing, and
  artifact judgment: `cairn-planning`. What deserves a card, distill timing,
  capacity guard: `cairn-memory`. Subroutines sequence tool calls; they do
  not restate policy.
- **Continuity.** State-changing verbs refresh the handoff via their tools
  automatically; `ship`/`summit` clear it.
