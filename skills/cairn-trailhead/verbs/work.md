---
verb: work
args: "<N> [--wave [N]]"
status: live
---

Execute the given phase per the `cairn-planning` skill.

0. `plan_tracker_delta()` — peek. Anything in the delta → say so in one
   line ("tracker delta: 2 new, 1 edited — `/cairn:resync` to integrate")
   and continue; a non-empty delta never blocks this verb. First run:
   the tool initializes silently, don't mention it.
1. `plan_status()` → this phase's `issues` list. Empty → stop and point at
   `/cairn:plan <N>`.
2. `--wave` (only when PLAN.md has `wave_N` frontmatter — else say so and
   point at `/cairn:plan <N>`): run waves in order (`--wave N` runs just
   that wave). Within a wave, dispatch one subagent per issue IN PARALLEL —
   worktree isolation for any file-mutating issue. Each subagent runs the
   full per-issue lifecycle below (claim → work → close → ledger). Wave
   N+1 starts only when every wave-N issue is closed and merged. A failed
   issue: let the wave's others finish, then STOP before the next wave and
   report — never build on possibly-broken foundations.
3. For each issue id, in order: `issue_get(id)` — skip closed ones. If it's
   assigned to someone who is not you (compare against `user.handle` in
   cairn.json, only when it's set there — if unset, there are no ownership
   checks), say so and skip unless the user overrides.
4. Before starting an issue: record `git rev-parse HEAD` as this issue's
   `baseCommit` (for step 7's `ledger_append`). Then
   `issue_update(id, state: "in_progress")` — and when `user.handle` is set
   in cairn.json, also pass `assignee: <handle>` so teammates see who holds
   it. Then `context_set(phase: <N>, issueId: id)`.
5. Do the work the issue + PLAN.md describe. Track in-session with TaskCreate;
   the tracker stays the durable truth.
   When this issue's id is in PLAN.md `tdd:` frontmatter, the work is
   RED → GREEN → REFACTOR, each its own commit: (RED) write the failing
   test, run it, show the failure, commit; (GREEN) minimal code to pass,
   run, commit; (REFACTOR) clean up, tests stay green, commit. Record the
   RED and GREEN shas — `ledger_append` takes them as `redCommit` /
   `greenCommit` at close. Skipping RED on an eligible task: stop and
   restart the task; verify fails the phase on a missing pair regardless.
   A bug surfacing mid-issue that is NOT this issue's scope routes to
   `trace` (fast lane allowed) — never an inline detour; the trace's
   tracker issue keeps the discovery visible.
6. On completion **with tests passing**: `issue_close(id)`. On stopping early:
   leave in_progress and report why.
7. On `issue_close`: `ledger_append(phaseDir: <NN-slug>, taskRef: id, summary:
   <one line — what shipped>, baseCommit: <HEAD when this issue started>,
   headCommit: <HEAD now>, issueId: id, closedDate: <today, YYYY-MM-DD>,
   redCommit: <RED sha — TDD tasks only>, greenCommit: <GREEN sha — TDD
   tasks only>)` — the durable, git-committed record that the task landed.
8. After the last issue: `context_set(issueId: null)` and suggest
   `/cairn:verify <N>`.
