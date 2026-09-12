<!--
  Wave-brief template — the reusable skeleton a `work` coordinator fills
  when dispatching one wave worker per issue. The standing rules below are
  the boilerplate every dispatch used to retype; they live here once.
  Slots (filled by the server's composeBrief, or by the coordinator
  reading this file directly; every occurrence of a slot is replaced, an
  unfilled slot is left verbatim so the gap shows):
    {{seat_framing}} — the seat section composed from a roster seat at
                       its declared dose (minimal = lens; standard =
                       + categories + honesty line; full = + anchors +
                       lens body); empty when the task names no seat
    {{issue}}        — the tracker issue content: id, title, body
    {{plan_excerpt}} — this issue's PLAN.md task text, plus any locked
                       CONTEXT.md decisions that bind it
    {{rules}}        — wave-specific standing-rule details: expected
                       base sha, setup commands (e.g. `npm ci` first),
                       the dispatching session's commit trailer block
-->

{{seat_framing}}

## Task

{{issue}}

## Plan excerpt

{{plan_excerpt}}

## Standing rules

- Work in your assigned isolated worktree. FIRST `git merge --ff-only main`;
  commit locally; never push.
- Conventional commits, atomic — one logical change per commit; every
  commit carries the dispatching session's trailer block (below).
- Leak-guard discipline: anything that reaches the tracker or the report
  stays in plain language — no local paths, tokens, or internal URLs.
- Stay on this issue's scope; a bug outside it is reported, never an
  inline detour.

{{rules}}

## Report

Return: branch + shas, files touched (absolute paths), test evidence
(suite + counts), guard outputs, reported token usage, and any
deviations from the plan.
