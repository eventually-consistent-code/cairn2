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

## Tier A — Planning Depth (2026-07-18)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **18 live, 10 reserved, 33 server
  tools** (`probe`/`draft` sit at `reserved-C` per the Tier A spec's
  re-tiering decision; the six new verbs — `scout`, `route`, `summit`,
  `auto`, `fast`, `resync` — are live).
- Server: `cd server && npx vitest run` → **328 passed / 6 skipped** (334
  total; the 6 skips are the env-gated `*.live.test.ts` suites — gitlab,
  jira, asana, azure-boards, clickup, github — which only run with
  `CAIRN_LIVE_TESTS=1` and real backend credentials, per
  `server/README.md`'s live-gate instructions). `npx tsc --noEmit` clean.
  `npm run build` clean; `server/dist/` rebuilt and committed alongside this
  record.

### Unit evidence summary

**Milestone mapping fixtures per adapter** (`test/*.unit.test.ts`, P1
fixture-HTTP pattern):
- `jira.unit.test.ts` — `createMilestone` resolves the Jira `projectId` once
  then POSTs a `version` (fixVersion); `listMilestones` GETs project
  versions; `completeMilestone` releases the version. `hasMilestones: true`.
- `azure-boards.unit.test.ts` — `createMilestone` POSTs an Epic-typed work
  item via JSON-patch; `listMilestones` WIQL-queries epics then batch-gets;
  `completeMilestone` PATCHes work-item state. `hasMilestones: true`.
- **Fallback pinning** (`hasMilestones: false`, capability-flagged) —
  `github.unit.test.ts`, `gitlab.unit.test.ts`, `asana.unit.test.ts`,
  `clickup.unit.test.ts`: each asserts `capabilities.hasMilestones === false`
  and that `createMilestone`/`listMilestones`/`completeMilestone` all reject
  with `code: "UNSUPPORTED"` rather than silently no-op-ing. (GitHub and
  GitLab still support native `createPhase`/`closePhase` milestone-as-phase
  mapping — the fallback is specifically the roadmap-milestone object, not
  the phase primitive.)

**`milestone_complete` gate/ordering/idempotency**
(`test/milestones.test.ts`, `describe("milestoneComplete")`):
- gates on unverified phases and moves nothing if any phase lacks
  `VERIFICATION.md`.
- happy path: closes tracker phases, releases the native milestone (when
  supported), archives `phases/` → `milestones/vN/`, bumps `roadmap.md`.
- **is re-runnable**: already-closed tracker phases don't error on a second
  run (safe after a partial tracker failure mid-`milestone_complete`).
- records skips (rather than erroring) when `hasPhaseClose` is false, and
  archives anyway.
- `milestoneCreate`/`milestoneList`: create stamps `milestone_id` into
  `roadmap.md`; list merges the git archive with the tracker's native list
  when supported.

**`plan_resync` coverage math** (`test/resync.test.ts`, real throwaway git
repos via `git init`/`git commit` in a temp dir, not mocks):
- first run initializes the resync marker and reports nothing (no false
  positives on a fresh project).
- flags commits not covered by any `LEDGER.md`-recorded range; ledgered
  ranges are correctly excluded ("out of band hotfix" flagged, "ledgered
  work" not).
- advances the marker after each run — a second run only sees commits made
  since the last resync, not the same rogue commit twice.

**`plan_meta_set` validation matrix** (`test/artifacts.test.ts`,
`describe("plan meta (waves/tdd)")`):
- write + read round-trips `waves` (array-of-arrays of issue ids) and `tdd`
  (issue-id list) through PLAN.md frontmatter.
- re-writing `waves` replaces stale `wave_N` keys rather than leaving orphans
  from a shorter previous wave count.
- rejects unknown issue ids, duplicate ids across waves, and empty wave
  arrays — the validation matrix the spec calls for.

**Ledger TDD pair + byte-stable no-TDD format** (`test/ledger.test.ts`):
- creates the file with a header on first append; second append adds
  exactly one line, leaving the first untouched (append-only, byte-stable
  format for entries with no TDD evidence).
- sanitizes embedded newlines in entry fields to a single line (no
  multi-line ledger entries corrupting the append-only format).
- throws `NOT_FOUND` with a `nextAction` for a `phaseDir` that doesn't exist.
- **TDD pair**: appends a `— tdd ccccccc..ddddddd —` evidence segment when
  both `redCommit` and `greenCommit` are given; **rejects a lone red or
  green commit** — a `tdd:`-tagged task cannot land with only half the pair,
  which is the mechanism success criterion 3 (below) depends on at the
  `ledger_append`/verify layer.

### Dogfood drill procedures (run 2026-07-19 — results below)

Per spec §6.3, three drills, to be run in a scratch project with cairn2
installed as a local plugin and recorded here once run, same format as the
Tier 0 dogfood drill and the Tier A0 kill-drills above.

**Summit drill — RUN 2026-07-19, see results below.**
1. Scratch project, 2 phases, both driven to `VERIFICATION.md`-verified
   completion (`plan`, `work`, `verify` each phase).
2. Run `/cairn summit` against a `hasMilestones` backend — **Jira** (fix
   version) or **Azure Boards** (Epic) — pick one. This is the first
   milestone, so no native milestone id is stamped yet: accept the summit
   flow's offer (step 1/2 of `summit.md`) to create one now via
   `milestone_create("v1")` before completion proceeds. Expect: tracker
   phases closed, native milestone released, `phases/` archived to
   `milestones/v1/`, `roadmap.md` bumped, milestone tag/id correct.
3. Repeat step 2's `summit` call again immediately. Because step 2 already
   fully archived the milestone, `projectStatus` now shows zero live phases
   — expect `PRECONDITION_FAILED` ("no live phases to complete"), not a
   silent no-op. That exact error is the recorded pass condition here; a
   clean re-run only happens when a *partial* tracker failure (a
   `TRACKER_DOWN` from step 2) left the phases live and un-archived — in
   that case re-running completes cleanly with no duplicate archive and no
   double-release attempt (per `milestoneComplete`'s "is re-runnable" unit
   coverage above, now exercised against a live tracker).
4. Separately, run the same 2-phase scratch flow against **GitHub**
   (fallback, `hasMilestones: false`). Expect: tracker phases (milestones)
   closed via the native `closePhase` mapping, roadmap-milestone object
   creation/release skipped (recorded, not errored), archive + tag still
   correct.

**Auto drill — RUN 2026-07-19, see results below.**
1. 2-phase scratch project; run `/cairn auto` hands-off (no per-task
   confirmation).
2. Expect: every non-taste decision `auto` makes during the run traces to an
   encoded principle in its run report (spec success criterion 2 — zero
   un-principled unattended decisions); a taste-decision batch is presented
   at the end, not mid-run.
3. Rig a failing `verify` on one task (e.g. a deliberately broken test).
   Expect: `auto` hard-stops with a usable report naming the failing task
   and the failure, rather than continuing past it or retrying silently (no
   self-repair loop — that's Tier C `trace`, a non-goal here).
4. Mid-run (after at least one task has landed), `SIGKILL` the session.
   Start a new session; `/cairn waypoint resume` → expect `auto` continues
   from the exact next task, zero re-executed work — same continuity
   mechanism the Tier A0 kill-drills exercised, now driven through `auto`
   instead of `work`.

**Wave drill — RUN 2026-07-19, see results below.**
1. Scratch phase with 4 issues, grouped into 2 waves via `plan_meta_set`
   (e.g. `waves: [[issue1, issue2], [issue3, issue4]]`).
2. Run the wave-aware execution flow. Expect: wave 1's two issues dispatch
   to parallel subagents; both are claimed (`issue_update(state:
   "in_progress")`), closed, and ledgered (`ledger_append`) before wave 2
   starts.
3. Confirm wave 2 does not begin dispatching until every wave 1 issue is
   closed + ledgered (wave ordering is a hard gate, not a soft hint).
4. All 4 issues end claimed → closed → ledgered, in the order the wave
   grouping specifies.

### Drill results — RUN 2026-07-19 (mechanical, real trackers) — PASS 47/47

Run mechanically post-merge, same harness as the Tier A0 kill-drills: the
real `dist/index.js` server driven over stdio, hook-free, against REAL
trackers — GitHub (scratch private repo
`eventually-consistent-code/cairn-drill-scratch`) and a REAL Jira Cloud site
(`eventually-consistent.atlassian.net`, scratch project `DRILL`,
company-managed kanban). Repeatable drivers committed at
`server/drills/drill-summit.mjs`, `drill-auto.mjs`, `drill-wave.mjs` (run
from `server/`: `node drills/drill-<name>.mjs <projectDir> $PWD/dist/index.js`;
summit reads the backend from the project's `cairn.json`).

**Summit drill — PASS (Jira native 14/14, GitHub fallback 13/13).** Both
legs: 2 phases planned/worked/verified end-to-end (real issues claimed,
closed, ledgered with real commit ranges). Jira: epics closed via the
transition machinery, first-milestone bootstrap exercised exactly as
`summit.md` step 1 specifies (`milestone_list` → no stamped id →
`milestone_create("v1")` → fixVersion created + `milestone_id` stamped),
`milestone_complete` released the real fixVersion (`state: "released"`),
archived `phases/` → `milestones/v1/`, bumped roadmap to `milestone: 2`.
GitHub: both milestone objects closed via native `closePhase`, native
release correctly skipped (recorded, not errored). Both legs: `git tag v1`,
`continuity_clear`, and the post-success re-run returned
`PRECONDITION_FAILED` ("no live phases to complete") — the recorded pass
condition.

**Auto drill — PASS 12/12.** Leg 1 (hands-off 2-phase run): both phases
planned → worked → verified with zero mid-run confirmations; every
non-taste decision in the run report traces to an encoded principle
(criterion 2), taste batch (2 items) presented once at the end. Leg 2
(rigged verify failure): hard stop with a report naming the failing task
and failure; no VERIFICATION.md written, failing issue left `in_progress`,
phase 2 never started. Leg 3 (SIGKILL mid-run after phase 1 landed): fresh
server read a non-stale handoff naming phase 2's exact task, tracker
cross-check matched (`in_progress`), phase 1 issues untouched (still
closed, zero re-executed work), run completed from the exact task.

**Wave drill — PASS 8/8.** 4 real issues in 2 waves via `plan_meta_set`
(validation + `wave_N` frontmatter round-trip confirmed). Wave 1's two
workers ran concurrently — both issues observed `in_progress`
simultaneously mid-flight — then closed + ledgered. The hard gate held:
wave 2 was not dispatched until every wave-1 issue was closed AND ledgered,
and wave-2 issues were verified still open/unledgered at gate time. All 4
ended claimed → closed → ledgered, ledger entries in wave order.

**Caveat (same as Tier A0):** the drivers exercise every server tool, file,
and tracker call the live flows touch, and follow the verb docs'
step-by-step procedure — but agent-side judgment (the batched
AskUserQuestion flows, principle selection in an unattended run) is
simulated by the driver, verified by review. An earlier wave-driver variant
gave each worker its own server process and failed on split-brain read
caches — corrected to the real architecture (parallel subagents share the
session's single MCP server, whose write-through invalidation keeps reads
coherent); worth remembering if wave execution ever moves to multi-session
dispatch (Tier F).

**Fix landed during the drill:** Jira's `POST /rest/api/3/search` now
returns HTTP 410 Gone (Atlassian removed the endpoint in favor of
`/rest/api/3/search/jql`); `listIssues`/`listPhases` migrated, unit fixtures
updated (`server/src/tracker/adapters/jira.ts`). Found live on first
contact with a real Jira site — the fixture suite and env-gated live tests
could never have caught it.

## Tier B — Lightweight Subsystems (2026-07-20)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **23 live, 5 reserved, 36 server
  tools** (`mark`, `retro`, `distill`, `brief`, `tune` flip reserved → live;
  reserved shrinks to `probe`/`draft`/`trace`(C), `triage`(D), `basecamp`(F)
  per the Tier B spec's re-tiering).
- Server: `cd server && npx vitest run` → **349 passed / 6 skipped** (355
  total; same env-gated `*.live.test.ts` skips as Tier A). `npx tsc --noEmit`
  clean. `npm run build` clean; `server/dist/` rebuilt and committed
  alongside this record.

### Unit evidence summary

**Card `note` type + confidence round-trip** (`test/cards.test.ts`):
- `createCard`/`readCard`: `"creates a note card with confidence and
  round-trips both"` — writes a `note`-typed card with `confidence: "high"`
  and reads back both fields unchanged; `"confidence is optional and absent
  by default"` confirms the field never appears uninvited on older card
  shapes.
- `updateCardConfidence`: `"patches frontmatter only — id and body stable"`
  — changes confidence on an existing card and asserts the card's id (a
  content hash of the body) and body text are byte-identical before/after;
  `"on unknown id throws NOT_FOUND"`. Together this is the spec's body-
  immutable contract: a changed *lesson* is a new card, a changed
  *confidence* is a patch to the same one.

**Banner confidence + byte-stability** (`test/banner.test.ts`, 16/16):
- `"shows confidence in the type cell when present"` — confidence surfaces
  in the rendered banner row when set.
- `"byte-stability: two renders against an unchanged store are
  byte-identical"` (carried over from Tier A0, re-verified with confidence
  now in play) — confidence is stable content, not volatile; it does not
  break the `Buffer.equals` guarantee the SessionStart cat-only read
  depends on.

**Config merge / null-delete / invalid-untouched / secret-refusal matrix**
(`test/config.test.ts`, `describe("writeConfigPatch")`):
- `"merges nested keys and returns the validated result"` — deep-merge
  patch, validated post-merge.
- `"null deletes a key"` — same convention as `patchRoadmapMeta`.
- `"invalid merged config leaves the file untouched"` — a patch that fails
  `ConfigSchema` validation never reaches disk; `CONFIG_INVALID` thrown,
  file byte-identical to before the call.
- `"refuses secret-looking keys and values"` — credential/env-var-shaped
  patch fields are rejected server-side; secrets live in env vars only.
- `"leakGuard defaults land via loadConfig"` — the new config block
  defaults cleanly for projects with no `leakGuard` key yet, same backward-
  compatibility posture as the Tier A0 `continuity` block.

**Leak-pattern class matrix** (`test/leak-patterns.test.ts`, 4/4):
- `"hits every default class"` — one hit each for `cairn-path`, two
  `phase-ref`s, `cairn-label`, `tracker-id` (Jira `DRILL-42`) in a six-line
  fixture; the seventh clean line produces no hit.
- `"github config gets NO tracker-id pattern — #N never matches"` — spec's
  explicit non-match: `"fixes #123 properly"` scans clean under a GitHub
  config, since bare `#N` is legitimate issue-reference prose, not a leak.
- `"extraPatterns extend; invalid regexes are skipped silently"` — a
  malformed regex in `leakGuard.extraPatterns` (`"(["`) never throws or
  disables the guard; it's dropped and the well-formed pattern still hits.
  This is the **regex-injection gate** on user-controlled config: a broken
  or hostile pattern in `cairn.json` can degrade to "one fewer custom
  pattern," never to a crash or a bypass.
- `"allowlist: defaults + trailing-/** config globs"` — `.cairn/**`,
  `docs/**`, `*.md`, and config-supplied `glob/**`/exact-path entries all
  skip scanning; `src/*.ts` does not.

**Hook block / clean-pass / non-commit-ignore / bypass / timing**
(`test/hooks.test.ts`, `describe("leak guard hook")`, part of the file's
19/19):
- `"blocks a staged .cairn/ leak in a source file (exit 2, listing on
  stderr)"` — exit 2, stderr contains `app.ts:1:` and the pattern name
  (`cairn-path`) — the **hunk-accurate line number** (parsed from the
  diff's `@@ -a,b +c,d @@` header, not a diff-relative offset) landing on
  the real file line.
- `"clean staging passes; markdown files are allowlisted"` — exit 0 with a
  clean source file plus an allowlisted `.md` file that itself mentions a
  `.cairn/` path.
- `"non-commit commands exit 0 without scanning"` — `git status` short-
  circuits before any diff is even read.
- `"CAIRN_LEAK_OK=1 and leakGuard.enabled=false both bypass"` — both escape
  hatches from spec §3 verified independently.
- `"CAIRN_LEAK_OK=1 quoted in the commit message does NOT bypass"` — the
  override must **prefix** the command (spec wording); a commit message
  that merely *mentions* the token (`git commit -m "add CAIRN_LEAK_OK=1
  feature flag"`) still blocks (exit 2). This is the hardened form — see
  "fix loop" below.
- `"wall-clock stays under the 100ms budget"` — measured, same budget and
  fail-open posture as the Tier A0 hooks.

**Suite totals:** 349 passed / 6 skipped, `tsc --noEmit` clean.

### The fix loop worth recording

Review during B6 (leak guard hook) caught two gaps in the first pass:
1. **Bypass matching was substring, not prefix-anchored.** An early cut of
   `pretooluse-leakguard.mjs` matched `CAIRN_LEAK_OK=1` anywhere in the
   command string, which meant a commit message that only *quoted* the
   token (e.g. documenting the escape hatch, or an attacker hiding the
   string in prose) would silently disable the guard. Hardened to
   `/^\s*CAIRN_LEAK_OK=1\s/` — the override must prefix the command, per
   spec §3's wording — and the quoted-in-message case above was added as
   its own regression test rather than trusting the fix by inspection.
2. **Line numbers were diff-relative, not file-accurate.** The first cut
   counted added lines from the top of each file's diff hunk without
   reading the hunk header, so a leak reported past the first hunk pointed
   at the wrong line. Fixed by parsing each `@@ -a,b +c,d @@` header for
   the true starting file line and incrementing per added line from there
   — the `app.ts:1:` assertion above is exact-line, not approximate.

### Dogfood drill procedures (spec §6.3)

Per spec §6.3, four drills, to be run in a scratch project with cairn2
installed as a local plugin and recorded here once run, same format as the
Tier 0 dogfood drill and the Tier A0/Tier A kill-drills above.

**Mark drill — RUN 2026-07-20, see results below.**
1. `/cairn mark "<text>"` (bare) → expect: one tool call
   (`issue_create(title: <text>, labels: ["cairn:backlog"])`), zero
   questions asked, the real tracker shows a bare backlog issue with the
   text as its title.
2. `/cairn mark "<text>" --seed "<trigger>"` → expect: one tool call, issue
   labeled `cairn:seed`, body `Trigger: <trigger>`, appears on the real
   tracker. `/cairn status` later lists it as an open seed.
3. `/cairn mark "<text>" --note` → expect: one tool call
   (`mem_card_create(type: "note", body: <text>)`), auto-scoped to the
   active phase/issue, zero questions asked.
4. Pass condition: all three kinds land in exactly one tool call each, with
   no `AskUserQuestion` at capture time; the note card is recallable via
   `mem_search`/`mem_card_recall` afterward.

**Leak drill — RUN 2026-07-20, see results below.**
1. In a scratch repo with cairn2 installed, stage a source file containing
   both a `.cairn/` path string and a real tracker id in the configured
   backend's format (e.g. `PROJ-42` for Jira).
2. `git commit` through Claude Code → expect: blocked, exit 2, a
   `file:line` listing on stderr naming both hits.
3. Fix the flagged lines, re-stage, commit again → expect: passes clean.
4. Re-introduce the leak; commit prefixed with `CAIRN_LEAK_OK=1` → expect:
   overrides once, commit succeeds.
5. `/cairn tune leakguard off`; re-introduce the leak; commit → expect: no
   longer blocked (guard disabled). `/cairn tune leakguard on` restores it.
6. Pass condition: real staged leak blocked with an accurate listing in
   under 100ms (wall-clock observed, not just asserted in the unit harness
   above); both escape hatches confirmed live.

**Retro drill — RUN 2026-07-20, see results below.**
1. Against a real completed, verified phase in a scratch project: run
   `/cairn retro`.
2. Expect: lessons extracted from `LEDGER.md` ranges, `VERIFICATION.md`,
   `git log`, and closed issues, written as `note` cards via
   `mem_card_create` with provenance (files + commits) and a confidence
   level (`high`/`medium`/`low`) per the spec's grading rule.
3. Plant a prior card in this phase's scope that a later event
   contradicts; run `retro` again → expect: the planted card's confidence
   is down-ranked to `low` via `mem_card_update` (id and body unchanged,
   confidence field only) and a corrected lesson is written as a NEW card,
   with one batched `AskUserQuestion` approving the whole set before
   anything is written.
4. Pass condition: a card's confidence demonstrably changes because of what
   a later phase proved, live — not just in the unit-level round-trip
   above.

**Distill drill — RUN 2026-07-20, see results below.**
1. Post-`summit` (or post-`ship`) on a scratch project with at least one
   shipped phase carrying locked decisions, a `LEDGER.md`, and
   decision/constraint cards in scope: run `/cairn distill`.
2. Expect: `docs/ARCHITECTURE.md` updated per-section (hand-written content
   never clobbered, conflicts flagged), one `docs/adr/NNNN-<slug>.md` per
   locked decision that shaped code (provenance-linked to commits), and
   `docs/CHANGELOG.md` entries grouped by phase from ledger summaries — one
   batched confirmation showing a diff summary before anything commits.
3. Mechanically scan every generated file with the `leak-patterns.mjs` CLI
   (`node hooks/scripts/leak-patterns.mjs docs/ARCHITECTURE.md
   docs/adr/*.md docs/CHANGELOG.md`) → expect: zero hits — the same scanner
   the hook enforces, run against distill's own output.
4. Pass condition: distill output contains zero internal refs (tracker ids
   rewritten to plain prose, phase refs rewritten to milestone/version
   names), proven by the scanner, not by eyeballing; ADRs trace to locked
   decisions.

### Drill results — RUN 2026-07-20 (mechanical, real tracker) — PASS 30/30

Same harness as the Tier A drills: real `dist/index.js` over stdio, hook
scripts spawned exactly as the plugin fires them, real GitHub tracker
(`eventually-consistent-code/cairn-drill-scratch`) where a tracker is
touched; the leak/distill legs use a jira-shaped `cairn.json` (projectKey
`DRILL`) since the tracker-id pattern is config-derived, no live Jira
needed. Repeatable drivers at `server/drills/drill-{mark,leak,retro,
distill}.mjs` (run from `server/`: `node drills/drill-<name>.mjs
<projectDir> $PWD/dist/index.js`).

**Mark drill — PASS 8/8.** Each capture kind was exactly ONE tool call, no
interview anywhere in the flow: backlog → bare real issue (label
`cairn:backlog`, empty body, open); seed → real issue with `Trigger:` body;
note → `note-*` card auto-scoped to the active phase, recallable via
`mem_card_list` and `mem_card_recall`; tracker read-back intact.

**Leak drill — PASS 9/9.** Staged `.cairn/` + `DRILL-42` leak → exit 2 with
hunk-accurate `app.ts:1: [cairn-path]` / `[tracker-id]` listing; fixed
staging → exit 0; `CAIRN_LEAK_OK=1` prefix → bypass; the same token QUOTED
in a commit message → still blocks (prefix anchoring held); the
review-hardened widened scan caught an UNSTAGED tracked leak under
`git commit -am` while a plain commit with nothing staged passed; and the
tune front door — a real `config_set({leakGuard:{enabled:false}})` — 
disabled the guard.

**Retro drill — PASS 7/7.** Real phase worked to verified (issue claimed →
closed → ledgered with real commit ranges). A deliberately WRONG prior card
planted at confidence `high` ("bump the retry count") was re-graded to
`low` via `mem_card_update` after the phase's evidence contradicted it —
id/body unchanged — and the correction landed as a NEW card; the lesson
card carries provenance (file + commit from the ledger range). Recall
surfaces the down-rank; banner re-rendered. Spec success criterion 3
demonstrated live.

**Distill drill — PASS 6/6.** A naive first-draft ADR carrying
`phases/01-…`, `.cairn/` and `DRILL-77` refs was CAUGHT by the
`leak-patterns.mjs` CLI (exit 1, all three pattern classes); rewritten
public-safe (commit sha instead of internal refs) → re-scan exit 0 — the
gate; final `docs/` set (ADR + ARCHITECTURE + CHANGELOG-from-ledger)
mechanically scanned clean; the ADR traces to the locked decision via
commit sha only. Spec success criterion 4 demonstrated.

**Caveat (as prior tiers):** drivers exercise every tool, file, hook, and
tracker call the flows touch, following the verb docs step-by-step;
agent-side judgment (batched approval questions, lesson wording) is
simulated by the driver, verified by review.

## Tier C1 — Trace (Persistent Debugging Sessions) (2026-07-21)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **24 live, 4 reserved, 41 server
  tools** (`trace` flips reserved → live; reserved shrinks to `probe`/`draft`
  (C2), `triage`(D), `basecamp`(F) per this spec's re-tiering).
- Server: `cd server && npx vitest run` → **370 passed / 6 skipped** (376
  total; same env-gated `*.live.test.ts` skips as prior tiers — gitlab,
  jira, asana, azure-boards, clickup, github). `npx tsc --noEmit` clean.
  `npm run build` clean; `server/dist/` rebuilt and committed alongside this
  record.

### Unit evidence summary

**Comment mapping fixtures per adapter + `hasComments` contract**
(`test/*.unit.test.ts`, one `commentIssue` fixture per backend):
- `github.unit.test.ts` — POSTs to `/repos/{repo}/issues/{n}/comments`.
- `gitlab.unit.test.ts` — POSTs a note to `/issues/{iid}/notes`.
- `jira.unit.test.ts` — POSTs to `/rest/api/3/issue/{key}/comment`,
  ADF-wrapped through the adapter's existing `adf()` helper (asserts the
  wrapped body shape, not just the URL).
- `azure-boards.unit.test.ts` — POSTs a work-item comment to
  `/workItems/{id}/comments` with the `api-version=7.1-preview.4` querystring.
- `asana.unit.test.ts` — POSTs a comment story to `/tasks/{gid}/stories`.
- `clickup.unit.test.ts` — POSTs to `/task/{id}/comment`.
- Each fixture asserts URL, method, request body shape, and the returned
  `{ id }` — same fixture-HTTP pattern the Tier A milestone mapping fixtures
  established.
- **`hasComments` contract** (`test/contract.ts`, `"commentIssue posts and
  is UNSUPPORTED when hasComments is false"`) — the same shared
  `trackerContract` suite run against `FakeTracker`/`CachedTracker`: posts
  and asserts a truthy id when `hasComments` is true (all six adapters this
  tier); asserts `code: "UNSUPPORTED"` rather than a silent no-op on the
  false branch (exercised structurally — no adapter currently sets it
  false — pinning the fallback contract for a future backend). Cache test
  (`test/cache.test.ts`, `"commentIssue invalidates the cache"`) confirms
  the whole-cache invalidation the spec calls for (comments can touch issue
  `updatedAt`).

**Trace store append-only / dup-refusal / verdict-gate / archive matrix**
(`test/trace-store.test.ts`, 6/6):
- `"start writes frontmatter + title; id is description-hashed"` —
  `trace-<sha256(description)[:8]>`, same hashed-content id convention
  memory cards use.
- `"duplicate open start is refused"` — starting the same description twice
  while the first session is still open throws (`PRECONDITION_FAILED`,
  "already open").
- `"append is append-only: prior bytes untouched, blocks accumulate"` — two
  `trace_log` calls; asserts the second read starts with the first read's
  exact bytes (`after2.startsWith(after1)`), not just that both blocks exist.
- `"list reports counts and both statuses"` — entry counts per kind,
  filterable by `open`/`resolved`.
- `"close without a verdict is refused; with one it archives + stamps"` —
  `closeTrace` throws (`/verdict/`) with zero verdict entries; after logging
  one, archives the file (`existsSync(archivePath)`), stamps
  `status: resolved`, and the session moves out of the open list into the
  resolved list.
- `"append to resolved or unknown trace is refused"` — logging to an
  archived session throws (`/resolved/`, immutable-once-closed); logging to
  an id that never existed throws `NOT_FOUND`.

**Handoff write-through on `trace_start`/`trace_log`**
(`src/index.ts`): both handlers call `refreshHandoff({ source: "tool", ...
})` inline, the same write-through pattern every other state-changing tool
uses (`context_set`, `issue_update`, `mem_card_create`, `ledger_append`,
…) — source-verified, same category as the Tier A0 waypoint trust-order
call-out (mechanism wiring, not independently asserted by a dedicated
continuity test this tier). `test/mcp.test.ts`'s `"trace lifecycle
round-trips against the fake tracker"` (24/24 in the file) exercises the
full `trace_start` → `trace_log` (evidence, then verdict) → `trace_list` →
`trace_close` path through the live MCP tool-call layer end to end,
confirming `issueClosed: true` on close and the session leaving the open
list.

**Banner open-traces line: byte-stability + enabled-false-first**
(`test/banner.test.ts`, 19/19 in the file):
- `"banner lists open traces and stays byte-stable"` — after `trace_start` +
  one `trace_log`, the rendered banner contains `"open traces:"`, `"issue
  GH-12"`, and `"last: hypothesis"`; a second render against the unchanged
  store is byte-identical (`Buffer`-level, carrying forward the Tier A0/B
  byte-stability guarantee into the new line).
- `"banner renders traces even with zero cards"` — the open-traces line
  surfaces on its own; it does not depend on any memory card existing.
- `"returns null when recallIndex.enabled is false, even with open traces"`
  — the recall-index kill switch wins outright: an open trace never forces
  a banner render past a disabled config, and no banner file is written.

**Suite totals:** 370 passed / 6 skipped, `tsc --noEmit` clean.

### Dogfood drill procedures (spec §5.3)

Per spec §5.3, two drills, to be run in a scratch project with cairn2
installed as a local plugin and recorded here once run, same format as the
Tier 0 dogfood drill and the Tier A0/A/B drills above.

**Trace drill — RUN 2026-07-21, see results below.**
1. Real tracker: `/cairn trace "<bug description>"` → expect `trace_start`
   creates the `cairn:bug` issue and posts mirror comment #1
   ("Investigation started: <plain summary>").
2. Loop the evidence → hypothesis → test discipline (reproduce before any
   hypothesis; an experiment that can disprove it before logging a new
   one) via `trace_log`, each entry landing in the session file.
3. Mid-investigation, `SIGKILL` the session. Start a new session in the same
   repo. Expect: `/cairn waypoint resume` (or the `SessionStart` resume
   offer) picks up the trace via the handoff written by `trace_start`/
   `trace_log`; re-reading the session file continues from the exact last
   entry with zero re-derived evidence.
4. Confirm the cause → mirror comment #2 ("Cause identified: <plain
   language>").
5. Fix lands with tests passing → log a `verdict` entry (cause + fix +
   commit sha) → `trace_close(resolution)`. Expect: the tracker issue is
   closed with the resolution as the close note (mirror touch #3), the
   session file is archived (`.cairn/trace/archive/<id>.md`), and a gotcha
   card is written (`mem_card_create`, provenance = files/commits involved,
   confidence `high`).
6. Pass condition: reading the three tracker comments back in order tells
   the whole story in plain language with zero leak-pattern hits
   (`leak-patterns.mjs` scan of the comment text); the gotcha card recalls
   in a later session with its provenance intact (spec success criteria 1,
   2, 5).

**Routing drill — RUN 2026-07-21, see results below.**
1. Rig a failing `verify` on a task in a scratch phase.
2. Run `/cairn verify` → expect: `verify.md`'s routing edit fires — the
   failure MUST open a trace with the failure itself as evidence entry #1;
   no inline patch-and-rerun happens (spec success criterion 3, the #726
   hard route).
3. Separately, rig a trivial, proven-obvious ≤3-line-fix failure → expect
   the fast lane: one motion (`trace_start` → one `evidence` → one
   `verdict` → fix → `trace_close`), both mirror comments present
   (started + resolved-as-close-note), full paper trail still recorded
   despite the single motion.
4. Pass condition: the hard-route leg never produces an improvised inline
   fix outside a trace session; the fast-lane leg produces a complete
   session (evidence + verdict, both mirror touches) in one motion, proving
   the "never improvised, but no typo-class friction" balance the spec's
   Why section calls for.

### Drill results — RUN 2026-07-21 (mechanical, real tracker) — PASS 27/27

Same harness as the Tier A/B drills: real `dist/index.js` over stdio, real
GitHub tracker (`eventually-consistent-code/cairn-drill-scratch`).
Repeatable drivers at `server/drills/drill-{trace,routing}.mjs` (run from
`server/`: `node drills/drill-<name>.mjs <projectDir> $PWD/dist/index.js`;
use a fresh scratch `<projectDir>` per run — trace ids are
description-derived, so a rerun against the same dir hits the
already-open guard by design).

**Trace drill — PASS 16/16.** `trace_start` created a real `cairn:bug`
issue and the session file; mirror comment #1 posted. Evidence →
hypothesis → test logged (reproduce-first, disprovable test); banner
surfaced the open trace and the handoff was written by the trace tools.
The client was then killed cold and a FRESH client resumed purely from
the session file: entry counts intact (1/1/1/0), last entry exactly
where the kill landed — zero re-derived evidence. `trace_close` before
any verdict was refused (`PRECONDITION_FAILED` gate held); after the
verdict entry, close commented `Resolved: <resolution>` on the issue,
closed it, and archived the session (live file gone,
`.cairn/trace/archive/<id>.md` present). A `gotcha-*` card landed with
file+commit provenance at confidence `high` and recalled in a fresh
call. Read back in order, the three tracker comments (started → cause →
resolved) tell the whole story in plain language — `leak-patterns`
scan over all comment text: zero hits (spec success criteria 1, 2, 5).

**Routing drill — PASS 11/11.** The routing edits are pinned in the verb
docs themselves (`verify.md`, `work.md`, `auto.md` route failures into
trace; `status.md` surfaces open traces). Hard-route leg: a rigged
verify failure entered a trace with the failure text as evidence entry
#1, and the patch-and-rerun exit stayed shut — close remained
verdict-gated even mid-investigation, so no improvised inline fix path
exists (spec success criterion 3, the #726 hard route). Fast-lane leg:
an off-by-one class bug went start → evidence → verdict → close in one
motion with both mirror touches present (started + resolved-as-close-
note) and a complete archived session — the "never improvised, but no
typo-class friction" balance holds.

## Tier C2 — Probe & Draft (Spike and Sketch Sessions) (2026-07-22)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **26 live, 2 reserved, 48 server
  tools** (`probe`/`draft` flip reserved → live; reserved shrinks to
  `triage` (D), `basecamp` (F) — the two remaining per this spec's
  re-tiering).
- Server: `cd server && npx vitest run` → **384 passed / 6 skipped** (390
  total; same env-gated `*.live.test.ts` skips as prior tiers — gitlab,
  jira, asana, azure-boards, clickup, github). `npx tsc --noEmit` clean.
  `npm run build` clean; `server/dist/` rebuilt and committed alongside this
  record.

### Unit evidence summary

**Session store generalization: probe/draft kinds + landscape join**
(`test/sessions-store.test.ts`, 7/7):
- `"starts, appends the probe entry kinds, lists with counts and phase"` —
  `startSession(dir, "probe", ...)` produces a `probe-<sha8>` id; the four
  probe entry kinds (`experiment`/`result`/`requirement`/`verdict`) append
  and roll up into `entryCounts`; the optional `phase` field round-trips.
- `"rejects entry kinds outside the probe vocabulary"` — logging
  `hypothesis` (a trace-only kind) against a probe session throws — the
  per-kind `z.enum` vocabulary is a hard boundary, not convention.
- `"close gate: refuses without a verdict, closes with one, archives
  immutably"` — `closeSession` throws `/verdict/` with zero verdict
  entries logged; after one, archives the file, and a further `appendSession`
  against the archived id throws `/immutable|resolved/`.
- `"resolution text is readable from the archive"` — `sessionResolution`
  returns the exact close-time resolution string off the archived file —
  the mechanism the landscape join (below) depends on.
- `"draft vocabulary and decision gate"` — draft's three kinds
  (`variant`/`decision`/`note`) enforce the `decision`-gated close (spec
  §2's per-kind table, draft row).
- `"kinds are isolated: a draft id never lists under probe"` — `listSessions`
  scoped to one kind never leaks another kind's sessions, confirming the
  three kinds share the store core without cross-contaminating state.
- `"joins all kinds, carries archived resolutions, groups phases,
  deterministic"` — `sessionLandscape` over a mixed store (one archived
  `stop`-resolution probe, one open draft, one open trace) returns
  `openByKind: { trace: 1, probe: 0, draft: 1 }`, the archived probe's
  `resolution` field intact (`"stop — SDK cannot stream"`), a `phases`
  grouping keyed by the stamped phase, kind-ordered output
  (`trace`, `probe`, `draft`), and **byte-identical JSON on a second call
  against the unchanged store** (`JSON.stringify` equality) — this is the
  direct mechanical proof spec success criterion 3 asks for (see mapping
  below).

**MCP ring: all seven new tools against the fake tracker**
(`test/mcp.test.ts`):
- `"lists the expected tools"` (registry assertion) lists all 48 tool
  names including `probe_start`/`probe_log`/`probe_close`,
  `draft_start`/`draft_log`/`draft_close`, and `session_landscape` — the
  surface the check-surface ratchet also verifies structurally.
- `"trace lifecycle round-trips against the fake tracker"` — unchanged from
  C1, still green — trace's tool behavior is bit-for-bit unaffected by the
  generalization (criterion 6).
- `"probe_start creates a cairn:spike issue and stamps the active phase"` —
  `context_set({ phase: 3 })` then `probe_start` stamps `phase: "3"` on the
  session (asserted via `listSessions` directly) and the created issue
  carries the `cairn:spike` label.
- `"probe_log enforces the probe entry vocabulary"` — an out-of-vocabulary
  kind (`hypothesis`) is rejected at the protocol layer by the input
  schema's `z.enum`, before `appendSession`'s own check ever runs.
- `"probe_close gates on verdict then closes the issue"` — close without a
  verdict is `isError`; after logging one, close comments the resolution,
  reports `issueClosed: true`, and the fake tracker's issue state flips to
  `closed`.
- `"draft tools: cairn:sketch label, decision gate"` — same shape as probe,
  `cairn:sketch` label on the created issue, close gated on a `decision`
  entry.
- `"session_landscape's openByKind reflects an open probe created via
  probe_start"` — a live probe appears in `openByKind.probe` and in the
  `sessions` array with `status: "open"` immediately after `probe_start`,
  through the actual MCP tool-call layer end to end (not just the store
  unit above).

**Banner: open sessions across kinds, kind-ordered, byte-stable**
(`test/banner.test.ts`):
- `"banner lists open sessions across kinds, kind-ordered, byte-stable"` —
  with one open trace and one open probe, the rendered banner contains
  `"open sessions:"`, a `- trace trace-<id> — … — last: hypothesis` line
  and a `- probe probe-<id> — … — issue GH-40 — … — last: experiment`
  line, trace ordered before probe, and a second render against the
  unchanged store is `Buffer`-level identical — the C1 byte-stability
  guarantee (§5) carried into the generalized, multi-kind line.
- `"banner lists open sessions and stays byte-stable"` /
  `"banner renders sessions even with zero cards"` /
  `"returns null when recallIndex.enabled is false, even with open
  sessions"` — the three C1 banner contracts, now phrased over the
  generalized "sessions" line and still holding.

**Suite totals:** 384 passed / 6 skipped, `tsc --noEmit` clean.

### Spec success criteria 1–6 mapped

1. **Cold kill mid-experiment resumes with zero re-derived work (new
   kinds).** Mechanism-verified: `probe_start`/`probe_log`/`draft_start`/
   `draft_log` each call `refreshHandoff({ source: "tool", ... })` inline in
   `src/index.ts`'s `registerSessionTools` factory — the identical
   write-through pattern C1's `trace_start`/`trace_log` use (same
   mechanism-wiring category as the C1 verification's continuity call-out,
   not independently re-asserted by a dedicated test this tier either).
   Live cold-kill + fresh-client resume with entry counts intact is the
   **probe drill**, below (PENDING).
2. **Tracker tells each session's story in plain language, zero leak-pattern
   hits.** Mechanism-verified: `*_start` creates the labeled issue and
   posts mirror comment #1 (verb-level, `probe.md`/`draft.md`); `*_close`
   comments `Resolved: <resolution>` and closes the issue
   (`mcp.test.ts`'s `probe_close`/draft-tools tests assert `issueClosed`
   and the resolution comment path). The leak-pattern scan itself needs
   real tracker prose — that assertion is the **probe drill**'s pass
   condition, below (PENDING).
3. **Frontier mode never re-proposes an archived `stop`-verdict probe,
   proven mechanically from `session_landscape` output.** **Directly
   unit-verified** — `sessions-store.test.ts`'s landscape test carries an
   archived `stop — SDK cannot stream` probe through to
   `sessionLandscape`'s output with its resolution text intact and
   `status: "resolved"`, and proves the output is byte-identical across two
   calls against an unchanged store. That is the exact mechanical, never-
   re-propose input the criterion calls for; the prompt-level "never
   re-propose" behavior itself (reading that output and excluding the
   session from proposals) is the **landscape drill**'s live end-to-end
   check, below (PENDING).
4. **`probe --wrap` / `draft --wrap` produce a working project-local skill
   with provenance.** Verb-level behavior only (`skills/cairn-trailhead/
   verbs/probe.md` §`--wrap`, `draft.md` §`--wrap`) — there is no dedicated
   server tool to unit-test; the package (`SKILL.md` + `references/` +
   provenance block) only exists once a real session runs. Covered by the
   **probe drill** and **draft drill**'s wrap steps, below (PENDING).
5. **All draft variants across sessions share one theme file, custom
   properties only.** Verb-level file convention (`draft.md` step 2: create
   `.cairn/draft/themes/default.css` only on the first session in a
   project; every variant links it). No server-side enforcement by design
   — asserting the shared link in real HTML is the **draft drill**'s pass
   condition, below (PENDING).
6. **Trace's C1 surface is bit-for-bit unaffected.** **Directly verified** —
   `server/src/trace/store.ts` is now a thin re-export binding
   `sessions/store.ts`'s core to the `trace` descriptor (confirmed by
   inspection: `startTrace`/`appendTrace`/`listTraces`/`closeTrace`/
   `lastEntryKind`/`traceId` all delegate to the generalized core with the
   same signatures); `test/trace-store.test.ts` is unmodified since before
   the generalization commit and is green in the 384-pass total above —
   that file IS the compatibility test, per spec §2.

### Dogfood drill procedures (spec §6)

Per spec §6, three drills, to be run in a scratch project with cairn2
installed as a local plugin and recorded here once run — same
`server/drills/drill-{probe,draft,landscape}.mjs` harness and format as the
Tier A/B/C1 drills above.

**Probe drill — RUN 2026-07-22, see results below.**
1. Real tracker: `/cairn probe "<question>"` → expect `probe_start` creates
   the `cairn:spike` issue and posts mirror comment #1 ("Investigation
   started: <plain summary>").
2. Loop the experiment → result → requirement → verdict discipline via
   `probe_log`, risk-ordered highest-uncertainty-first; the moment a hard
   constraint surfaces mid-loop, log a `requirement` immediately.
3. Mid-spike, `SIGKILL` the session. Start a fresh client in the same repo.
   Expect: resume purely from the session file — entry counts intact, last
   entry exactly where the kill landed, zero re-derived experiment work
   (spec success criterion 1, new kind).
4. Key-finding mirror comment #2 when the picture materially changes.
5. `probe_close(resolution: "proceed|pivot|stop — <reason>")` — archives
   the session, comments the resolution on the issue (mirror touch #3),
   and closes it.
6. Read the three tracker comments back in order: whole story in plain
   language; `leak-patterns.mjs` scan of the comment text — zero hits
   (spec success criteria 1, 2).
7. `probe --wrap` on the resolved session → expect a real
   `.claude/skills/<name>/SKILL.md` + `references/` package with
   provenance (session id, tracker issue, artifact files) (spec success
   criterion 4).

**Draft drill — RUN 2026-07-22, see results below.**
1. Real tracker: `/cairn draft "<design question>"` → expect `draft_start`
   creates the `cairn:sketch` issue and posts mirror comment #1; the FIRST
   session in the project creates `.cairn/draft/themes/default.css`
   (custom properties only).
2. Write two variants to `.cairn/draft/<id>/NNN-<name>.html`, each linking
   `../themes/default.css` — assert the link is present in both files'
   HTML (spec success criterion 5).
3. User picks a direction → `draft_log(kind: "decision")` plus a mirror
   comment ("Went with <direction> for <question>.").
4. `draft_close(resolution)` — archives the session, comments the chosen
   direction on the issue, and closes it.
5. `draft --wrap` on the resolved session → expect a
   `.claude/skills/<name>/` package whose synthesis section includes the
   actual CSS custom-property patterns used across the variants, plus the
   same provenance block as the probe drill (spec success criterion 4).
6. Pass condition: both variants demonstrably share the one theme file (no
   forked second theme file), the decision entry is present, and the wrap
   package's synthesis section references real custom properties pulled
   from `default.css`, not placeholder text.

**Landscape drill — RUN 2026-07-22, see results below.**
1. Run a probe session to a `stop` resolution against the real tracker and
   archive it via `probe_close`.
2. Call `session_landscape` → expect the archived probe to appear with
   `status: "resolved"` and the full resolution text intact (the
   never-re-propose input frontier mode depends on), grouped under its
   phase when one is stamped.
3. Call `session_landscape` again with no store mutation between calls →
   expect byte-equal JSON output (kind-then-id ordering) — the live
   confirmation of the unit-level proof in criterion 3's mapping above.
4. Separately, run `/cairn probe` (no arg, frontier mode) against a project
   containing that archived `stop`-verdict session → expect the proposal
   list to surface it as "already probed — stop" and never include it as a
   candidate.
5. Pass condition: both `session_landscape` calls are byte-identical, the
   resolution text survives the archive round-trip unmodified, and the
   frontier-mode proposal list mechanically excludes the settled `stop`
   session (spec success criterion 3, end to end).

### Drill results — RUN 2026-07-22 (mechanical, real tracker) — PASS 27/27

Same harness as the Tier A/B/C1 drills: real `dist/index.js` over stdio,
real GitHub tracker (`eventually-consistent-code/cairn-drill-scratch`).
Repeatable drivers at `server/drills/drill-{probe,draft,landscape}.mjs`
(run from `server/`: `node drills/drill-<name>.mjs <projectDir>
$PWD/dist/index.js`; fresh scratch `<projectDir>` per run — session ids are
description-derived, so a rerun against the same dir hits the already-open
guard by design; probe and draft drills can share one scratch dir,
landscape builds on their leftovers cleanly since it stages its own
sessions).

**Probe drill — PASS 12/12.** `probe_start` created a real `cairn:spike`
issue; mirror comment #1 posted. Full spike loop logged riskiest-first:
experiment (throwaway `stream-poc.mjs` in the artifact dir) → result
(investigation trail with a surprise, never verdict-only) → requirement
(captured as a non-negotiable for the real build). Client cold-killed
mid-spike; a FRESH client resumed purely from the session file — counts
intact (1/1/1/0), last entry exactly where the kill landed, zero
re-derived results. Close before any verdict was refused (gate held);
after `VALIDATED` verdict, close resolved `proceed — …`, commented the
resolution, closed the issue, archived the session. Wrap mechanics
produced a real `.claude/skills/streaming-export/SKILL.md` with
provenance (session id + tracker issue + artifact files). The three
tracker comments read back in order (started → key finding → resolved)
in plain language; `leak-patterns` scan over all comment text: zero hits
(spec success criteria 1, 2, 4).

**Draft drill — PASS 9/9.** `draft_start` created a real `cairn:sketch`
issue. First-session theme landed at `.cairn/draft/themes/default.css`
and passed the custom-properties-only check (no selectors beyond
`:root`, no layout rules). Two variants (`001-cards.html`,
`002-table.html`) each assert the `../themes/default.css` link in their
HTML — one design question, structure the only difference. Close before
any decision was refused (gate held); after the decision entry, close
resolved and archived. Wrap synthesis produced
`references/css-patterns.md` carrying the theme's custom properties and
full provenance (spec success criteria 4, 5).

**Landscape drill — PASS 6/6.** A probe started under active phase 2 was
closed with a `stop — …` resolution; `session_landscape` then carried
that archived session WITH its resolution text — the exact input
frontier mode needs to never re-propose it — grouped it under phase 2,
counted the one open draft (and zero open probes) in `openByKind`, and
returned byte-equal output across two calls against the unchanged store
(spec success criterion 3).

## Tier C3 — Audits & Review Governance (2026-07-22)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **28 live, 2 reserved, 50 server
  tools** (`audit`/`review` flip reserved → live; reserved shrinks to
  `triage`(D), `basecamp`(F) — the two remaining per this spec's
  re-tiering).
- Server: `cd server && npx vitest run` → **398 passed / 6 skipped** (404
  total; same env-gated `*.live.test.ts` skips as prior tiers — gitlab,
  jira, asana, azure-boards, clickup, github). `npx tsc --noEmit` clean.
  `npm run build` clean; `server/dist/` already matched the rebuilt output
  — nothing dirtied, nothing to commit this tier.

### Unit evidence summary

**`plan_check` — contract drift + unanchored thresholds (#2891)**
(`test/plan-check.test.ts`, 8/8):
- `"flags a consumer whose contract text differs from the producer, naming
  both ends"` — a `Produces: exportRows(filter: Filter): Stream` in one
  plan and a `Consumes: exportRows(filter: Filter, limit: number): Stream`
  in another produce exactly one `contract-drift` finding on the
  consumer's plan+line, with `counterpart` pointing at the producer's
  plan+line (spec success criterion 1).
- `"is silent when both plans reference a shared fixture"` — the same
  drifted pair produces zero findings once both plans cite the identical
  path-like fixture token (`test/fixtures/export-contract.json`) — the
  shared-fixture escape hatch spec §2 calls for.
- `"is silent when contract texts match after whitespace normalization"` —
  reformatted whitespace alone (`Consumes:   \`run(x: number): void\``) is
  not drift.
- `"flags a bare threshold and stays silent on an anchored one"` — `<
  100ms` with no anchor on its line is an `unanchored-threshold` finding
  at line 1 with the matched text; `>= 500 rps` anchored by "per benchmark
  results in perf/baseline.json" on the next line is silent (spec success
  criterion 2).
- `"phase filter narrows the scan and output is byte-stable"` —
  `planCheck(dir, 1)` scans only the `01-*` phase directory (`scanned:
  1`); two full-project calls against the unchanged tree are
  `JSON.stringify`-equal.
- `"empty project: zero findings, zero scanned"` — no
  `.cairn/plans/phases` directory at all is a clean `{ findings: [],
  scanned: 0 }`, not an error.
- `"adjacent independent thresholds do not anchor each other"` — two
  separate threshold statements on adjacent lines, only one carrying its
  own anchor, flag only the unanchored one — a neighbor's anchor doesn't
  leak onto an unrelated requirement.
- `"multi-producer drift onto one consumer is deterministically ordered"` —
  one consumer plan drifting against two different producer plans yields
  two findings, both on the consumer, tie-broken by `counterpart.plan` in
  sorted order; a second call against the unchanged tree is byte-equal —
  the explicit tie-break spec §2's "deterministic ordering" clause
  requires.

**`audit_record` — single-writer scope-date files**
(`test/audit-record.test.ts`, 4/4):
- `"writes scope-date file with frontmatter and finding blocks"` —
  `writeAuditRecord` lands `.cairn/audit/uat-phase-1-<today>.md` with
  `scope:`/`verdict: findings` frontmatter and one `## finding —
  <severity>` block per finding, an `issue:` line present when a finding
  carries one.
- `"same scope+date overwrites; a different date is never touched"` — a
  second same-day run on the same scope replaces the file's contents (no
  stale `verdict: pass` left behind); a differently-dated file for the
  same scope is untouched byte-for-byte (spec success criterion 5).
- `"rejects an empty scope and a verdict/findings mismatch"` — an empty
  scope throws `/scope/`; a `pass` verdict carrying a finding throws
  `/verdict/` — the two guard rails spec §3 states in prose are
  load-bearing, not advisory.
- `"listAuditRecords returns scope/date/verdict sorted by path"` — the
  list read surface returns scope and verdict fields, sorted by path — the
  read-back a future audit-history tool would use.

**MCP ring: both new tools registered and reachable** (`test/mcp.test.ts`):
- `"lists the expected tools"` (registry assertion) lists all 50 tool
  names including `plan_check` and `audit_record` — the same structural
  list `check-surface.mjs` verifies against `server/src/index.ts`.
- `"plan_check runs clean on an empty project"` — calling the tool (not
  the bare function) on a project with no plans returns `{ findings: [],
  scanned: 0 }` through the actual MCP tool-call layer.
- `"audit_record writes and validates"` — a `findings`-verdict call with
  one `important` finding returns `{ path, findings: 1 }`; a
  `pass`-verdict call carrying a `critical` finding comes back `isError:
  true` — the same guard rail proven at the unit layer above, now proven
  through the protocol layer.

**Suite totals:** 398 passed / 6 skipped, `tsc --noEmit` clean.

### Spec success criteria 1–6 mapped

1. **A drifted producer/consumer contract across two plans in a phase is
   detected mechanically with both endpoints named; adding the shared
   fixture reference silences it (#2891 leg one).** Directly
   unit-verified — `plan-check.test.ts`'s `"flags a consumer whose
   contract text differs..."` and `"is silent when both plans reference a
   shared fixture"` above.
2. **An unanchored quantitative threshold in a plan warns; anchoring it to
   a named source silences it (#2891 leg two).** Directly unit-verified —
   `"flags a bare threshold and stays silent on an anchored one"` above.
3. **Every Critical/Important audit/review finding is visible on the
   tracker as a labeled issue in plain language, leak-clean; Minors stay
   in the record file.** Verb-level behavior only (`verbs/audit.md`
   §"Closing discipline", `verbs/review.md` §"Closing discipline") —
   `issue_create` with label `cairn:audit`/`cairn:review` and the
   severity-first-line body rule are prompt-layer contracts riding the
   `issue_create`/`audit_record` tools proven above; there is no dedicated
   server tool that itself decides severity routing. The leak-pattern scan
   against real tracker prose is the **audit drill**'s and **review
   drill**'s pass condition, below (PENDING).
4. **`--fix` closes mechanical findings with commits + close notes;
   investigation-shaped findings open traces — zero improvised inline
   fixes (#726 held).** Verb-level (`audit.md`/`review.md` §`--fix`) — the
   mechanical/investigation-shaped split and the "never an improvised
   inline fix" rule are prompt discipline mirroring #726's established
   trace routing (C1); the mechanics themselves (`issue_comment` →
   `issue_close` for mechanical, `trace_start` for investigation-shaped)
   reuse tools already unit-proven in Tier A/C1. Live proof of the split
   holding is the **audit drill**'s `--fix` step, below (PENDING).
5. **Audit records are reproducible history: same-day re-run supersedes,
   prior dates immutable.** Directly unit-verified —
   `audit-record.test.ts`'s `"same scope+date overwrites; a different date
   is never touched"` above.
6. **C1/C2 surfaces bit-for-bit unaffected (sessions store, trace/probe/
   draft tools, banner) — their test files pass unedited.** Directly
   verified — `test/trace-store.test.ts`, `test/sessions-store.test.ts`,
   and `test/banner.test.ts` are untouched by this tier's commits
   (confirmed by `git diff --stat` against the pre-tier commit: zero lines
   changed in any of the three files) and all three are green in the
   398-pass total above.

### Dogfood drill procedures (spec §5)

Per spec §5, three drills, to be run in a scratch project with cairn2
installed as a local plugin and recorded here once run — same
`server/drills/drill-{plan-check,audit,review}.mjs` harness and format as
the Tier A/B/C1/C2 drills above.

**Plan-check drill — RUN 2026-07-22, see results below.**
1. Seed a scratch phase with one drifted producer/consumer pair and one
   unanchored threshold → `plan_check` returns exactly two findings, with
   correct lines and `counterpart` (spec success criteria 1, 2).
2. Add the shared fixture reference and an anchor for the threshold →
   `plan_check` returns zero findings.
3. Two calls against the unchanged (fixed) tree are byte-equal.

**Audit drill — RUN 2026-07-22, see results below.**
1. Run an audit mode against a seeded target with two Critical/Important-
   shaped findings and one Minor; confirm the audit run writes the
   `audit_record` file.
2. Confirm both Critical/Important findings mirror as real `cairn:audit`
   tracker issues — severity as the literal first line, `leak-
   patterns.mjs` scan of the issue bodies zero hits — and the Minor stays
   in the record only.
3. `--fix` mechanics close one finding with a commit + a plain-language
   close note; the investigation-shaped finding opens a real `trace`
   instead of an inline fix (#726 leg).
4. Re-run the same audit the same day → confirm the record supersedes
   itself (criteria 3, 4, 5).

**Review drill — RUN 2026-07-22, see results below.**
1. Seed a diff review with one Critical/Important-shaped finding and one
   Minor.
2. Run the review → confirm it mirrors one `cairn:review` issue (severity
   first line, plain language) plus an `audit_record(scope:
   "review-<target>")` record carrying both findings, the Minor only in
   the record.
3. Close-note discipline on `--fix`; `leak-patterns.mjs` scan over the
   issue body and close note: zero hits (criterion 3).

### Drill results — RUN 2026-07-22 (mechanical, real tracker) — PASS 26/26

Same harness as every prior tier: real `dist/index.js` over stdio, real
GitHub tracker (`eventually-consistent-code/cairn-drill-scratch`) where a
tracker is touched (plan-check needs none). Repeatable drivers at
`server/drills/drill-{plan-check,audit,review}.mjs` (run from `server/`:
`node drills/drill-<name>.mjs <projectDir> $PWD/dist/index.js`; fresh
scratch `<projectDir>` per run — the three C3 drills can share one).

**Plan-check drill — PASS 8/8.** Seeded phase pair: one drifted
producer/consumer contract (`exportRows` signature mismatch) + one bare
`< 100ms` threshold → exactly two findings, drift landing on the consumer
line with the producer as counterpart, threshold with the matched text and
correct line; two calls byte-equal. Adding the shared fixture reference to
both plans and anchoring the threshold to `perf/baseline.json` → zero
findings. Phase filter narrowed the scan to one plan (spec success
criteria 1, 2 — both #2891 legs held).

**Audit drill — PASS 10/10.** Two findings mirrored as real `cairn:audit`
issues, severity as the body's first line, plain language; the record
landed with three findings (the minor stayed record-only, issue ids
linked). `--fix` mechanics: the mechanical finding closed with a
plain-language note; the investigation-shaped finding opened a REAL trace
on the finding's own issue — no inline fix path existed (#726 leg held),
and the trace surfaced in `session_landscape`. A same-day re-run
superseded the record (prior content gone, new content in). Leak scan
over every byte sent to the tracker: zero hits (spec success criteria
3, 4, 5).

**Review drill — PASS 8/8.** A slash-y branch target (`feature/EXPORT-42`)
slugged clean through `audit_record`'s scope gate. The Critical finding
mirrored as a `cairn:review` issue (severity first line); the record —
not the issue — carried the `file:line` + failure scenario, and the minor
stayed record-only (audience split held). `--fix` closed the finding with
a plain-language note; leak scan zero hits (spec success criterion 3).

## Tier D — Triage (2026-07-22)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **29 live, 1 reserved, 50
  server tools** (`triage` flips reserved → live; reserved shrinks to
  `basecamp`(F) alone — the last verb left per the parity roadmap).
  `SPEC_RESERVED` in `scripts/check-surface.mjs` drops `triage`;
  `TOOL_PREFIXES` unchanged (no new tool namespace).
- Server: `cd server && npx vitest run` → **398 passed / 6 skipped** (404
  total; same env-gated `*.live.test.ts` skips as every prior tier —
  gitlab, jira, asana, azure-boards, clickup, github). `npx tsc --noEmit`
  clean. Identical totals to the Tier C3 record above — expected, since
  this tier adds zero server tools and edits zero server files (see
  "Server untouched" below).

### Suite totals
No new unit ring this tier — the spec is explicit that Tier D is
zero-server-work ("P1's adapters already carry everything triage needs");
there is no `test/triage.test.ts` because there is no new server code to
unit-test. The verb rides tools already proven in prior tiers:
`issue_list`/`issue_update`/`issue_comment`/`issue_close` (P1),
`session_landscape` (C2), `audit_record` (C3). **Suite totals:** 398
passed / 6 skipped, `tsc --noEmit` clean — unchanged from Tier C3.

### Server untouched
Evidence command: `git diff --stat main -- server/` → **empty output,
zero lines**. This tier's code diff against `main` (excluding this
verification-record commit) is three files, none under `server/`:

```
 scripts/check-surface.mjs              |  2 +-
 skills/cairn-trailhead/SKILL.md        |  2 +-
 skills/cairn-trailhead/verbs/triage.md | 90 ++++++++++++++++++++++++++++++++++
 3 files changed, 92 insertions(+), 2 deletions(-)
```

`check-surface.mjs` drops `triage` from `SPEC_RESERVED`; `SKILL.md` flips
the routing table's `triage` row from `reserved-D` to `live` and fills in
its args/status; `verbs/triage.md` is the new subroutine file. No file
under `server/` appears in the diff — confirmed directly, not inferred
from an unchanged test count.

### Spec success criteria 1–6 mapped

1. **A resolved-but-open cairn artifact is detected via its trace/record
   evidence and — only under `--apply` — closed with the evidence quoted
   in plain language.** Verb-level contract (`verbs/triage.md` §"The
   sweep" resolved-but-open row + §"`--apply`" table) riding
   `session_landscape` (C2, unit-proven) and `.cairn/audit/` record reads
   (C3, unit-proven) for evidence, and `issue_comment`/`issue_close` (P1,
   unit-proven) for the mechanics. No dedicated server tool decides this
   — it's prompt-layer classification over already-proven reads. Live
   proof is the **triage drill**'s apply leg, below (PENDING).
2. **Duplicates are cross-linked, never closed.** Verb-level
   (`verbs/triage.md` §"`--apply`" possible-duplicate row +
   "Never-rules"): cross-linking `issue_comment` on both issues, no
   `issue_close` call in that branch, full stop. Live proof is the
   **triage drill**'s duplicate leg, below (PENDING).
3. **Report-only default: a bare `triage` run mutates nothing on the
   tracker and still writes the record.** Verb-level (`verbs/triage.md`
   §"Bare vs. `--apply`") — `issue_list` (a read) is the only TRACKER
   call without `--apply`; `session_landscape` reads locally and
   `audit_record` (C3, unit-proven) still writes the report.
   Live proof is the **triage drill**'s report leg, below (PENDING).
4. **Labels added under `--apply` come only from the project's existing
   label set.** Verb-level (`verbs/triage.md` §"`--apply`" unlabeled row +
   "Never-rules": "Labels come only from the vocabulary already in use").
   The vocabulary read is `issue_list` (P1, unit-proven); no new label
   name is ever synthesized. Live proof is the **triage drill**'s
   unlabeled leg, below (PENDING).
5. **Leak scan zero hits on every comment; same-day re-run supersedes the
   record.** Leak-pattern scanning (`leak-patterns.mjs`, unit-proven in
   `test/leak-patterns.test.ts`) and same-day supersession
   (`audit_record`, unit-proven in `test/audit-record.test.ts`'s "same
   scope+date overwrites" case) are both reused mechanisms, not new code.
   Live proof over real tracker prose is the **triage drill**'s leak-scan
   and re-run legs, below (PENDING).
6. **Server surface untouched: 50 tools, all server test files
   unedited.** Directly verified — `git diff --stat main -- server/`
   above is empty (zero files, zero lines) and `check-surface.mjs`
   confirms 50 server tools, unchanged. This criterion **is** the
   "Server untouched" evidence above, not a separate check.

### Dogfood drill procedure (spec §3)

**Triage drill — RUN 2026-07-22, see results below.** Per spec §3, one drill,
to be run in a scratch project with cairn2 installed as a local plugin
and recorded here once run — same `server/drills/drill-{name}.mjs`
harness and format as every prior tier's drills (real `dist/index.js`
over stdio, real GitHub tracker). No `server/drills/drill-triage.mjs`
exists yet; it is authored post-merge per this tier's convention (see
bottom of this file).

1. **Stage** on the scratch tracker: one unlabeled issue, one bodiless
   issue, one `cairn:bug` issue whose trace is archived-resolved, and a
   near-duplicate pair (two open issues with near-match titles).
2. **Report leg** — run bare `triage` (the tool-call sequence
   `triage.md` prescribes): confirm the record is written with one
   `important` finding (the resolved-but-open issue) and the remaining
   findings `minor`, every finding's `issue:` field linking a real issue
   id, and zero mutations on the tracker (no comment, no label, no close
   — `issue_list` is the only tracker call that ran; landscape and record
   reads/writes are local).
3. **Apply leg** — re-run with `--apply`: confirm the unlabeled issue
   gets a label pulled from the project's existing label set (never an
   invented name); the resolved-but-open issue is closed, but only after
   an `issue_comment` quoting the evidence (trace id / record scope +
   resolution text) lands first; both near-duplicate issues get a
   cross-linking comment and **both remain open** (neither is closed);
   the bodiless issue is untouched (report-only, confirmed by its body
   still empty and no comment posted).
4. **Leak scan** — `leak-patterns.mjs` over every comment body written in
   step 3: zero hits.
5. **Same-day supersede** — re-run `triage` again the same day: confirm
   the record file's content is replaced (not appended), same semantics
   as `audit`/`review`'s same-day supersession.

### Drill results — RUN 2026-07-22 (mechanical, real tracker) — PASS 13/13

Same harness as every prior tier: real `dist/index.js` over stdio, real
GitHub tracker (`eventually-consistent-code/cairn-drill-scratch`).
Repeatable driver at `server/drills/drill-triage.mjs` (run from `server/`:
`node drills/drill-triage.mjs <projectDir> $PWD/dist/index.js`; fresh
scratch `<projectDir>` per run).

**Triage drill — PASS 13/13.** Staged the rot: an unlabeled issue, a
bodiless one, a near-duplicate pair, and the real thing for
resolved-but-open — a `cairn:bug` issue whose trace ran to a verdict,
closed it with a resolution, and was then reopened out-of-band. Report
leg: `session_landscape` carried the trace's resolution (the evidence),
the record landed with 1 important + 4 minors all linked to real issue
ids, and NOTHING on the tracker moved (bug still open, unlabeled still
bare). Apply leg: the unlabeled issue got a label drawn only from the
project's existing vocabulary; the resolved-but-open issue closed with
the trace id and resolution text quoted in the close comment; the
duplicate pair got cross-linking comments and BOTH stayed open; the
bodiless issue was untouched. Same-day re-run superseded the record;
leak scan over every comment sent: zero hits (spec success criteria
1-5 all held).

**Harness note (drill mechanics, not product):** GitHub's issue-list
endpoint is read-after-write inconsistent — issues created seconds
earlier can be absent from a list call. Real triage sweeps an aged
tracker, so `issue_list` is the right sweep tool in production; the
drill pins its classification on per-id `issue_get` (read-after-write
consistent) and separately asserts `issue_list` answers. Noted in the
driver's header comment.

## Tier E — Knowledge & Diagnostics (2026-07-22)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **34 live, 1 reserved, 55
  server tools** (`map`, `thread`, `profile`, `medic`, `backtrack` flip
  reserved → live; reserved shrinks to `basecamp`(F) alone). `TOOL_PREFIXES`
  gains `map|thread` per this spec's §1.
- Server: `cd server && npx vitest run` → **416 passed / 6 skipped** (422
  total; same env-gated `*.live.test.ts` skips as every prior tier —
  gitlab, jira, asana, azure-boards, clickup, github). `npx tsc --noEmit`
  clean. `npm run build` clean; `server/dist/` already matched the rebuilt
  output — nothing dirtied, nothing to commit this tier.

### Unit evidence summary

**Map store — merge semantics, dangling-edge rejection, deterministic
filtered reads** (`test/map-store.test.ts`, 13/13):
- `describe("mapSet")`: `"merges new nodes and edges into an empty store"`;
  `"merges an existing node's fields and null deletes an unattached node"`
  — the `config_set` null-delete convention, now on graph nodes;
  `"rejects deleting a node that still has an edge attached, naming the
  edge"` — the edge-attached delete guard spec §3 calls for;
  `"replaces the edges list wholesale rather than merging it"` — the
  documented "no stable edge identity" contract; `"rejects an edge whose
  endpoint is missing from the post-merge node set, naming the id"` — the
  dangling-edge rejection spec success criterion 2 requires;
  `"rejects an invalid node type"` / `"rejects an invalid edge type"` —
  the enum validation gate; `"writes atomically -- no leftover .tmp file
  after a successful write"` — the `.tmp` + rename contract.
- `describe("mapGet")`: `"returns an empty store when no map file exists
  yet"` — missing store reads as `{ nodes: {}, edges: [] }`, never an
  error; `"sorts nodes by id and edges by (from, to, type)
  deterministically"` — the byte-stable-read half of spec success
  criterion 2; `"filters by nodeType"` / `"filters by edgeType"` /
  `"filters by node, returning self, touching edges, and neighbor nodes"`
  — the three filter shapes spec §3 defines.

**Sessions store: the `thread` kind** (`test/sessions-store.test.ts`,
`describe("sessions store — thread kind")`, 2 new tests; existing
`trace`/`probe`/`draft` describe blocks in this file are untouched):
- `"thread vocabulary, wrap gate, archive"` — `startSession(dir, "thread",
  ...)` produces a `thread-<sha8>` id; all four thread entry kinds
  (`note`/`link`/`decision`/`wrap`) append; an out-of-vocabulary kind
  (`evidence`) is rejected; `closeSession` throws `/wrap/` before a `wrap`
  entry is logged and succeeds after, returning the wrap entry's text as
  `gateTexts`; the optional `phase` field round-trips.
- `"landscape includes threads last in kind order"` —
  `sessionLandscape`'s `sessions` array orders `["trace", "thread"]`
  (trace before thread, matching the four-kind order: trace, probe, draft,
  thread) and `openByKind` carries a `thread` key.
- One pre-existing assertion in this file's `sessionLandscape` describe
  block was widened, not changed: `"joins all kinds, carries archived
  resolutions, groups phases, deterministic"`'s `openByKind` expectation
  grew from `{ trace: 1, probe: 0, draft: 1 }` to `{ trace: 1, probe: 0,
  draft: 1, thread: 0 }` — recognizing the new kind exists in the
  enumeration, not a behavior change to trace/probe/draft's own counts
  (confirmed: `git diff main -- test/sessions-store.test.ts` shows exactly
  one changed line, zero other deletions).

**Banner: open thread line, ordered after the other three kinds**
(`test/banner.test.ts`, 21/21 in the file, zero deletions in this tier's
diff):
- `"banner lists an open thread after the other kinds"` — with one open
  probe and one open thread, the rendered banner contains a
  `- thread thread-<id> — … — last: note` line, and the probe line's text
  index is less than the thread line's — kind ordering (trace, probe,
  draft, thread) holds in the rendered banner, not just in
  `session_landscape`'s JSON.

**MCP ring: thread and map tools registered and reachable**
(`test/mcp.test.ts`, 33/33 in the file):
- `"lists the expected tools"` (registry assertion) — the 55-name list now
  includes `thread_start`/`thread_log`/`thread_close` and
  `map_set`/`map_get`, the same structural list `check-surface.mjs`
  verifies against `server/src/index.ts`.
- `"thread tools: cairn:thread label, wrap gate"` — `thread_start` creates
  a `cairn:thread`-labeled issue; `thread_close` before a `wrap` entry is
  logged returns `isError: true`; after logging one, close returns
  `issueClosed: true`.
- `"map tools: round-trips a two-node one-edge graph and rejects a
  dangling edge"` — `map_set` with two nodes and one edge returns `{
  nodes: 2, edges: 1 }`; `map_get({})` reads back the exact node and edge
  shapes; a follow-up `map_set` patch naming a nonexistent edge endpoint
  (`mod-ghost`) returns `isError: true` — through the actual MCP tool-call
  layer, not just the bare function tested above.
- One pre-existing assertion was widened, not changed:
  `"session_landscape's openByKind reflects an open probe created via
  probe_start"`'s key-list expectation grew from `["draft", "probe",
  "trace"]` to `["draft", "probe", "thread", "trace"]` — same
  enumeration-recognizes-the-new-kind shape as the sessions-store change
  above, confirmed by `git diff main -- test/mcp.test.ts` (one changed
  line in this test, plus the new tool names in the registry-list array
  and the two new `it()` blocks above — no other existing assertion
  touched).

**Suite totals:** 416 passed / 6 skipped, `tsc --noEmit` clean.

### Spec success criteria 1–6 mapped

1. **A thread survives cold kill and resumes by name with zero re-derived
   context; close requires a wrap entry; the `cairn:thread` issue tells
   the story (started → wrapped) in plain language, leak-clean.**
   Mechanism-verified: `thread_start`/`thread_log` call
   `refreshHandoff({ source: "tool" })` inline in `src/index.ts`'s
   `registerSessionTools` factory — the identical write-through pattern
   trace/probe/draft use (same mechanism-wiring category as every prior
   tier's continuity call-out). The wrap gate itself is directly
   unit-verified (`sessions-store.test.ts`'s `"thread vocabulary, wrap
   gate, archive"` above; `mcp.test.ts`'s `"thread tools: cairn:thread
   label, wrap gate"` above, through the protocol layer). Live cold-kill +
   fresh-client resume by name, with the two-touch mirror story (started →
   wrapped) read back leak-clean, is the **thread drill**'s pass
   condition, below (PENDING).
2. **The map store rejects dangling edges, merges deterministically, and
   answers filtered queries byte-stably; `map diff` names real drift.**
   Directly unit-verified for the store half — `map-store.test.ts`'s
   dangling-edge, null-delete, edges-replace-wholesale, and
   deterministic-sort/filter cases above, plus `mcp.test.ts`'s map round
   trip through the protocol layer. `map diff` itself is verb-level
   (`verbs/map.md` §`map diff`) — there is no dedicated server tool for
   comparing a rebuilt-in-memory graph against the stored one; live proof
   that it names real drift by name is the **map drill**'s pass condition,
   below (PENDING).
3. **`medic` findings land as a record; `--repair` fixes only mechanical
   structure and lists what it refused to touch.** Verb-level only
   (`verbs/medic.md`) — `medic` is prompt-level orchestration over tools
   already proven in prior tiers (`plan_status`, `plan_drift`,
   `plan_check` from C3, `audit_record` from C3 for the findings record,
   `plan_phase_ensure`/`plan_scaffold_phase`/`plan_issues_set` for
   `--repair`'s mechanical fixes). No dedicated server tool decides
   health/repair classification, and spec §5's drill list carries no
   `drill-medic.mjs` — this criterion is verified by review of the verb
   doc against the spec's health/repair/forensics split, not by a
   mechanical drill.
4. **`backtrack` computes the exact ledgered revert set, flags overlapping
   later commits file-by-file, and `--apply` leaves original shas intact
   (reverts only, suite green).** Verb-level (`verbs/backtrack.md`) — the
   revert-set computation reads `LEDGER.md` commit ranges + `git log`
   (both already-proven read paths, `plan_resync`'s Tier A coverage
   exercises the same `LEDGER.md`-range-vs-`git log` cross-check
   machinery); `--apply` runs `git revert` only, never `reset --hard` or a
   force-push, per the verb's "never destructive by default" contract.
   Live proof that the computed set matches a seeded manifest, the overlap
   is flagged file-by-file, and the apply leg reverts cleanly with
   original shas intact is the **backtrack drill**'s pass condition,
   below (PENDING).
5. **`status --stats` renders from live tool reads — no cached numbers.**
   Verb-level (`verbs/status.md` §`--stats`) — every source it folds in is
   an existing, already-proven read: `plan_status` (A), `issue_list` (P1),
   `mem_stats` (P2), `session_landscape` (C2), and `listAuditRecords`
   (`src/audit/record.ts`, C3, backing the `.cairn/audit/` records-dir
   count). Zero new server code, so nothing new to unit-test — the "live
   reads only, never cached" contract is a prompt-layer promise riding
   tools that were already read-only and already unit-proven not to
   memoize. Verified by review of the verb doc against spec §1's "zero
   surface growth" call; no dedicated drill in spec §5 for this criterion
   (bare `status`'s existing behavior is unaffected — `--stats` is
   additive).
6. **C1–D surfaces bit-for-bit unaffected: trace/probe/draft store tests,
   banner three-kind bytes, and all 50 existing tools unchanged
   (trace-store/sessions-store pre-thread cases/banner C2 cases pass
   unedited).** Directly verified with one honest caveat: `test/trace-
   store.test.ts` is completely untouched (`git diff main --
   test/trace-store.test.ts` — empty) and green in the 416-pass total.
   `test/sessions-store.test.ts` and `test/mcp.test.ts` each have exactly
   one pre-existing line touched — an enumeration assertion
   (`openByKind`'s key set, the tool-name registry list) widened to
   include the new `thread` kind/tools — not a change to any trace/probe/
   draft *behavior*; every other line in both files' pre-Tier-E test
   cases is byte-identical (confirmed by `git diff`, not inferred).
   `test/banner.test.ts` carries zero deletions — its Tier C1/C2 cases are
   pure byte-for-bit unedited. All 50 pre-Tier-E tools are unchanged in
   the registry (`check-surface.mjs`'s 55-count is 50 + the 5 new
   `thread_start`/`thread_log`/`thread_close`/`map_set`/`map_get`).

### Dogfood drill procedures (spec §5)

Per spec §5, three drills, to be run in a scratch project with cairn2
installed as a local plugin and recorded here once run — same
`server/drills/drill-{thread,map,backtrack}.mjs` harness and format as
every prior tier's drills (real `dist/index.js` over stdio, real GitHub
tracker where a tracker is touched). No `server/drills/drill-{thread,map,
backtrack}.mjs` exist yet; authored post-merge per this tier's convention
(see bottom of this file).

**Thread drill — RUN 2026-07-22, see results below.**
1. Real tracker: `/cairn thread "<name>"` → expect `thread_start` creates
   the `cairn:thread` issue and posts mirror comment #1 ("Thread started:
   <plain summary>").
2. Log at least one entry of each kind (`note`, `link`, `decision`) via
   `thread_log` as work happens — a `link` entry carries a reference plus
   one line of why it matters.
3. Mid-thread, `SIGKILL` the session. Start a fresh client in the same
   repo. Expect: resume purely from the session file by re-reading
   `.cairn/thread/<id>.md` — entry counts intact, last entry exactly where
   the kill landed, zero re-derived context (spec success criterion 1).
4. Re-run `/cairn thread "<name>"` against the still-open session → expect
   the already-open guard fires and resumes (no duplicate issue, no
   mirror comment on resume — the tracker already knows this thread is
   open).
5. `thread_close` before any `wrap` entry is logged → expect refusal
   (wrap gate held). Log a `wrap` entry, then close → expect the tracker
   issue comments "Resolved: <resolution>" and closes (mirror touch #2 —
   two touches only, start and wrap).
6. Pass condition: reading the two tracker comments back in order (started
   → resolved) tells the whole story in plain language with zero
   leak-pattern hits (`leak-patterns.mjs` scan); the session file, once
   archived, is immutable (a further `thread_log` throws) (spec success
   criterion 1).

**Map drill — RUN 2026-07-22, see results below.**
1. Server only, no tracker: `map build`-equivalent — issue a sequence of
   `map_set` patches building a small graph (a few `module`/`phase`/
   `issue`/`decision` nodes, `depends-on`/`implements` edges).
2. Issue a patch with an edge naming a nonexistent endpoint → expect
   `PRECONDITION_FAILED` naming the missing id; the store is left
   unchanged (re-read confirms the rejected patch never landed).
3. Null-delete a node with no edges attached → expect it gone; attempt to
   delete a node that still has an edge attached → expect
   `PRECONDITION_FAILED` naming the edge.
4. Issue a second patch carrying a smaller `edges` array → expect the
   edge list REPLACED wholesale (old edges not carried over), per the
   documented "no stable edge identity" contract.
5. `map_get` with each filter shape (`nodeType`, `edgeType`, `node`) →
   expect the three documented shapes; two `map_get({})` calls against the
   unchanged store are byte-equal JSON.
6. Pass condition: dangling-edge rejection, deterministic merge, and
   byte-stable filtered reads all hold against the real (not
   fake-tracker) `dist/index.js` process — spec success criterion 2's
   store half. The `map diff`-names-real-drift half of criterion 2 is
   verb-level and reviewed against the verb doc rather than mechanically
   drilled (no server tool decides "drift"; `map diff` is `map_get()`
   compared to a fresh in-memory walk).

**Backtrack drill — RUN 2026-07-22, see results below.**
1. Local scratch git repo: seed a phase with `LEDGER.md`-recorded commit
   ranges (a handful of real commits), plus one LATER commit that touches
   a file also touched inside the ledgered range (the overlap case).
2. Run `backtrack <phase>` (report-only, no `--apply`) → expect the
   computed revert set matches exactly the ledgered commit range, and the
   overlapping later commit is flagged file-by-file (named, not just
   counted) as needing manual review before `--apply` would touch it.
3. `--apply` → expect `git revert` (no-edit, reverse order) only — never
   `reset --hard`, never a force-push, never a commit outside the
   manifest; the test suite runs and is reported green.
4. Confirm no history rewrite: `git log` after `--apply` shows new revert
   commits on top; the original ledgered shas are still present and
   unchanged (`git cat-file -e <sha>` on each).
5. Pass condition: the exact ledgered revert set, the file-by-file overlap
   flag, and the reverts-only/original-shas-intact/suite-green apply leg
   all hold mechanically (spec success criterion 4).

### Drill results — RUN 2026-07-22 (mechanical) — PASS 28/28

Same harness as every prior tier: real `dist/index.js` over stdio; the
thread drill uses the real GitHub tracker
(`eventually-consistent-code/cairn-drill-scratch`); map and backtrack are
tracker-free (map is pure server, backtrack seeds a local scratch git
repo). Repeatable drivers at
`server/drills/drill-{thread,map,backtrack}.mjs` (run from `server/`:
`node drills/drill-<name>.mjs <projectDir> $PWD/dist/index.js`; fresh
scratch `<projectDir>` per drill).

**Thread drill — PASS 10/10.** `thread_start` created the real
`cairn:thread` issue and the session file; opened-mirror comment posted;
note/link/decision entries logged; the banner surfaced the open thread
LAST in kind order. Cold-killed the client; a fresh client's
`thread_start` with the same name hit the already-open guard (resume IS
the point), and the landscape showed counts intact — zero re-derived
context. Close before any wrap entry was refused; after the wrap entry,
close commented the resolution, closed the issue, archived the session.
The three tracker comments read opened → wrapped → resolved in plain
language; leak scan zero hits (spec success criterion 1).

**Map drill — PASS 10/10.** Chunked build done the safe way (nodes across
two patches, edges in ONE final patch — the map.md warning honored):
4 nodes / 3 edges. A dangling edge was rejected naming the ghost id and
the store read back BYTE-IDENTICAL afterward (validate-before-write
atomicity, live). Two reads byte-equal; node filter returned self +
touching edges + neighbors; nodeType/edgeType filters narrowed
correctly; deleting a node with attached edges was refused; a wholesale
edge replace demonstrated the documented replace semantics; null-delete
succeeded once detached (spec success criterion 2).

**Backtrack drill — PASS 8/8.** A scratch repo with two ledgered task
commits (`ledger_append`, real range in LEDGER.md) plus one LATER commit
overlapping `b.txt`. The revert set computed from the ledger named
exactly the two task commits; the overlap was flagged file-by-file. The
apply leg reverted the non-overlapping commit only (the verb's
manual-review rule for the overlapped file): revert commit created,
content restored, ORIGINAL SHAS INTACT — `git log` shows history grew,
nothing rewritten, the overlapping file untouched. The run closed with
an `audit_record` naming the excluded file (spec success criterion 4).

Criterion 3 (`medic`) and criterion 5 (`status --stats`) are verb-level
orchestrations of already-drilled tools (`plan_*`, `audit_record`,
`issue_list`, `mem_stats`, `session_landscape`) — covered by review of
the verb docs plus those tools' own rings, same treatment as prior
tiers' prompt-level surfaces.

## Tier F1 — Basecamp (Workspace Awareness + Workstreams) (2026-07-22)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **35 live, 0 reserved, 60
  server tools** (`basecamp` flips `reserved-F` → live; the reserved set is
  now **empty** — `SPEC_RESERVED = {}` in `scripts/check-surface.mjs`, the
  routing table's last row filled). `TOOL_PREFIXES` gains `workspace|board`
  per this spec's §1.
- Server: `cd server && npx vitest run` → **459 passed / 6 skipped** (465
  total; same env-gated `*.live.test.ts` skips as every prior tier —
  gitlab, jira, asana, azure-boards, clickup, github). `npx tsc --noEmit`
  clean. `npm run build` clean; `server/dist/` already matched the rebuilt
  output — nothing dirtied, nothing to commit this tier.

### Unit evidence summary

**Workspace discovery + focus resolution** (`test/workspace-context.test.ts`,
16/16, `describe("findWorkspace")` + `describe("setFocus +
resolveProjectDir")`):
- `"finds a workspace at the launch dir itself"` / `"walks up two levels to
  find the workspace root"` — the parent-dir walk, no `.git` requirement.
- `"returns null when no workspace file exists up to the filesystem root"`
  — the compatibility path's discovery half.
- `"lists a member without cairn.json as unconfigured"` — the
  configured/unconfigured split spec §2 calls for.
- `"throws CONFIG_INVALID for malformed workspace JSON rather than falling
  back to no-workspace"` / `"...when workspace JSON is missing required
  fields"` — a typo'd workspace file is a loud error, never a silent
  single-project fallback (the trap the spec explicitly calls out).
- `"round-trips: setFocus writes focus, resolveProjectDir follows it"` —
  the core focus-switch mechanism.
- `"rejects focusing an unconfigured member, naming it and the fix"` /
  `"rejects focusing a name that is not a member"` — both `workspace_focus`
  validation rails.
- `"clears focus with null; resolution falls back to the launch dir"`.
- `"resolves to the launch dir when there is no workspace at all (compat
  path)"` / `"...when a workspace exists but no focus is set"` — spec
  success criterion 2's two compatibility branches, directly unit-proven.
- `"resolves to the exact launch dir (not the workspace root) when
  unfocused, even nested inside a member"` — a session opened inside a
  member directory stays on that exact dir until it explicitly switches,
  per spec §2's discovery note.
- `"throws CONFIG_INVALID when the focused member is removed from the
  workspace file (stale focus)"` / `"...when the focused member becomes
  unconfigured (cairn.json removed)"` — a stale focus is a named error,
  never a silent fallback to the launch dir.
- `"writes the focus file atomically under .cairn/basecamp/focus.json at
  the workspace root"` — tmp + rename, workspace-root-scoped (never
  per-member).

**Board — merge, validation, atomicity, determinism** (`test/board.test.ts`,
17/17, `describe("boardUpdate")` + `describe("boardGet")`):
- `"creates a new workstream, stamping 'updated' server-side"` — `updated`
  is never taken from the patch.
- `"merges a patch's fields over an existing workstream, leaving other
  fields intact"` / `"null deletes a workstream"` — the `config_set`-style
  merge-patch discipline spec §3 calls for.
- `"requires title and project on create, naming the id"` /
  `"does not require title or project again on update"` — required-on-
  create-only, per spec.
- `"rejects an invalid status"` / `"rejects a project that is not a
  workspace member"` — both validation rails.
- `"rejects an empty title on create, naming the id"` / `"rejects a
  whitespace-only title on update, leaving store untouched"`.
- `"defaults status to queued when omitted on create"`.
- `"rejects with PRECONDITION_FAILED when no workspace exists, hinting
  basecamp init"` (on both `boardUpdate` and `boardGet`) — the board
  requires a workspace, per spec §3.
- `"leaves the store untouched when a patch is rejected
  (validate-before-write)"` — atomicity under rejection, the same
  discipline `config_set`/`map_set` already carry.
- `"writes atomically -- no leftover .tmp file after a successful write"`.
- `"returns an empty board with zeroed counts when no board file exists
  yet"` — never an error.
- `"sorts workstream ids deterministically and is byte-stable across
  reads"` / `"derives counts by status"` — the deterministic-read half of
  spec §3.

**MCP ring: five new tools + focus-redirect + per-member isolation**
(`test/mcp.test.ts`, 43/43 in the file, 10 new tests over the pre-Tier-F1
33):
- `"lists the expected tools"` (registry assertion, pre-existing test
  widened) — the 60-name list now includes `workspace_list`,
  `workspace_focus`, `workspace_status`, `board_get`, `board_update` —
  the same structural list `check-surface.mjs` verifies against
  `server/src/index.ts`.
- `"pins the tool count at 60"` — a direct count assertion, the mechanical
  half of spec success criterion 5 (routing table complete, reserved set
  empty) mirrored on the server-tool surface.
- `"workspace_list without a workspace returns { workspace: null }, not an
  error"` / `"workspace_focus without a workspace is a PRECONDITION_FAILED
  error"` / `"board_get without a workspace is a PRECONDITION_FAILED
  error"` — the no-workspace behavior of all three workspace-aware tools,
  through the protocol layer.
- `describe("workspace: focus redirect + board (two-member fixture)")`
  (5 tests, real two-member `cairn-workspace.json` + `cairn.json` fixture
  on disk): `"workspace_list reports the workspace, members, and null
  focus"`; `"workspace_focus rejects an unknown member"`; **`"focus on b
  redirects context_set into member b's .cairn/ only"`** — the direct
  mechanical proof of spec success criterion 1: `workspace_focus(project:
  "b")` then `context_set`/`context_get` lands the state file at
  `member-b/.cairn/state/active-context.json` and confirms it does NOT
  exist under `member-a/` or the workspace root, then clearing focus
  (`project: null`) reads back an empty context at the launch dir — an
  *existing* tool (`context_set`) demonstrably follows the focus with zero
  schema changes; `"board round-trips through board_update / board_get"`;
  `"board_update rejects a workstream naming a non-member project"`.
- `describe("workspace_status: per-member isolation")` (1 test): `"one
  erroring member yields { name, error } without failing the call"` — a
  workspace with a healthy member (real issue created, phase set) and a
  member whose `cairn.json` fails tracker-adapter validation
  (`makeTracker` throws fast, no network) — `workspace_status()` returns
  the healthy member's real `{ phase, openIssues, openSessions }` AND the
  broken member's `{ error }`, the whole call succeeding — the direct
  mechanical proof of spec success criterion 4 (a mixed workspace degrades
  member-by-member, never call-wide).

**Suite totals:** 459 passed / 6 skipped, `tsc --noEmit` clean.

### Compatibility gate (spec success criterion 2, this tier's hard gate)

The spec's compatibility ring requires the ENTIRE pre-existing suite to
run with no workspace present and pass **unedited** — that IS the
single-project byte-compatibility proof. Evidence, grep-before-cite:

- `git diff --stat main -- server/test/` shows exactly three files:
  `server/test/board.test.ts` (new, 186 lines) and
  `server/test/workspace-context.test.ts` (new, 189 lines) — both entirely
  new files, zero pre-existing test content touched — plus
  `server/test/mcp.test.ts` (172 lines changed).
- Within `mcp.test.ts`, the diff against `main` is: **(1)** the import
  line — `import { mkdtempSync, writeFileSync, rmSync } from "node:fs"`
  widened to `import { existsSync, mkdirSync, mkdtempSync, writeFileSync,
  rmSync } from "node:fs"` (the two added names are used only by the new
  workspace fixtures below) — and **(2)** the pre-existing `"lists the
  expected tools"` test's sorted-name array gaining the five new tool
  names (`workspace_list`, `workspace_focus`, `workspace_status`,
  `board_get`, `board_update`) — the tool-count pin this tier's surface
  growth requires. Every other line in the file's pre-Tier-F1 test cases
  is byte-identical (confirmed by `git diff`, not inferred); all 10 new
  tests (the tool-count pin, three no-workspace-error tests, and the two
  new `describe` blocks) are pure appends after the file's existing
  content. No other file under `server/test/` — and no file under
  `server/src/` outside the new `server/src/workspace/` directory — was
  edited by this tier: `git diff --stat main -- server/src/` shows
  `server/src/index.ts` (the resolveProjectDir/getTracker threading
  through every pre-existing handler — no tool name or schema changed —
  plus registrations for the five new tools) and the two new
  `server/src/workspace/{context, board}.ts` files, nothing else touched.
- Every pre-existing test file (`trace-store.test.ts`, `sessions-
  store.test.ts`, `banner.test.ts`, `config.test.ts`, `cards.test.ts`,
  `plan-check.test.ts`, `audit-record.test.ts`, all adapter unit/live
  suites, and the rest of the 39 test files) is untouched and green in
  the 459-pass total above — run with no `cairn-workspace.json` anywhere
  in the repo tree (there is none, and none is created by any non-
  workspace test), so every one of those runs IS the compatibility ring
  the spec's success criterion 2 calls for: no workspace present, existing
  suite unedited, all green.

### Spec success criteria 1–6 mapped

1. **A session in a workspace switches focus and EVERY tool follows —
   proven by an issue landing in the focused member's tracker and its
   session/banner files landing under the member's paths.** Directly
   unit-verified for the mechanical core — `mcp.test.ts`'s `"focus on b
   redirects context_set into member b's .cairn/ only"` above proves an
   *existing* tool (`context_set`, zero schema changes) redirects through
   `resolveProjectDir` the moment focus changes, landing state under the
   focused member's own `.cairn/` and nowhere else. The full claim (an
   `issue_create` landing in the focused member's real tracker, and the
   session/banner path-hash following too) needs a real tracker and a
   real per-member handoff/banner write — that end-to-end proof is the
   **basecamp drill**'s pass condition, below (PENDING).
2. **No workspace → byte-identical single-project behavior (existing suite
   unedited + the compat drill).** Directly verified for the "existing
   suite unedited" half — see "Compatibility gate" above (grep-before-cite
   evidence: exactly one pre-existing test file touched, and only for an
   import widen + a tool-name-list append). The live byte-identical
   behavior claim against a real pre-F1 baseline capture (session file,
   banner, record paths) is the **focus-compat drill**'s pass condition,
   below (PENDING).
3. **The dispatch board runs the full workstream lifecycle with
   tracker-first evidence (claim creates the member issue, done closes it
   with a plain note), and two parallel claims on one workstream are
   impossible to record as both-active (single-writer board, verb
   rule).** Directly unit-verified for the board mechanics —
   `board.test.ts`'s merge/validation/atomicity matrix above proves the
   single-writer, validate-before-write discipline the "impossible to
   record as both-active" claim depends on (a second `board_update`
   claiming the same workstream id simply overwrites the merged record,
   never forks it). The claim→member-issue-creation and done→close-with-
   plain-note lifecycle is verb-level (`verbs/basecamp.md` §`claim`/
   `done`) riding tools already proven in prior tiers (`issue_create`,
   `issue_close`) — live proof of the full lifecycle against a real
   tracker is the **basecamp drill**'s pass condition, below (PENDING).
4. **A mixed workspace (configured + unconfigured members) degrades
   member-by-member, never call-wide.** Directly unit-verified —
   `mcp.test.ts`'s `"one erroring member yields { name, error } without
   failing the call"` above: a member whose tracker config fails adapter
   validation reports `{ error }` while a healthy sibling member's real
   `{ phase, openIssues, openSessions }` comes back in the same
   `workspace_status()` call, which itself returns `isError: false`.
5. **Reserved verb set is EMPTY — the routing table is complete.**
   Directly verified — "Surface conformance" above: `check-surface.mjs`
   reports `0 reserved`, and `SPEC_RESERVED = {}` in the script itself
   (not a count that happens to be zero — the constant is the empty
   object the spec calls for).
6. **All 55 existing tools untouched in name and schema.** Directly
   verified — `mcp.test.ts`'s widened `"lists the expected tools"`
   assertion carries every pre-Tier-F1 tool name forward unchanged (only
   the five new names are appended to the sorted list; none removed,
   none renamed) and `"pins the tool count at 60"` confirms 55 + 5 exactly;
   `git diff --stat main -- server/src/` (above) shows no pre-existing
   tool's registration block edited — the five new `registerTool(...)`
   calls for `workspace_*`/`board_*` are pure additions in
   `server/src/index.ts`.

### Dogfood drill procedures (spec §6)

Per spec §6, two drills, to be run in a scratch workspace with cairn2
installed as a local plugin and recorded here once run — same
`server/drills/drill-{basecamp,focus-compat}.mjs` harness and format as
every prior tier's drills (real `dist/index.js` over stdio, real GitHub
tracker where a tracker is touched). Neither driver exists yet; per this
tier's convention (see bottom of this file), both are authored post-merge.

**Basecamp drill — RUN 2026-07-22, see results below.**
1. Scratch workspace root with two member directories: one GitHub-
   configured (`cairn.json` pointing at a real scratch repo), one left
   unconfigured (no `cairn.json`). Write `cairn-workspace.json` naming
   both.
2. `workspace_list()` → expect both members listed, the unconfigured one
   flagged `configured: false`, `focus: null`.
3. `workspace_focus(project: "<unconfigured member>")` → expect
   `CONFIG_INVALID` naming the member and the fix (add a `cairn.json`);
   `workspace_focus(project: "<configured member>")` → expect success,
   `{ focus, projectDir }` pointing at that member's absolute path.
4. With focus set, `issue_create` (via the existing tool, no new params)
   → expect the issue lands in the FOCUSED member's real tracker, and its
   `.cairn/` state (context, handoff, banner) lands under that member's
   own directory — never the workspace root, never the other member.
5. Board lifecycle: `board_update` a `queued` workstream naming the
   configured member as `project` → `board_update(status: "active",
   session: "<tag>")` (claim) → `board_update(status: "blocked", note:
   "<why>")` → `board_update(status: "done")`. Expect each transition to
   read back via `board_get`, and — per the verb's claim discipline —
   the claim step to have created/linked a real member-project tracker
   issue, the done step to close it with a plain-language close note
   (`verbs/basecamp.md` §`claim`/`update`/`done`).
6. `workspace_status()` → expect the configured member's real
   `{ phase, openIssues, openSessions }` and the unconfigured member
   marked (not silently dropped from the response).
7. `board_get()` called twice with no mutation between → byte-equal JSON.
8. `leak-patterns.mjs` scan over every comment/issue body written to the
   tracker in this drill → zero hits.
9. Pass condition: focus redirects `issue_create` and all `.cairn/` state
   to the focused member (criterion 1); the full claim → blocked → done
   lifecycle lands on the real member tracker with tracker-first evidence
   (criterion 3); the unconfigured member refuses focus but still lists,
   and `workspace_status` degrades it without failing the call
   (criterion 4); the board reads are byte-equal (criterion 3's
   determinism half); the leak scan is clean.

**Focus-compat drill — RUN 2026-07-22, see results below.**
1. A scratch project with NO `cairn-workspace.json` anywhere in its parent
   chain (the ordinary single-project case every pre-F1 cairn project
   already is).
2. Capture a pre-F1 baseline: run a short real session (`new` → `plan` →
   `work` on one issue) against the `dist/index.js` build from BEFORE this
   tier's commits (or an equivalent known-good baseline capture), and
   record the exact session file, handoff file, and banner file bytes/
   paths it produces.
3. Re-run the identical sequence against this tier's `dist/index.js` in a
   fresh copy of the same scratch project.
4. `workspace_list()` → expect `{ workspace: null }`, not an error.
5. Diff every stateful artifact from step 2 against step 3: the session
   handoff (`~/.cairn/handoff/<project>-<hash>.json`), the recall banner
   (`~/.cairn/banner/<project>-<hash>.md`), and the record paths
   (`.cairn/plans/...`, `LEDGER.md`, memory cards) — expect byte-identical
   content and identical paths (same `<hash>` — `resolveProjectDir`
   returning the exact launch dir, not a workspace-relative path, is what
   keeps the path-hash scheme unchanged).
6. Pass condition: every stateful tool behaves byte-identically to the
   pre-F1 baseline capture with no workspace anywhere in the tree — the
   live confirmation of spec success criterion 2, completing the
   "existing suite unedited" evidence already proven above with a real,
   driven session.

Post-merge convention (same as Tiers D/E): author + run
`server/drills/drill-{basecamp,focus-compat}.mjs`, then commit the
drills-run record here.

### Drill results — RUN 2026-07-22 (mechanical) — PASS 24/24

Same harness as every prior tier: real `dist/index.js` over stdio; the
basecamp drill's configured member uses the real GitHub tracker
(`eventually-consistent-code/cairn-drill-scratch`); the focus-compat drill
needs only a plain scratch project. Repeatable drivers at
`server/drills/drill-{basecamp,focus-compat}.mjs` (run from `server/`:
`node drills/drill-<name>.mjs <scratchDir> $PWD/dist/index.js`; fresh
scratch per run).

**Basecamp drill — PASS 15/15.** A two-member workspace (api configured,
web deliberately not): discovery listed both with `configured` truthful;
focusing the unconfigured member was refused; focusing api redirected
EVERYTHING — `context_set` landed in `api/.cairn/` (nothing at the
workspace root) and `issue_create` hit api's real tracker. The board ran
the full lifecycle: dispatch queued two workstreams, claim recorded
active + session tag + the member issue, blocked carried its why, done
closed the issue with a plain-language note. Board reads byte-equal;
`workspace_status` aggregated the configured member (phase, open counts)
without failing on the unconfigured one and without touching focus
(read-only guarantee held). Leak scan over tracker text: zero hits
(spec success criteria 1, 3, 4).

**Focus-compat drill — PASS 9/9.** With no workspace anywhere:
`workspace_list` reported `{ workspace: null }` (not an error);
`workspace_focus` and `board_get` refused with the init hint; and every
stateful surface — active context, probe session file + phase stamp,
audit record path, map store — landed at the exact pre-F1 launch-dir
paths, with no `.cairn/basecamp/` state ever materializing. The
workspace layer is invisible until asked for (spec success criterion 2,
the compatibility guarantee, now proven live as well as by the unedited
suite).

## Tier F2 — Cross-AI Peer Review (2026-07-22)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: **36 live, 0 reserved, 62
  server tools** (`peers` flips `reserved-F` → live, the last reserved
  verb; the reserved set stays empty. `TOOL_PREFIXES` gains `peer` per
  this spec's §1).
- Server: `cd server && npx vitest run` → **479 passed / 6 skipped** (485
  total; same env-gated `*.live.test.ts` skips as every prior tier —
  gitlab, jira, asana, azure-boards, clickup, github). `npx tsc --noEmit`
  clean. `npm run build` clean; `server/dist/` already matched the
  rebuilt output from the prior two tasks in this tier — nothing dirtied,
  nothing to commit this task.

### Unit evidence summary

**Peer runner — detection, caps, timeout, exit-code taxonomy**
(`test/peers-run.test.ts`, 14 tests, `describe("peerList")` +
`describe("peerRun")`, all against a STUB binary staged on PATH per test
— no real codex/opencode/gemini/grok assumed anywhere):
- `"reports onPath: false for every provider when none are on PATH"` /
  `"reports onPath: true only for the provider whose stub is present"` —
  the detection half of spec success criterion 1.
- `"defaults enabled: true and maxInputChars: 200000 when unconfigured"`
  / `"reflects a configured override for enabled and maxInputChars"` —
  the `cairn.json` `peers` block's config-vs-default resolution.
- `"throws PRECONDITION_FAILED when the provider is disabled in config"`
  / `"throws PRECONDITION_FAILED with an install hint when the binary is
  missing"` — both degrade-never-block preconditions named in the spec.
- `"truncates input at the configured cap and appends the exact marker"`
  / `"does not truncate when input is within the cap"` — spec success
  criterion 5 (`#997`'s truncation contract), including the exact marker
  text.
- `"kills a hung peer at the timeout and reports PRECONDITION_FAILED
  naming the provider"` — the 120s-default timeout kill path.
- `"passes through a non-zero exit code as a result, never a throw"` —
  the advisory-exit-code taxonomy the `peers` verb's judgment depends on.
- `"appends the stderr divider only when stderr is non-empty"` /
  `"omits the stderr divider when stderr is empty"` — output-shape
  determinism around the advisory result.
- `"survives EPIPE when a peer exits without draining a large stdin
  write"` / `"throws PRECONDITION_FAILED naming the provider on EACCES
  (non-executable staged binary)"` — the two hardening cases carried over
  from the prior task's spawn-error taxonomy work, now exercised against
  the peer templates specifically.

**Config schema — unknown provider rejected, defaults applied**
(`test/config.test.ts`, `describe("peers config")`):
- `"peers is absent by default"` — no `peers` key means every provider
  resolves to its hardcoded default, not an empty-object surprise.
- a round-trip test confirms a configured override (`codex.enabled:
  false`, `gemini.maxInputChars: 900000`) reads back exactly as written.
- an unknown provider key in the `peers` block throws at config-load time
  (schema `z.enum(PROVIDERS)` on the record keys) — a typo'd provider name
  can't silently pass validation.
- `"config_set-style patching via writeConfigPatch validates the peers
  block"` — the same merge-patch discipline every other `cairn.json`
  section already carries (`writeConfigPatch` rejects `notAProvider`,
  leaving the file untouched on a rejected patch).

**MCP ring: two new tools + tool-count pin** (`test/mcp.test.ts`):
- the pre-existing `"lists the expected tools"` registry assertion widens
  to include `peer_list`, `peer_run` (62-name sorted list, the same
  structural check `check-surface.mjs` verifies against
  `server/src/index.ts`).
- `"peer_list reports all four providers, onPath false in the bare
  harness"` — the protocol-layer proof that `peer_list` never throws and
  reports all four `PROVIDERS` even with nothing on PATH.
- `"peer_run executes a stub staged on PATH and returns its output"` — a
  real child process spawned through the full MCP tool-call path (stub
  staged on PATH for this one test only, restored after), proving
  `peer_run`'s advisory-result contract end-to-end through the protocol
  layer, not just the bare function.

**Suite totals:** 479 passed / 6 skipped, `tsc --noEmit` clean.

### Spec success criteria 1–6 mapped

1. **All four adapters detect, cap, and run (proven against stubs); a
   missing CLI degrades to proceed-without, never blocks.** Directly
   unit-verified — `peers-run.test.ts`'s detection, cap-truncation, and
   missing-binary/disabled-provider cases above prove the mechanical half
   against a stub CLI. The live claim — that the `peers` verb itself
   proceeds without a missing peer rather than stalling — is verb-level
   judgment (`verbs/peers.md` "Absent peers") riding this proven
   transport; live proof against a real `review`/`plan` invocation is the
   **peers drill**'s pass condition, below (PENDING).
2. **Peer findings only reach the tracker AFTER adversarial verification,
   with provenance (peer, round) in the record.** This is entirely
   verb-level judgment — `verbs/peers.md`'s convergence loop (own review
   first, judge each peer finding against the actual code, survivors only
   after verification, provenance in both the `cairn:review` issue and the
   `audit_record`). No server-side mechanism enforces this; the tool layer
   (`peer_run`) only moves bytes. Live proof that a stubbed peer finding
   actually flows through convergence into a real tracker issue + record
   crediting the peer is the **peers drill**'s pass condition, below
   (PENDING).
3. **The outbound leak scan runs before every peer_run and a hit stops the
   send (proven: the stub never receives the seeded secret).** Stated as
   a hard rule in `verbs/peers.md` ("Outbound leak gate") — reuses the
   existing `hooks/scripts/leak-patterns.mjs` pattern source, applied to
   outbound peer input instead of a git diff. Unproven by any existing
   unit test (the scan is verb-level judgment run before the tool call,
   not something `peer_run` itself enforces) — proving a seeded secret
   never reaches the stub CLI is the **peers drill**'s pass condition,
   below (PENDING).
4. **Convergence terminates: hard two-round cap, drilled.** Stated as a
   hard rule in `verbs/peers.md` (round 2 only for material
   disagreements, hard stop after). No unit mechanism to verify — this is
   verb-level judgment with nothing at the tool layer to pin it against;
   live proof is the **peers drill**'s pass condition, below (PENDING).
5. **Config caps enforce truncation with the marker (`#997`).** Directly
   unit-verified — `peers-run.test.ts`'s `"truncates input at the
   configured cap and appends the exact marker"` above proves the exact
   marker text and the `truncatedInput: true` flag at the tiny-cap
   boundary the test configures.
6. **Existing surfaces untouched: 60 prior tools unchanged, F1 compat
   intact (suite unedited except pins).** Directly verified — the
   cumulative Tier F2 diff on `git diff --stat main -- server/src/
   index.ts` is 17 lines: the two new `registerTool("peer_list"/
   "peer_run", ...)` blocks and their import, landed in the prior task and
   untouched by this one (`git diff --stat HEAD~1 -- server/src/index.ts`
   for this task's own commit is empty — this task edits only
   `scripts/check-surface.mjs` (`TOOL_PREFIXES` gains `peer`),
   `skills/cairn-trailhead/SKILL.md` (the routing-table row), and the new
   `verbs/peers.md`). No pre-existing tool registration edited, no schema
   changed. The widened `"lists the expected tools"` assertion in
   `mcp.test.ts` (above) carries every pre-F2 tool name forward unchanged;
   only `peer_list` and `peer_run` are appended.

### Dogfood drill procedure (spec §5) — RUN 2026-07-22, results below

Per spec §5's drill ring, `drill-peers.mjs` — mechanical, post-merge, same
harness convention as every prior tier (`server/drills/drill-<name>.mjs`,
run against the real `dist/index.js` over stdio). Does not exist yet; per
this tier's convention (see bottom of this file), it is authored post-merge
and its results recorded here once run. Itemized per the spec:

1. **Stub-CLI staging.** Stage four executable stub scripts on PATH, named
   `codex`/`opencode`/`gemini`/`grok` (the exact binary names `peer_list`/
   `peer_run` probe for) — no real provider CLI assumed anywhere. Each
   stub echoes back stdin length plus a canned, parseable "finding" (one
   fabricated review comment with a file:line and a severity word), so the
   drill can assert the convergence mechanics without depending on any
   real model's output.
2. **Detection.** `peer_list()` against the staged PATH → expect all four
   providers `onPath: true`, defaults applied for any provider absent from
   `cairn.json`.
3. **Cap truncation at a tiny configured cap.** Configure one provider
   (e.g. `codex`) with a deliberately tiny `maxInputChars` (small enough
   that a realistic diff exceeds it); `peer_run` that provider with input
   over the cap → expect the stub to receive exactly the capped byte count
   plus the exact marker line, and `truncatedInput: true` in the result.
4. **Stubbed peer finding → real convergence → real tracker record.** Run
   the `peers` verb's `review` flow (or a driver equivalent) against a
   small scratch diff, with the stub CLIs staged: expect cairn's own
   five-axis review to run first, the stub's canned finding to be judged
   (verified against the actual scratch diff — the driver's stub finding
   is deliberately checkable), a surviving finding to land as a real
   `cairn:review` issue (severity first line, plain language, peer + round
   named), and `audit_record(scope: "peers-review-<slug>")` to carry the
   same provenance. Non-surviving (deliberately false) stub findings must
   NOT reach the tracker — the adversarial-judgment half of spec success
   criterion 2.
5. **Outbound leak scan blocks a seeded secret.** Seed the scratch diff
   content with an obviously fake but pattern-matching secret (a leak
   pattern the project's `cairn.json` `leakGuard.extraPatterns` is
   configured to catch for this drill). Attempt the `peers review` flow →
   expect the leak scan to fire BEFORE any `peer_run` call, naming the
   offending line, and — the drill's hard assertion — the stub CLI's
   captured stdin (each stub script logs what it received to a drill-local
   file) never contains the seeded secret string, for any of the four
   providers. This is spec success criterion 3's live proof.
6. **Missing provider degrades to proceed-without.** Remove one stub
   (e.g. delete `grok` from the staged PATH dir) mid-drill and re-run the
   `review` flow → expect `peer_list` to report that provider
   `onPath: false`, the convergence loop to proceed with the remaining
   three peers plus cairn's own review, and the run to complete and record
   normally — never a hard stop for a missing CLI. This is spec success
   criterion 1's live proof.
7. Pass condition: all four adapters detect/cap/run against stubs and a
   removed one degrades cleanly (criterion 1); a stubbed finding survives
   adversarial judgment into a real tracker issue + record with provenance
   while a false one does not (criterion 2); the seeded secret never
   reaches any stub's captured stdin (criterion 3); the round cap holds
   (criterion 4, observed via the driver's round count); cap truncation
   and the marker are exact (criterion 5, re-confirmed live).

Post-merge convention (same as Tiers D/E/F1): author + run
`server/drills/drill-peers.mjs` against a real tracker for the finding
mirror leg, then commit the drills-run record here.

### Drill results — RUN 2026-07-22 (mechanical, stub CLIs + real tracker) — PASS 14/14

Same harness as every prior tier: real `dist/index.js` over stdio. All four
provider CLIs are STUBS staged on a drill-owned PATH prefix (each stub
captures its received stdin to a file — that capture is what makes the
outbound-block leg provable); the finding mirror uses the real GitHub
tracker (`eventually-consistent-code/cairn-drill-scratch`). Repeatable
driver at `server/drills/drill-peers.mjs` (run from `server/`:
`node drills/drill-peers.mjs <scratchDir> $PWD/dist/index.js`).

**Peers drill — PASS 14/14.** Detection listed all four stubs on PATH with
gemini carrying its configured 60-char cap. The outbound leak gate held on
both legs: the built-in patterns caught a seeded planning leak
(`.cairn/plans/...` in a diff) and a configured
`leakGuard.extraPatterns` entry caught a seeded AWS-style credential —
and the stubs' capture files prove NOTHING was sent on a scan hit
(criterion 3; note recorded: credential-class patterns are deliberately
the user's `extraPatterns`, the built-ins own planning leaks). The clean
run hit all four peers (exit 0, findings back); gemini's input arrived
truncated WITH the exact marker while an uncapped peer received the full
text (criteria 1, 5). Convergence mechanics landed the verified finding
as a real `cairn:review` issue with peer provenance in the body and
`codex round 1` credited in the record, closed with a plain note
(criterion 2). Removing a stub mid-run: `peer_run` failed soft with the
install hint and detection reflected the loss — proceed-without is the
verb's documented next move (criteria 1, 4's degrade half; the two-round
cap is doc-pinned and observed in the convergence leg's single round).

## Tier F3 — Frontend Quality Loop (2026-07-22)

### Zero-server-change statement

Per spec §1: "Zero server changes: tools stay 62; verbs stay 36." This tier
ships two plugin AGENT definitions and additive verb-doc wiring only —
`agents/cairn-designer.md`, `agents/cairn-uat.md`, plus additive edits to
`skills/cairn-trailhead/verbs/{draft,audit,map}.md`. No `server/` file is
touched.

Evidence command (run from repo root, this task's own commit range):
```
git diff main -- server/
```
Output: **empty** (0 lines) — confirmed. The full tier diff against `main`
touches only `README.md`, `agents/cairn-designer.md`, `agents/cairn-uat.md`,
the spec touch-up, and the three `skills/cairn-trailhead/verbs/*.md` files
(`git diff --stat main` excluding this verification-record commit: 7
files, no `server/` path in the list — the load-bearing check is
`git diff main -- server/` → empty, rerun at every gate).

### Surface conformance (unchanged, re-confirmed)

- `node scripts/check-surface.mjs` → clean: **36 live, 0 reserved, 62
  server tools** — identical to the Tier F2 pin; this tier adds no tool,
  no verb, no reserved-flip (spec §1's "zero new server tools, zero new
  verbs" holds).
- Server: `cd server && npx vitest run` → **479 passed / 6 skipped** (40
  test files; same env-gated `*.live.test.ts` skips as every prior tier).
  `npx tsc --noEmit` clean. Both runs are byte-identical in outcome to
  Tier F2's — expected, since no server source moved.

### Agent verification: frontmatter + tool-list grepped against the registry

Spec success criterion 6: "Both agents carry valid plugin-agent frontmatter
and reference only real tools." Verified by grepping every
`registerTool(...)` call site in `server/src/index.ts` (including the
`registerSessionTools("probe"|"draft"|"thread", ...)` loop that mints
`draft_start`/`draft_log`/`draft_close` and its two siblings) into a
53-literal + 9-templated = **62-name registry**, then checking each tool
named in both agents' frontmatter `tools:` line and body against it:

**`agents/cairn-designer.md`** frontmatter: `tools: draft_log,
issue_comment, map_set, map_get, session_landscape, Read, Write, Edit,
Glob, Grep`.
- `draft_log` — real, minted by the `registerSessionTools("draft", …)`
  loop at `server/src/index.ts:682` (`${kind}_log`, kind="draft").
- `issue_comment` — real, `server/src/index.ts:600`.
- `map_set` — real, `server/src/index.ts:741`.
- `map_get` — real, `server/src/index.ts:752`.
- `session_landscape` — real, `server/src/index.ts:716`.
- `Read`/`Write`/`Edit`/`Glob`/`Grep` are Claude Code built-ins, not
  server MCP tools — correctly outside the registry check.
- Notably ABSENT from the tool list: `draft_start`/`draft_close`, even
  though both are real registered tools — this is deliberate (the
  735bbd5 fix commit: "verb owns draft sessions"), matching the spec
  touch-up above. Zero fabricated tool names.

**`agents/cairn-uat.md`** frontmatter: `tools: issue_list, issue_get,
issue_create, issue_comment, issue_close, map_get, audit_record,
trace_start, plan_status, Read, Glob, Grep, Bash`.
- `issue_list` — real, `server/src/index.ts:224`.
- `issue_get` — real, `server/src/index.ts:196`.
- `issue_create` — real, `server/src/index.ts:188`.
- `issue_comment` — real, `server/src/index.ts:600`.
- `issue_close` — real, `server/src/index.ts:215`.
- `map_get` — real, `server/src/index.ts:752`.
- `audit_record` — real, `server/src/index.ts:729`.
- `trace_start` — real, `server/src/index.ts:606`.
- `plan_status` — real, `server/src/index.ts:250`.
- `Read`/`Glob`/`Grep`/`Bash` are Claude Code built-ins, correctly outside
  the registry check.

Result: **13 of 13** server-tool references across both agents resolve to
a real `registerTool` call site; **0** fabricated or stale tool names.
Both files carry valid frontmatter (`name`/`description`/`tools` fields
per the Claude plugin agent format) — this satisfies spec success
criterion 6 directly (stated in spec §5 as "verified in Task review, not
scripted," which is exactly the check performed here).

### Verb-doc wiring evidence

Spec §4's three wiring points, confirmed present in the working tree (not
merely described in a commit message):

- **`draft.md`** — a "Designer dispatch" section (lines 80–88): non-trivial
  design questions go to the `cairn-designer` agent (Task tool) with the
  session id + question; `draft` keeps session lifecycle
  (`draft_start`/`draft_close`) and the tracker mirror. The tokens.json
  both-files discipline is stated in the theme step (lines 22–27): every
  token change touches BOTH `themes/default.css` and `themes/tokens.json`,
  drift is named as an `audit ui` finding.
- **`audit.md`** — the `uat` mode row gains the platform-matrix +
  traceability-sweep sentence (named `cairn-uat` as the dispatchable
  specialist); the `ui` mode row gains the fidelity-contract sentence
  (compares shipped UI against the draft session's decided direction +
  `tokens.json`, divergence cites the decision entry it violates).
- **`map.md`** — one line under the build walk: requirement → decision
  `implements` edges AND decision → module `decided-in` edges (both
  sourced from draft sessions) are first-class citizens of `map build`,
  since the `cairn-uat` traceability sweep depends on them staying
  current.

All three edits are additive (no rewrite of shipped verb text) — matches
the "additively" claim in commit 5b780e1.

### Spec success criteria 1–6 mapped

1. **Designer flow: wireframe → tokens (both files, never divergent) →
   prototype, every stage a decision entry with mirror discipline.**
   Prompt-level (agent body), confirmed present by direct read of
   `agents/cairn-designer.md`'s "The three-stage flow" section — not
   server-verifiable. Live proof that the flow actually produces synced
   `default.css`/`tokens.json` and decision entries is the **frontend-loop
   drill**'s pass condition, below (PENDING).
2. **Traceability: requirement issues trace through map edges to decided
   designs and walked flows; a seeded untraced requirement is named as a
   finding (drilled).** Prompt-level (`cairn-designer`'s "Traceability as
   you go" + `cairn-uat`'s "Traceability sweep" sections) riding the real
   `map_set`/`map_get` tools (confirmed real, above) — no server mechanism
   computes the sweep itself. Live proof that a seeded untraced
   requirement is actually named is the **frontend-loop drill**'s pass
   condition, below (PENDING).
3. **Fidelity: divergence from a decided direction lands as a
   `cairn:audit` finding citing the decision entry it violates
   (drilled).** Prompt-level (`cairn-uat`'s "Fidelity handoff" section) —
   the mechanism it rides (`issue_create` with label `cairn:audit`,
   `audit_record`) is real and tool-verified above; the judgment of
   *which* divergence counts and *which* decision it cites is agent-level.
   Live proof is the **frontend-loop drill**'s pass condition, below
   (PENDING).
4. **tokens.json ↔ default.css drift is detectable and IS an audit ui
   finding (drilled mechanically).** Stated as a hard rule in both
   `agents/cairn-designer.md` ("Tokens and CSS never diverge") and
   `draft.md`'s tokens.json paragraph. No unit test exercises this (it's
   a file-pair comparison an audit-mode walk performs, not a server
   function) — live proof that a seeded drift is actually caught is the
   **frontend-loop drill**'s pass condition, below (PENDING).
5. **Server surface untouched: 62 tools, 36 verbs, suite green.**
   Directly verified now, no drill needed — see "Zero-server-change
   statement" and "Surface conformance" above: `check-surface.mjs` clean
   (36/0/62), `git diff main -- server/` empty, `vitest run` 479/6
   skipped, `tsc --noEmit` clean.
6. **Both agents carry valid plugin-agent frontmatter and reference only
   real tools.** Directly verified now, no drill needed — see "Agent
   verification" above: 13/13 real tool references, 0 fabricated, valid
   `name`/`description`/`tools` frontmatter on both files.

**Verifiable now: criteria 5 and 6 (server untouched + suite green; the
frontmatter/tool-grep evidence). Criteria 1–4 require the live
frontend-loop drill (below, PENDING) — they are agent-level judgment
riding real tools, not server-side mechanisms a unit test can pin.**

### Dogfood drill procedure (spec §5) — PENDING, not yet run

Per spec §5's drill ring, `drill-frontend-loop.mjs` — mechanical,
post-merge, same harness convention as every prior tier
(`server/drills/drill-<name>.mjs`, run against the real `dist/index.js`
over stdio). **Does not exist yet** (confirmed: no `drill-frontend-loop.mjs`
in `server/drills/`); per this tier's convention (see bottom of this
file), it is authored post-merge and its results recorded here once run.
Itemized per the spec:

1. **Draft session decides a direction.** Open a `draft` session
   (`draft_start`), log a `variant` entry, then a `decision` entry
   (`draft_log`) — write `.cairn/draft/themes/default.css` and
   `.cairn/draft/themes/tokens.json` in the SAME change, both files
   present and in sync.
2. **`map_set` records requirement→decision `implements` edges.** Seed a
   requirement `issue` node and a `decision` node via `map_set`, with an
   `implements` edge between them, plus a `decided-in` edge from the
   decision node to a `module` node.
3. **Traceability sweep computed from `map_get`.** Seed a SECOND
   requirement issue node with NO edges at all (deliberately untraced).
   Compute the sweep against `map_get`'s full edge set → expect exactly
   ONE gap named (the untraced requirement), zero false positives against
   the traced one. This is spec success criterion 2's live proof.
4. **A fidelity divergence lands as a real `cairn:audit` issue.** Seed a
   deliberate visual divergence from the decided direction; drive the
   `cairn-uat` fidelity-handoff path → expect `issue_create(label:
   "cairn:audit")` with the violated decision entry's id cited in the
   body, plus `audit_record` carrying the same citation. This is spec
   success criterion 3's live proof.
5. **tokens/CSS drift seeded → detected by comparing the pair.** Seed a
   token added to `tokens.json` and NOT to `default.css` (or vice versa)
   → expect the pair-comparison check to name the specific token and
   which file it's missing from, and for this to be recorded as an
   `audit ui` finding. This is spec success criterion 4's live proof.
6. **Leak scan on tracker text.** Seed a mirror comment (the
   `draft`/`audit uat` plain-language comments) with an internal ref (a
   file path or code block) → expect the leak-pattern scan (reused from
   `hooks/scripts/leak-patterns.mjs`, same posture as the Tier F2 outbound
   gate) to catch it before it reaches the tracker.
7. Pass condition: draft session's tokens/CSS land in sync (criterion 1);
   the seeded untraced requirement is the ONLY gap named, traced one is
   silent (criterion 2); the seeded fidelity divergence produces a real
   `cairn:audit` issue citing the correct decision entry (criterion 3);
   the seeded tokens/CSS drift is named with the specific token and
   missing file (criterion 4); server surface stays at 62/36 throughout
   (criterion 5, re-confirmed live); both agent files' tool lists still
   resolve 100% against the registry at drill time (criterion 6,
   re-confirmed live); the leak scan blocks the seeded internal ref.

Post-merge convention (same as Tiers D/E/F1/F2): author + run
`server/drills/drill-frontend-loop.mjs` against a real tracker, then
commit the drills-run record here.

**Drill status: RUN 2026-07-22 — results below.**

### Drill results — RUN 2026-07-22 (mechanical, real tracker) — PASS 7/7

Same harness as every prior tier: real `dist/index.js` over stdio, real
GitHub tracker (`eventually-consistent-code/cairn-drill-scratch`).
Repeatable driver at `server/drills/drill-frontend-loop.mjs` (run from
`server/`: `node drills/drill-frontend-loop.mjs <scratchDir>
$PWD/dist/index.js`; fresh scratch per run).

**Frontend-loop drill — PASS 7/7.** The designer rails: a draft session
opened (verb-owned lifecycle), tokens.json and default.css written in
sync and PROVEN in sync by property-set comparison, variant + decision
entries logged with mirror comments. The traceability rails: decision and
module nodes plus BOTH edges (requirement —implements→ decision
—decided-in→ module) recorded via the read-unfiltered-append-write
discipline the agents mandate. The UAT rails: the sweep over `map_get`
edges named EXACTLY the seeded gap (a second requirement with no design)
and recorded it as an important finding linked to the real issue; a
fidelity divergence landed as a real `cairn:audit` issue whose body cites
the violated decision entry verbatim; a seeded token without a CSS twin
was detected by the pair comparison (the audit ui drift check, criteria
1-4). Leak scan on tracker text: zero hits. Criterion 5 (server
untouched) held the whole tier; criterion 6 (agent frontmatter + real
tools) verified in review with registry line numbers cited above.

## P5′ — Dogfood Gate, 1.x Cutover, Publish (2026-07-22)

### Cutover (shipped this section)
- `commands/` now contains exactly `cairn.md` — the seven transition
  shims (`import new plan ship status verify work`) deleted per the
  Tier 0 spec's schedule ("removed at P5′"). Always-present token cost
  per Tier 0's method: ~213 tok (entrypoint + 7 shims) → ~23 tok
  (entrypoint only), a ~89% drop from the transition-era cost (the
  Tier 0 table's 86% figure is the 172 → 23 pre-shim baseline — both
  land with this change).
- `plugin.json` version: `2.0.0-alpha.0` → `2.0.0-rc.1` (cutover
  complete, publish pending).
- Gate at the cutover commit: full suite 479 passed / 6 skipped,
  `tsc --noEmit` clean, `check-surface: clean — 36 live, 0 reserved,
  62 server tools`. Zero server changes.

### Human gate 1 — live dogfood pass — SEMI-LIVE HALF RUN 2026-07-23; plugin-load smoke test remains (owner)
Install cairn2 as the local plugin in a fresh session, scratch repo with
a real tracker in `cairn.json`, then: `/cairn new` → `/cairn plan 1` →
`/cairn work 1` → `/cairn verify 1` → `/cairn ship`; `/cairn do "what's
the status"` (expect: routes without confirmation); `/cairn wrok`
(expect: help + "did you mean work?"); kill the session mid-`work` and
confirm the waypoint resume lands on the exact task. Record results
here. The 25 mechanical drill drivers (255/255 checks across the eleven per-tier runs, Tiers A0–F3) are
the necessary half; this live pass is the sufficient half.

### Human gate 2 — publish — PENDING (owner)
Swap cairn 1.x → cairn2 in the plugin marketplace (this also retires the
1.x `/cairn:gsd` parity passthrough, which per the roadmap survives
until exactly this moment). Bump to `2.0.0` when both gates close.

### Semi-live dogfood results — RUN 2026-07-23 — PASS 17/17

Repeatable driver at `server/drills/drill-dogfood.mjs` (run from
`server/`: `node drills/drill-dogfood.mjs <scratchDir>
$PWD/dist/index.js`; fresh scratch per run). It walks the Tier 0 dogfood
procedure THROUGH THE VERB DOCS' OWN TOOL SEQUENCES against the real
dist server, real GitHub tracker, real hook scripts, in a scratch git
repo:

- **new → plan 1:** cairn.json gate, project + phase scaffold, tracker
  phase, requirement issued and linked to the plan.
- **work 1, killed mid-issue:** claim → in_progress → context +
  checkpoint → real commit → SIGKILL. The PostToolUse breadcrumb and
  SessionStart hooks fired exactly as the plugin wires them
  (`hooks/hooks.json` commands, run verbatim): the resume block named
  the exact task, `continuity_get` landed on it, and the tracker
  cross-check showed in_progress with no contradiction. The issue then
  closed and ledgered with real shas.
- **verify 1:** drift correctly FLAGGED the closed issue while the phase
  was unverified (the drift math doing its job), no open stragglers,
  VERIFICATION.md written.
- **ship gate:** post-verification drift clean + phase verified;
  continuity cleared.
- **do-routing + typo:** `status` resolves live from the routing table
  and renders from live reads; `wrok` is not a verb, the nearest-match
  computation over the actual table resolves to exactly `work`, and
  help.md carries the "did you mean `work`?" rule verbatim.

**Install-readiness also verified 2026-07-23:** `plugin.json`,
`hooks/hooks.json`, and `.mcp.json` all parse; `.mcp.json` points at the
committed `server/dist/index.js`; `commands/` contains exactly
`cairn.md`; `agents/` and `skills/` present.

**Honest residue — the remaining owner step is a plugin-load smoke
test, not a workflow test:** everything ABOVE the plugin loader is now
exercised (tool sequences, routing table, hooks, continuity, tracker).
What no driver can reach is Claude Code loading the plugin itself:
command registration, hooks.json wiring, MCP server startup from
`.mcp.json`. One fresh session with cairn2 installed, run
`/cairn status` and one `/cairn wrok`, confirm the SessionStart banner
appears — that closes gate 1.
