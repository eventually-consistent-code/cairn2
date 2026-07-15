---
description: Verify a phase — goal-backward check, drift clean, write VERIFICATION.md
argument-hint: "<phase-number>"
---

Verify phase **$ARGUMENTS** per the `cairn-planning` skill.

1. Goal-backward: re-read the phase's CONTEXT.md and PLAN.md; check the codebase
   delivers what the phase PROMISED, not merely that tasks closed. Run the test
   suite. Deep depth: adversarial verification subagent per the routing rubric.
2. `plan_drift()` — this phase must contribute nothing flagged.
3. `issue_list(phase: <tracker phase id>, state: "open")` — must be empty; report
   stragglers instead of closing them unexamined.
4. Write `.cairn/plans/phases/<NN-dir>/VERIFICATION.md`: what was checked, what
   passed, deviations. (Its presence marks the phase verified — drift treats
   closed issues in verified phases as normal.)
5. Report pass/fail and next step (`/cairn:ship` or the fixes needed).
