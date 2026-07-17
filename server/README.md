# cairn-server

MCP server for cairn 2.0. See `docs/superpowers/specs/2026-07-12-cairn-2-design.md`.

## Test rings

1. `npm test` — unit + contract-vs-FakeTracker (CI, no network)
2. `npm run test:live` — contract vs a real backend. Per spec, an adapter is
   NOT shipped until live-green.

Each `.live.test.ts` skips cleanly when `CAIRN_LIVE_TESTS` and its backend's
env vars aren't set, so `npm test` never touches the network.

## Adapter status

| type | unit | contract (fake) | contract (cached) | live status | live env vars |
|---|---|---|---|---|---|
| `github` | ✅ | ✅ | ✅ | 🟢 live-green (8/8, sandbox, 2026-07-13) | `CAIRN_TEST_GITHUB_REPO`, `GITHUB_TOKEN` (or `gh auth login`) |
| `gitlab` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_GITLAB_PROJECT`, `GITLAB_TOKEN` |
| `jira` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_JIRA_BASE_URL`, `CAIRN_TEST_JIRA_PROJECT_KEY`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| `asana` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_ASANA_PROJECT_GID`, `ASANA_TOKEN` |
| `azure-boards` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_AZURE_ORG_URL`, `CAIRN_TEST_AZURE_PROJECT`, `AZURE_DEVOPS_PAT` |
| `clickup` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_CLICKUP_DEFAULT_LIST`, `CAIRN_TEST_CLICKUP_SPACE` (or `CAIRN_TEST_CLICKUP_FOLDER`), `CLICKUP_TOKEN` |

"contract (fake)" is ONE shared run of `test/contract.ts` against `FakeTracker`
(and `CachedTracker(FakeTracker)` for "contract (cached)") — it is not a
per-adapter run; each adapter's own live-gate coverage is what "live status"
reports above.

"contract (fake)"/"contract (cached)" mean the adapter's behavior is exercised
indirectly — every adapter shares the same `trackerContract` suite
(`test/contract.ts`), which today runs directly against `FakeTracker` and
`CachedTracker(FakeTracker)`. The adapter-specific "contract" coverage lives
in each `<name>.live.test.ts`, gated as shown below; "unit" is each adapter's
own `<name>.unit.test.ts` against fixture HTTP responses.

## Planning tools

The `plan_*` tools manage project artifacts and phase tracking across cairn integrations:

| tool | purpose |
|---|---|
| `plan_scaffold_project` | Create `.cairn/plans/PROJECT.md` + `roadmap.md` (never overwrites) |
| `plan_scaffold_phase` | Create `phases/NN-slug/` with `CONTEXT.md` + `PLAN.md` (+ optional `RESEARCH.md`) |
| `plan_status` | Report phases, artifact presence (CONTEXT/RESEARCH/PLAN/VERIFICATION), and referenced tracker issues |
| `plan_phase_ensure` | Ensure the tracker has a phase named `Phase N: <name>` (idempotent by canonical name) |
| `plan_drift` | Flag plan-referenced issues that are missing or closed without a VERIFICATION.md |
| `plan_issues_set` | Set the tracker issue ids a phase's `PLAN.md` frontmatter advances |

### Artifact layout

Plans live at `<projectDir>/.cairn/plans/`:

```
.cairn/plans/
  PROJECT.md       # project vision and scope
  roadmap.md       # phase roadmap
  phases/
    01-name/       # phase directories (zero-padded number + slug)
      CONTEXT.md   # phase requirements
      RESEARCH.md  # optional deep-mode research
      PLAN.md      # execution plan (frontmatter: issues: [<tracker-ids>])
      VERIFICATION.md  # (optional) drift guard — presence exempts a closed issue
