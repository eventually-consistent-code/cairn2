# Verification record

## Tier 0 — Trailhead (2026-07-15)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: 11 live, 17 reserved, 23 server
  tools. All five detector classes verified against seeded breakages
  (missing live subroutine, reserved-verb file, unknown tool reference —
  each produced the expected named failure, then restored to clean).
- Server untouched: `npx vitest run` 217 passed / 6 skipped; `tsc --noEmit`
  clean after every task.

### Always-present token footprint (method: `ceil(chars/4)` over each
registered command's `description` + `argument-hint`)
| state | cost |
|---|---|
| before (7 command files) | ~172 tok |
| after (entrypoint + 7 shims, transition period) | ~213 tok |
| post-P5′ cutover (entrypoint only) | ~23 tok |

Stated plainly: during the shim transition the always-present cost is ~41
tokens HIGHER (one extra registered command). The 86% reduction (172 → 23)
lands when shims are removed at P5′. The structural win (subroutine bodies
and routing table load only on invocation) applies now.

### Deviations from plan
- Plan said 16 reserved verbs / 27 table rows; the Tier 0 spec's verb table
  counts 17 / 28. Spec is authoritative; implemented 17/28 and corrected the
  plan doc.

### Dogfood drill — PENDING (needs a live session with cairn2 installed)
Steps to run: install cairn2 as a local plugin; in a scratch repo with
`cairn.json` configured against a real tracker: `/cairn new` → `/cairn plan 1`
→ `/cairn work 1` → `/cairn verify 1` → `/cairn ship`; plus
`/cairn do "what's the status"` (expect: routes to status, runs without
confirmation) and `/cairn wrok` (expect: help with "did you mean work?").
Record results here.

## Tier A0 — Continuity (2026-07-16)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: 12 live, 16 reserved, 28 server
  tools (waypoint flipped reserved-A0 → live per this tier; the (e) reserved-set
  check ratchets down accordingly).
- Server: `cd server && npx vitest run` → 289 passed / 6 skipped (295);
  `npx tsc --noEmit` clean.

### Byte-stability evidence (G7 — recall banner, spec success criterion 2)
`server/test/banner.test.ts`:
- `renderBanner > byte-stability: two renders against an unchanged store are
  byte-identical` — renders twice against an unchanged card store and asserts
  `Buffer.equals` on the output. PASS.
- `renderBanner > orders issue-scoped before phase-scoped before project-wide
  cards, with id tiebreak inside each bucket` — confirms the ordering that
  makes byte-stability possible is deterministic, not incidental. PASS.
- `renderBanner > renders id/type/title/fetch-cost rows plus header and
  footer per the spec table` — confirms no timestamp or volatile field ever
  enters the rendered text. PASS.
- Full file: 15/15 passed.

### Storm-test evidence (hook throttle, spec success criterion 5)
`server/test/hooks.test.ts`:
- `posttooluse-breadcrumb > storm test: 5 rapid invocations produce at most 1
  write (60s throttle)` — fires the breadcrumb script 5 times back-to-back
  against a fixture handoff dir and asserts the file's mtime changed exactly
  once. PASS.
- `posttooluse-breadcrumb > wall-clock stays well under the <100ms budget` —
  PASS (measured, see test for the assertion threshold).
- `precompact-refresh > is unthrottled: writes even immediately after a fresh
  write` — confirms PreCompact deliberately bypasses the breadcrumb's
  throttle (full refresh always wins before compaction). PASS.
- Full file: 12/12 passed.

### Tracker-contradiction handling (spec success criterion 3)
Implemented as the resume half of `/cairn waypoint` (`skills/cairn-trailhead/
verbs/waypoint.md`): trust order is tracker + `git log` > `LEDGER.md` >
handoff, per spec §Locked decisions #6. This is a skill-level (prompt)
behavior, not server-testable in isolation — verified by code review of the
verb doc against the spec's trust order and by the kill-drill procedure
below, which exercises it end-to-end. No automated test exists for this path
by design (it requires a live tracker + an agent session).

