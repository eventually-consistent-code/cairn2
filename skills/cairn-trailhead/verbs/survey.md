---
verb: survey
args: "[\"<topic>\"]"
status: live
---

Project-wide research, then roadmap changes — but only through a discussion
gate. `scout` researches one phase; survey researches the terrain: roadmap
gaps, cross-phase unknowns, assumptions gone stale since planning. Three
stages; NOTHING mutates before stage 2's gate, in any mode.

## Stage 1 — research (resumable, multi-agent)

1. `plan_status()` — project must exist (else stop: suggest `/cairn:new`).
2. Artifact is `.cairn/plans/SURVEY.md` (project level, next to
   roadmap.md). Same marker discipline as scout: each `## <topic>` section
   carries `<!-- survey: done -->` or `<!-- survey: pending -->` on the
   line after the heading. `done` sections are FINISHED — never
   re-research. No marker = legacy content, treat as done.
3. Topics: derive from roadmap.md phase table + each phase's CONTEXT.md
   unknowns + PROJECT.md goals — plus the user's topic argument when
   given, and map diff drift (stored graph vs. current truth) when a map
   exists. Append new topics as `pending` sections.
4. Tracker mirror: `issue_create` ONE plain-language research issue at
   start ("Project survey: <one-line scope>"); `issue_comment` progress in
   manager language as sections finish. If the tracker is down, continue
   git-side and create the issue when it recovers — say so.
5. Fan-out is mandatory (not depth-gated): dispatch ONE subagent per
   `pending` section, in parallel. Route each agent's model by the WORK
   CLASS OF THE TOPIC per the cairn-planning rubric — enumerate/locate →
   haiku-tier, synthesis brief → sonnet-tier, architecture trade-off →
   opus-tier; uncertain → inherit. Subagents return section content ONLY;
   the main thread writes the section and flips its marker as EACH agent
   completes. A failed agent's section stays `pending` with a one-line
   failure note — the next run retries it.

## Stage 2 — discussion (the gate)

6. Distill findings into concrete proposals, each exactly one of:
   **new phase N.5** · **rescope phase N** · **new issues in phase N** ·
   **no action**. One batched AskUserQuestion — multiSelect per proposal,
   cairn's recommendation first with trade-offs. This gate holds in vibe
   mode too: roadmap surgery from research is always "a peer would have
   wanted a say."

## Stage 3 — apply (approved proposals only)

7. New phases: `plan_scaffold_phase` with a DECIMAL number between
   neighbors (route's rule — never renumber) + `plan_phase_ensure` for
   the tracker object + a roadmap.md row between its neighbors.
8. Rescopes: CONTEXT.md edits recorded as locked decisions with SURVEY.md
   source links — what changed and why.
9. New work: `issue_create` + `plan_issues_set`, estimates per the plan
   verb's convention (points + minutes, always both).
10. Wrap: `mem_index` the finished SURVEY.md (source: its path), close
    the research issue (`issue_close`) with a plain summary of findings
    and applied changes, report sections done/remaining, and suggest
    `/cairn:plan <N>` for any new phase.
