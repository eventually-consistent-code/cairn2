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
(`test/sessions-store.test.ts`, 6/6):
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
- `"registers the full tool set"` (registry assertion) lists all 48 tool
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

**Probe drill — PENDING (run live post-merge).**
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

**Draft drill — PENDING (run live post-merge).**
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

**Landscape drill — PENDING (run live post-merge).**
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
