---
description: Execute a phase — claim issues, do the work, close on verified done
argument-hint: "<phase-number>"
---

Execute phase **$ARGUMENTS** per the `cairn-planning` skill.

1. `plan_status()` → this phase's `issues` list. Empty → stop and point at
   `/cairn:plan $ARGUMENTS`.
2. For each issue id, in order: `issue_get(id)` — skip closed ones. If it's
   assigned to someone who is not you (compare against `user.handle` in
   cairn.json, only when it's set there — if unset, there are no ownership
   checks), say so and skip unless the user overrides.
3. Before starting an issue: `issue_update(id, state: "in_progress")` — and
   when `user.handle` is set in cairn.json, also pass
   `assignee: <handle>` so teammates see who holds it. Then
   `context_set(phase: $ARGUMENTS, issueId: id)`.
4. Do the work the issue + PLAN.md describe. Track in-session with TaskCreate;
   the tracker stays the durable truth.
5. On completion **with tests passing**: `issue_close(id)`. On stopping early:
   leave in_progress and report why.
6. After the last issue: `context_set(issueId: null)` and suggest
   `/cairn:verify $ARGUMENTS`.