```

Each phase directory name matches `NN-<slug>` where `NN` is 01..99 zero-padded
and `<slug>` is lowercase alphanumerics + hyphens (auto-slugified from phase name).

### Drift semantics

`plan_drift` scans all phase PLAN.md frontmatters for referenced tracker issues and flags:

- **missing**: issue id no longer exists in the tracker
- **closed**: issue is closed AND its phase has no VERIFICATION.md

The presence of a `VERIFICATION.md` file in a phase directory signals that the
phase has been verified complete, so closed issues are no longer considered drift.
This gate is the human-controlled contract between plan state and phase completion.

## Memory tools

The `mem_*` tools give agents a two-tier memory: a disposable full-text index for
reference material, and durable, git-committed cards for decisions/constraints/
gotchas/references:

| tool | purpose |
|---|---|
| `mem_index` | Index reference material into the searchable memory store (disposable, rebuildable) |
| `mem_search` | Full-text search the memory index, optionally scoped to a phase/issue |
| `mem_stats` | Memory index size — chunk count and approximate token usage (capacity guard signal) |
| `mem_card_create` | Write a durable memory card (decision/constraint/gotcha/reference) with provenance |
| `mem_card_list` | List memory cards, optionally filtered by phase/issue scope |
| `mem_card_recall` | List memory cards with staleness checked against their provenance (the anti-rot check) |
| `mem_timeline` | Chronological neighbors (cards + index chunks) around an anchor, at index cost |

### Artifact layout

Two tiers, with different durability guarantees:

```
~/.cairn/index/<project>.db        # Tier 1 — FTS5 index, disposable, never git-tracked, safe to delete (rebuildable)
.cairn/memory/cards/*.md           # Tier 2 — durable memory cards, git-committed
```

Tier 1 is a `better-sqlite3` FTS5 virtual table keyed off `mem_index`/`mem_search`.
Tier 2 cards are frontmatter'd Markdown files (`type`, `scopePhase`, `scopeIssue`,
`provenanceFiles`, `provenanceCommits`, `created`) with a deterministic id
(`<type>-<sha256(body).slice(0,8)>`), so re-creating a card with identical content
never produces a duplicate file.

### Staleness

Every `mem_card_recall` call re-checks each card's provenance against `git diff`
at the recorded commit; `stale: true` means the underlying files have since
changed (or vanished, or couldn't be verified) — treat the card as a lead to
re-verify, not a fact to trust.

### Capacity guard

`cairn.json` carries `memory.tokenThreshold` (default `150000`) — read directly
from config by the skill (not returned by any tool) to decide when the memory
index is getting large enough to warrant summarizing or pruning.

### Timeline

`mem_timeline({ anchor, before?: 3, after?: 3 })` answers "what was happening
around this decision?" at index cost — `anchor` is a memory card id or an
index chunk source; the result merges chronologically adjacent cards
(`{ id, type, title, created, cost }`) and index chunks (`{ source,
createdAt }`) into one ordered list. Cards carry a day-precision `created`
date while index chunks carry a full ISO timestamp, so entries sort by
whatever precision they actually have (a same-day chunk sorts after a
same-day card); same-day cards tie-break by id.

## Session continuity

Kill a session mid-task — compaction, usage cap, `/clear`, a real crash —
and the next session resumes at the exact task with zero re-executed work.
The server is the primary writer: every state-changing tool (`context_set`,
`issue_update`, `issue_close`, `plan_issues_set`, `plan_import`,
`mem_card_create`, `ledger_append`) refreshes the handoff in-process,
write-through, on every call.

| tool | purpose |
|---|---|
| `continuity_checkpoint` | Write/refresh the session handoff (also called manually by `/cairn waypoint`) |
| `continuity_get` | Read the current handoff; flags one older than 14 days as stale but never errors on staleness |
| `continuity_clear` | Delete the handoff — called on confirmed resume, `ship`, and `summit` |
| `ledger_append` | Append a verified-task line to a phase's git-committed `LEDGER.md` (append-only) |

### Artifact layout

```
~/.cairn/handoff/<project>-<hash>.json   # per-machine, ephemeral session handoff — never git-tracked
~/.cairn/banner/<project>-<hash>.md      # pre-rendered recall-index cache (see below)
.cairn/plans/phases/<NN-slug>/LEDGER.md  # per-phase, git-committed, append-only task ledger
```

`<hash>` is `sha256(resolve(projectDir)).slice(0, 16)` — the same per-machine
keying scheme the memory index uses, so handoff/banner state never collides
across projects that happen to share a basename.

### Resume flow

1. A `PostToolUse` hook (throttled to ≤1 write/60s) and an unthrottled
   `PreCompact` hook cover the gaps between tool calls; `SessionStart` cats
   the handoff and, per `continuity.resume`, offers (`prompt`), auto-runs
   (`auto`), or suppresses (`off`) the resume.
2. `/cairn waypoint` is the manual path: no argument pauses (prompts for
   `next_action`/`notes`, optionally offers a `wip(cairn):` commit);
   `/cairn waypoint resume` resumes.
3. **Trust order is never the handoff alone.** The tracker and `git log`
   outrank `LEDGER.md`, which outranks the handoff — a handoff that
   contradicts the tracker (an issue it names as open that's actually
   closed, a task the ledger already shows landed) is reported and
   corrected before it's followed. See
   `skills/cairn-trailhead/verbs/waypoint.md`.
4. On confirmed resume, `ship`, or `summit`: `continuity_clear()`.

### Guard rails

- **Skeleton guard.** A write can never replace a handoff with `task.current`
  or `next_action` populated with an empty one — richness is monotonic
  between clears.
- **Unregistered guard.** Every writer requires a loadable `cairn.json`;
  nothing is ever created outside `~/.cairn/` for a project cairn doesn't
  know.
- **Never trusted blind.** A handoff older than 14 days is surfaced as stale
  and never auto-resumed, even with `continuity.resume: "auto"`.
- Every hook is fire-and-forget (errors exit 0 silently) and targets <100ms —
  a hook failure is never visible to the session.

### Recall index (session-start memory banner)

On every card mutation or active-context scope change, the server
re-renders the banner cache above: a byte-stable, token-cost-annotated table
of memory cards scoped issue > phase > project (id tiebreak), capped at
`continuity.recallIndex.maxCards`. `SessionStart` just cats the file — no DB
access, no runtime spawn. Fetch cost is `ceil(card_chars / 4)`, computed
fresh at render time; `mem_stats` reports `bannerTokens` (the banner's own
cost) and `tokensSavedVsFullInjection` (sum of the scoped cards' costs minus
the banner cost, floored at 0) — honest accounting of what the pre-rendered
index actually saves versus injecting every card in full.

### Configuration

`cairn.json`'s `continuity` block:

```json
"continuity": {
  "resume": "prompt",
  "checkpoint": true,
  "wipCommits": false,
  "recallIndex": { "enabled": true, "maxCards": 20 }
}
```

- `resume` — `prompt` (default) asks before resuming, `auto` proceeds
  without asking, `off` suppresses the `SessionStart` resume offer entirely.
- `checkpoint` — enables/disables the `PostToolUse` breadcrumb hook.
- `wipCommits` — `/cairn waypoint` offers a `wip(cairn): waypoint —
  <next_action>` commit on pause when there's uncommitted work.
- `recallIndex.enabled` / `recallIndex.maxCards` — the recall banner above.

## Collaboration

The `plan_*` and `issue_*` tools coordinate team workflow when multiple agents (or humans + agents) work on the same project.

| tool | purpose |
|---|---|
| `plan_unplanned` | Tracker issues (non-closed) that no phase's PLAN.md references — work at risk of being missed |
| `plan_import` | Reverse-mirror a tracker phase (by id or name substring) into .cairn/plans/ artifacts |

On very large trackers the underlying issue list is capped (1000 items on GitHub/GitLab via pagination, 100 on Jira/Asana/Azure Boards/ClickUp), so `plan_unplanned`'s report may be incomplete beyond that cap; a truncation warning is logged to the server's stderr when it happens.

### Configuration

**User handle (optional).** Set `cairn.json`'s `user.handle` field to your identity (e.g., your GitHub username) to participate in ownership tracking:

```json
{
  "tracker": { "type": "github", "config": {} },
  "user": { "handle": "alice" }
}
```

When `user.handle` is set:
- **Claim & assign:** `/cairn:work <phase>` calls `issue_update(id, assignee: <handle>)` so teammates see who holds each issue. If an issue is assigned to someone else, the workflow skips it unless the user explicitly overrides.
- **Skip others' work:** By default, the work flow skips issues assigned to teammates, to avoid stepping on toes.

When `user.handle` is absent, cairn operates in single-user mode — no assignee tracking, no ownership checks.

Assignee **write** support today is GitHub and Azure Boards only. The other backends accept the `issue_update(..., assignee: ...)` call but don't propagate it: ClickUp explicitly defers it (needs numeric user-id resolution not yet implemented); Jira, Asana, and GitLab have no assignee mapping yet.

### Infrastructure (not new machinery)

Plans and memory cards collaborate via **ordinary git** — push your changes, open a PR, review and merge together. The server does not enforce locking or concurrency control.

Work-state concurrency (two agents starting the same issue at once) is **the tracker's responsibility** — its `issue_update()` call with `state: "in_progress"` is the atomic claim. Cairn reads the tracker's truth; the tracker enforces the constraint.

**Per-machine isolation.** Each machine holds its own `active-context` state (`.cairn/state/active-context.json`). Agents on different machines can work on different issues in the same phase without conflict — coordination happens via the tracker and git-committed plan artifacts.

## Running the live gates

Only `github` is live-green today — it's been run against a real sandbox
repo. The other five adapters are fully implemented and pass unit +
contract-fake but have not yet been run against live credentials; run their
gate below before relying on them in production.

### github

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_GITHUB_REPO="<you>/cairn-sandbox"   # a throwaway repo you own
gh auth status || gh auth login                        # or export GITHUB_TOKEN
cd server && npm run test:live
```

### gitlab

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_GITLAB_PROJECT="<you>/cairn-sandbox"  # a throwaway project you own
export GITLAB_TOKEN="<personal access token, api scope>"
cd server && npx vitest run test/gitlab.live.test.ts
```

### jira

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_JIRA_BASE_URL="https://your-domain.atlassian.net"
export CAIRN_TEST_JIRA_PROJECT_KEY="SAND"                # a throwaway project you own
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="<token from https://id.atlassian.com/manage-profile/security/api-tokens>"
cd server && npx vitest run test/jira.live.test.ts
```

Known risk: this adapter posts search queries to `POST /rest/api/3/search`,
which Atlassian has deprecated on Jira Cloud in favor of `/search/jql`.
Migrating the adapter is expected to be needed by the time this gate runs
live against a real Jira Cloud instance.

### asana

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_ASANA_PROJECT_GID="<numeric project gid>"  # a throwaway project you own
export ASANA_TOKEN="<personal access token>"
cd server && npx vitest run test/asana.live.test.ts
```

### azure-boards

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_AZURE_ORG_URL="https://dev.azure.com/your-org"
export CAIRN_TEST_AZURE_PROJECT="<throwaway project you own>"
export AZURE_DEVOPS_PAT="<PAT with Work Items (Read & Write) scope>"
cd server && npx vitest run test/azure-boards.live.test.ts
```

Known risk: the classificationnodes/iterations response-shape handling (both
the `{ value: [...] }` wrapper and the root-node `children` shape, plus
`\Iteration\`-path normalization) was hardened speculatively based on known
API variance, not against a live org. This live gate is the definitive check
that the parsing matches what a real Azure DevOps org actually returns.

### clickup

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_CLICKUP_DEFAULT_LIST="<throwaway list id>"
export CAIRN_TEST_CLICKUP_SPACE="<throwaway space id>"   # or CAIRN_TEST_CLICKUP_FOLDER
export CLICKUP_TOKEN="<personal API token>"
cd server && npx vitest run test/clickup.live.test.ts
```

Every suite creates issues/milestones (or the backend's phase equivalent)
prefixed `contract:` in the sandbox project. Clean up by closing them or
deleting the sandbox; the suite never touches anything it did not create.

## Rebuilding `dist/`

The `server/dist/` directory is committed to the repository so that marketplace installations (via git clone or tarball) can run the MCP server without requiring a build step. When you modify files in `server/src/`, you must rebuild and commit the updated `dist/` directory:

```bash
cd server && npm run build && git add dist && git commit -m "…"
```

Contributors should always rebuild `dist/` alongside source changes; a CI check for drift is planned as future work.
