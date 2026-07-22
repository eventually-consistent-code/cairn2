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
- Open traces: `trace_list(status: "open")` — report id, description, age
  (from created), linked issue, and last entry kind. An open trace is
  unfinished debugging — surface it every time.
- Open sessions: `session_landscape()` — report `openByKind` in plain
  language beside the trace detail above (e.g. "open sessions: 1 trace, 2
  probes, 0 drafts"). An open probe or draft is unfinished spike/sketch
  work — surface it every time, same as an open trace.
- Open audit/review findings: `issue_list` filtered by label `cairn:audit`
  and again by `cairn:review`, reported in plain language beside the
  session detail above (e.g. "open audit findings: 2 · open review
  findings: 0"). These are outstanding Critical/Important findings still
  waiting on a fix or a trace — surface them every time, same as an open
  trace.
6. Keep it to one screen; end with the obvious next `/cairn` step.
