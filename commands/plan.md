---
description: Plan a phase — research (per depth), write PLAN.md, reconcile tracker
argument-hint: "<phase-number> [--quick|--deep] [--model <auto|haiku|sonnet|opus>]"
---

Plan phase **$ARGUMENTS** per the `cairn-planning` skill's depth dial.

1. `plan_status()` — confirm the phase dir exists (else `plan_scaffold_phase` first;
   deep depth passes `research: true`).
2. Depth (flag > PLAN.md frontmatter `depth:` > cairn.json default > standard):
   - quick: no research; draft PLAN.md tasks directly.
   - standard: one research subagent for unknowns; write RESEARCH.md if material.
   - deep: parallel research fan-out per the skill's model-routing rubric, then a
     plan-checker pass over the draft.
3. Write the task breakdown into the phase's PLAN.md body. Keep decisions in
   CONTEXT.md — on conflict with tracker issue text, CONTEXT.md wins; update the
   issue via `issue_update`, never silently follow it.
4. Reconcile: `plan_drift()` — resolve anything flagged for this phase
   (recreate missing issues via `issue_create` + `plan_issues_set`; question
   closed-unverified ones with the user).
5. Adopt: `plan_unplanned()` — for any unplanned issue that belongs to this
   phase, add its id via `plan_issues_set` (and set its tracker phase with
   `issue_update` if the backend supports phases). Ask before adopting;
   batch the question, not one per issue.
6. Report the plan summary and next step `/cairn:work <N>`.
