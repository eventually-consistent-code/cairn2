---
verb: scout
args: "<N>"
status: live
---

Research the given phase WITHOUT planning it — `plan`'s research stage alone,
resumable (#1961 shape: never redo finished research).

1. `plan_status()` — phase dir must exist (else `plan_scaffold_phase` with
   `research: true` first).
2. If RESEARCH.md exists, parse its section markers: each `## <topic>`
   section carries `<!-- scout: done -->` or `<!-- scout: pending -->` on
   the line after the heading. Sections marked `done` are FINISHED — do not
   re-research them. No marker = legacy content, treat as done.
3. Determine research topics from CONTEXT.md unknowns + PLAN.md gaps (depth
   dial per the `cairn-planning` skill). New topics get `pending` sections
   appended; only `pending` sections get researched.
4. Fan out — mandatory, not depth-gated: dispatch ONE subagent per
   `pending` section, in parallel, model routed by the WORK CLASS OF THE
   TOPIC per the cairn-planning research fan-out rubric (enumerate/locate
   → haiku-tier, synthesis brief → sonnet-tier, architecture trade-off →
   opus-tier; uncertain → inherit). Subagents return section content ONLY;
   the main thread writes each section and flips its marker to `done` as
   EACH agent completes — a kill mid-run must lose at most the in-flight
   sections, never finished ones. A failed agent's section stays `pending`
   with a one-line failure note.
5. `mem_index` the finished brief (source: the RESEARCH.md path). Report
   sections done/remaining and suggest `/cairn:plan <N>`.
