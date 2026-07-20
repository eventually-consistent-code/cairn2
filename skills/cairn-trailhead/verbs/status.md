---
verb: status
args: ""
status: live
---

Show project status:

1. `plan_status()` — phase table: number, name, artifacts present
   (C/R/P/V), issue count.
2. For the active phase (`context_get`), `issue_get` each referenced issue and
   show id · title · state · assignee.
3. `plan_drift()` — append flagged items, each with its one-line remedy
   (missing → recreate + `plan_issues_set`; closed-unverified → verify or reopen).
4. `plan_unplanned()` — tracker issues no plan references. If any: list
   id · title · assignee and offer adoption (`/cairn plan <N>` folds them in,
   or `/cairn import` if they belong to a whole unmapped phase).
5. Marks: from the open-issue list, group `cairn:backlog` and `cairn:seed`
   labeled issues separately from phase work. For each open seed, read its
   `Trigger:` line and flag it when current project state reads as meeting
   the trigger — firing is your judgment call to surface, the user's to act.
6. Keep it to one screen; end with the obvious next `/cairn` step.