### Kill-drill procedure
Spec success criterion 1: a session killed mid-`work` (crash, compaction,
usage cap, `/clear`) resumes at the exact task with zero re-executed work.
Two drills, recorded here once run, same format as Tier 0's dogfood drill:

**Drill A — kill mid-`work`.**
1. In a scratch repo with `cairn.json` against a real tracker: `/cairn new` →
   `/cairn plan 1` → `/cairn work 1`.
2. Mid-issue (after at least one `issue_update(state: "in_progress")` but
   before `issue_close`), kill the session hard (terminate the process, not
   `/clear`).
3. Start a new session in the same repo. Expect: `SessionStart` hook injects
   the resume block (phase, issue, current task, next_action, age <60s from
   the `PostToolUse` breadcrumb or the exact task if a tool call landed
   after).
4. `/cairn waypoint resume` → expect tracker cross-check confirms the issue
   is still `in_progress` (matches handoff), no contradiction reported,
   resume proceeds to the exact task with no prior work repeated.

**Drill B — forced compaction mid-`work`.**
1. Same setup; mid-issue, force a compaction (e.g. `/compact` or exceed the
   context window deliberately).
2. Expect: `PreCompact` hook fires an unthrottled handoff refresh before
   compaction discards context.
3. After compaction, `/cairn waypoint resume` (or the `SessionStart`-style
   check if compaction triggered a fresh session) → expect the exact task
   resumes, zero re-executed work.

### Kill-drill results — RUN 2026-07-17 (mechanical, real tracker) — PASS 12/12

Run mechanically post-merge: the real `dist/index.js` server driven over
stdio against a real GitHub tracker (scratch private repo
`eventually-consistent-code/cairn-drill-scratch`), hook scripts spawned
exactly as the plugin would fire them, server process killed with SIGKILL
mid-work. Repeatable drivers committed at `server/drills/drill-a.mjs` and
`server/drills/drill-b.mjs` (run from `server/`:
`node drills/drill-a.mjs <projectDir> $PWD/dist/index.js`, then
`drill-b.mjs <projectDir> <dist> <issueId> <hooks/scripts dir>`).

**Drill A — PASS.** Real issue created + `in_progress` + checkpoint; SIGKILL
mid-session → handoff file intact (valid JSON, exact issue/task/next_action,
version 1). Simulated PostToolUse breadcrumb honored the 60s throttle (fresh
file → skip), then after mtime backdate merge-patched `source:"posttooluse"`
+ `uncommitted_files` while preserving task fields. SessionStart hook
injected the resume block (issue, current task, next action, age, `prompt`
phrasing). Fresh server: `continuity_get` → non-stale, exact task;
`issue_get` cross-check → tracker `in_progress`, matches handoff, no
contradiction. Resumed at the exact task with zero re-executed work.

**Drill B — PASS.** Fresh handoff write then immediate
`precompact-refresh.mjs` → wrote despite the <60s-old file (unthrottled),
stamped `source:"precompact"`, task fields survived; post-"compaction"
`continuity_get` reads the exact task.

**Contradiction sub-check (criterion 3 data path) — PASS.** Issue closed
out-of-band on the tracker while handoff still said mid-task: `issue_get`
(`closed`) vs handoff (`step-2`) mismatch is fully detectable — the data the
`waypoint resume` trust order needs is all present. `continuity_clear`
removed the handoff on confirmed resume.

**Caveat:** this exercises every process and file the live flow touches
(server, all three hook scripts, real tracker), but not the agent-side
`waypoint` verb behavior itself — that remains prompt-level, verified by
review. Worth one live dogfood pass alongside the Tier 0 drill above when
cairn2 is next installed as a local plugin.

**Fix landed during the drill:** SessionStart resume header read
"(just now ago)" for fresh handoffs — copy corrected to "(just now)"
(`hooks/scripts/sessionstart-continuity.mjs`).
