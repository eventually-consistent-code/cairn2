---
verb: resync
args: ""
status: live
---

Codebase ↔ plan drift: find commits the planning layer never saw, refresh
the context they invalidate.

1. `plan_resync()` — first run just initializes the marker (say so, done).
2. No out-of-band commits → report clean, done.
3. Otherwise group the commits by likely phase (file paths vs each phase's
   PLAN.md task areas — judgment, say your reasoning) and present the
   report: sha, subject, files, suspected phase.
4. For each affected phase, batched into one AskUserQuestion per phase at
   most: refresh CONTEXT.md (what the out-of-band work changed about the
   locked decisions) and PLAN.md task notes. Assumptions broken outright →
   offer `/cairn plan <N> --gaps`.
5. The marker already advanced (the tool did it) — note that re-running
   reports clean from here, and say what was refreshed.
