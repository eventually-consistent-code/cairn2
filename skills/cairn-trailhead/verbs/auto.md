---
verb: auto
args: "[--batch [--budget <tokens|$usd>] [--phases <N,N,...>]]"
status: live
---

Chained hands-off execution of remaining phases. OPT-IN and explicit: show
exactly what will run before anything runs.

1. `plan_status()` — the run list is every phase with CONTEXT.md and
   without VERIFICATION.md, in order. Show it (phases, issue counts) with
   ONE confirmation question. No CONTEXT.md → that phase is excluded and
   listed as skipped — auto never invents context.
2. Per phase, in order: plan if PLAN.md has no tasks (the `plan` verb's
   steps, standard depth) → the `work` verb's steps → the `verify` verb's
   steps. The A0 handoff tools track progress automatically; a killed run
   resumes via `/cairn:waypoint resume`.
3. HARD STOPS — halt the run, report, hand back: failed verify;
   `plan_drift` flags; any tracker error; any security-relevant decision
   (auth, secrets, data exposure, dependency trust).
   On a failed-verify stop, the report includes the ready-made trace
   handoff: the exact `trace_start` description + first-evidence text.
   auto never starts the trace itself — no self-repair; that is the
   user's move next session.
   Engineer mode (`user.mode: engineer`) adds one more: a completed
   cairn-authored issue whose PR awaits human review is a natural stop —
   auto never merges its own work past a human gate. The run report
   lists the waiting PRs.
4. Unattended decisions resolve against these principles, in order: prefer
   completeness over shortcuts; match existing patterns; choose reversible
   options; mirror the user's past choices; defer ambiguity (pick the
   defer-able reading, note it); escalate security (that's a hard stop,
   not a principle call). Every such decision is logged in the run report
   with the principle that resolved it.
5. Genuinely subjective taste calls (naming, UX copy, structure with no
   pattern to match) do NOT stop the run: take the reversible option, add
   it to the taste batch, present the batch as ONE review at the end.
6. End of run (or stop): report — phases completed, decisions + principles,
   taste batch, stop reason if stopped, next step.

## Batch mode — `auto --batch [--budget <tokens|$usd>] [--phases <N,N,...>]`

Bare `auto` (everything above) is UNCHANGED. `--batch` is the budgeted,
interviewed, walk-away form: stage everything up front — phase selection,
estimates, research questions, push authority — write it into a run
manifest, then hand off to headless execution. The manifest is the
executor's SOLE source of authority: a phase outside it never runs, and
never pushes.

Staging sequence, in order:

1. **Candidate set.** `--phases N,N,...` given → exactly those phases
   (each still needs CONTEXT.md, same exclusion rule as step 1 above).
   Otherwise `--budget` picks them: call `token_estimate` per remaining
   phase and fit phases into the budget on the HIGH end of each range —
   conservative on purpose, and the interview says so ("fit on worst-case
   estimates; a run that comes in under budget beats one that stops
   mid-phase"). `--budget` accepts raw tokens (`--budget 5000000`) or
   dollars (`--budget $300`). Neither flag → all remaining phases, budget
   uncapped (state that plainly too).
2. **Selection honesty.** Order/group the candidates: map present and
   fresh (`map_query` on phase dependencies) → dependency-smart grouping;
   no map, or stale → roadmap order. Either way the interview SAYS which
   one it used, in one plain line — e.g. "ordered by the project map's
   dependency edges" or "no fresh map — running in roadmap order". Never
   imply dependency intelligence that wasn't there.
3. **Research + question round.** Unplanned candidate phases get the
   `scout` verb's batch form (cross-phase pool, one dispatch). Its
   clarification questions surface HERE, at staging, while the user is
   still present — never mid-run. Answers are folded into RESEARCH.md as
   usual AND recorded in the manifest's `answers`, so the executor never
   has to ask.
4. **The staging gate — ONE AskUserQuestion.** Present, in one ask:
   - the phase list (numbers, names, issue counts, order/grouping);
   - per-phase estimate RANGES (never point claims) + the run total
     (low–high) vs the ceiling, with the fit-on-high caveat;
   - explicit push pre-authorization: "authorize pushes for THESE phases,
     for this run?" — scope-limited to the manifest's phases, recorded
     with a timestamp. This is REC-5's ship confirmation moved to run
     start, never silently bypassed:

     > Provenance: adopted from the 2026-08-12 product council (REC-5),
     > accepted by the project owner over cairn's no-action
     > recommendation. Vibe mode's silent-judgment rule explicitly does
     > NOT apply to this ask.

   Options: approve + authorize pushes / approve WITHOUT push authority /
   adjust / cancel. Declining push authority does NOT cancel the run — it
   downgrades it to verify-stop: phases run headless through work and
   verify, but nothing pushes; the report lists what's ready to ship by
   hand. "Adjust" loops back to step 1 with the user's changes.
5. **Write the run's authority.** On approval: `run_manifest(action:
   "create")` with the phases, estimates, ceiling, and staged answers;
   `run_manifest(action: "grant_push")` only if the user authorized
   pushes; then `budget_check` with the ceiling to open the spend ledger
   (hard at boundaries — no new phase/wave starts past the ceiling, an
   in-flight wave finishes; bounded overshoot ≤ one wave). Then
   `run_manifest(action: "set_status", status: "running")` and report
   "staged — run starts now."
6. **Execution — next wave (#133).** The executor consumes the manifest
   from here: phase loop, wave dispatch, boundary budget checks,
   tracker-first progress comments, and the end-of-run report (including
   estimate-vs-actual) are its job, not this doc's.
