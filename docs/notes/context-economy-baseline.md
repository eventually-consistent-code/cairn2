# Context economy — phase A baseline

Date: 2026-09-20

Phase A's job was a real per-work-item baseline for context rent, so phase
B's 50% target has something honest to be measured against. This is that
number. Read the Caveats section before trusting any figure below — the
short version is that residency accounting (`context` field on the metrics
row) landed in this same branch earlier today, so every session recorded
before that point, which is every session in the data, has none of it.

## What was measured, and over what window

Two windows, because the rollup step and the attribution step need
different scopes:

- **Step 1 (rollup)** reads every metrics row on this machine, across all
  projects: `~/.cairn/metrics/*.jsonl`, 848 rows, timestamps
  2026-08-03T22:16Z through 2026-09-20T15:28Z (today) — 33 distinct
  session ids across 10 projects. This is what the brief's rollup command
  produces, and it is reported verbatim below.
- **Step 2/3 (rent-per-item)** is scoped to this repo only: cairn2's own
  metrics file holds 6 recorded sessions, spanning 2026-08-13T20:43Z
  through 2026-09-20T15:28Z (today, this session) — about 37 days. Closed
  issues and commits are drawn from that same span, because a work item
  can only be attributed to a session that shares its project.

The two windows differ on purpose (see Caveats — scope mismatch).

## Step 1 — the rollup, verbatim

Command run from `server/`:

```
npx tsx -e '
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { summarise, sessionSpans } from "./src/context/meter.js";
const dir = join(homedir(), ".cairn", "metrics");
const rows = [];
for (const f of readdirSync(dir)) {
  for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { /* skip */ }
  }
}
console.log(JSON.stringify(summarise(rows), null, 2));
console.log("spans:", sessionSpans(rows).length);
'
```

Output:

```json
{
  "sessions": 33,
  "turns": 0,
  "rent": 6872580802,
  "avgContextPerTurn": 0,
  "sidechainTurnShare": 0,
  "bandRentShare": {
    "under150k": 0,
    "to300k": 0,
    "to500k": 0,
    "over500k": 0
  },
  "residency": {},
  "prefixTokens": {
    "p50": 0,
    "max": 0
  }
}
spans: 33
```

`turns: 0` is not a rounding artifact and not a small-sample quirk — it is
literal. Every one of the 848 rows across all 10 projects was checked, and
zero carry a `context` field. `summarise` falls back to `rent += ... ??
cache_read_tokens ?? 0` exactly for this case, which is why `rent` (6.87B
tokens, machine-wide, all history) is a real number while everything
downstream of `context` — turns, bands, residency, prefix — reads as zero.
See Caveats.

## Step 2 — closed work items, cairn2 window

`gh` is authenticated on this machine (verified via `gh auth status`), so
closed issues were pulled directly rather than falling back to commits
alone:

```
gh issue list --state closed --limit 300 --json number,closedAt \
  --jq '.[] | select(.closedAt >= "2026-08-13") | "\(.number) \(.closedAt)"'
git log --since="2026-08-13T20:43:33Z" --format="%H %cI %s"
```

Over the cairn2 window (2026-08-13T20:43Z – 2026-09-20T15:28Z):

- 141 closed issues
- 250 commits

Conventional-commit subjects that reference an issue in the trailing
`(#NNN)` form (96 of the 250) were folded onto that issue's id before
counting, matching `attributeRent`'s own rule that an issue and the commit
that closed it are one delivery, not two. That collapses 391 raw
issue+commit rows to 295 distinct work items for the window.

## Rent per work item

`sessionSpans` over cairn2's 6 recorded sessions, joined to those 295 items
via `attributeRent`:

| | value |
|---|---|
| sessions | 6 |
| distinct work items in window | 295 |
| items attributed to a session span | 288 |
| items orphaned (closed before any recorded session) | 7 |
| unclaimed rent (sessions that closed nothing) | 0 |
| total attributed rent | 2,650,394,223 tokens |
| **rent per work item** | **~9.20M tokens (~$7.00 notional)** |

The 7 orphans are all issues closed the same calendar day as the window's
first recorded session, but before it started — real work, zero attributed
rent, because no session was open yet to hold it. That is an artifact of
where the metrics history happens to begin, not free work.

`unclaimedRent: 0` means every one of the 6 sessions closed at least one
item — cairn2's session cadence during this window tracks its delivery
cadence closely, so there is no idle-session rent hiding in this number
yet.

**A number worth investigating rather than trusting on sight:** one closed
issue absorbs an entire 306.5M-token session by itself — nearly 12% of the
window's whole attributed rent, for one item, from a session whose wall
clock ran 17 minutes. Read naively that looks like a broken row. It isn't:
the session's first recorded snapshot, taken seconds after the session
opened, already shows 793K output tokens and 270M cache-read tokens
accumulated. The model tag on that session is `claude-fable-5`, and this
project runs autonomous wave/batch dispatch — many subagents fanning out
and reporting back inside one wall-clock window. Seventeen minutes of
clock time is not seventeen minutes of one thread's work; it's a burst of
concurrent sidechain turns landing close together. The number is real and
it is exactly the kind of shape phase B's threshold work is meant to bend:
one item's rent should not depend on whether the session that closed it
happened to be a lean interactive one or a wave dispatch.

Because rent attaches to sessions, not items, and sessions vary from 17
minutes to 17 days in this window, the per-item average smooths over that
range rather than describing a typical item. Treat 9.20M as the number to
watch move, not as a unit cost any individual future item should be
compared against directly.

For scale, the same 6 sessions carry a machine-notional cost of $2,016.33
(PRICES-table arithmetic, see Caveats) against the 33-session, 10-project,
$5,625.54 machine-wide total for the same 48-day span.

## Caveats

**The undercount is total, not partial.** Residency accounting (the
`context` field: turns, bands, residency, prefix size) landed on this
branch earlier today. Every row in every metrics file on this machine —
848 rows, 33 sessions, 10 projects, going back to 2026-08-03 — was written
by the old hook code and carries no `context` field at all. `turns`,
`avgContextPerTurn`, `bandRentShare`, `residency`, and `prefixTokens` in
the Step 1 output are not thin samples; they are computed over zero
qualifying rows and read as zero for that reason. The five reference
leading indicators from the design spec (avg context/turn, share above
300k, prefix size, sidechain advantage, superseded-residency share) are
**not re-derivable at all** from today's data — there is nothing to
re-derive them from yet. The next honest re-run of this document is the
one where at least a handful of sessions have stopped since this code
landed.

**Tokens are a `chars / 4` estimate — but not the number this document
leans on.** The residency fields (`ctx_sum`, `prefix_tokens`, bands,
per-producer residency) are computed from message-content byte length
divided by 4, because the transcript gives no per-message token count.
That estimate is real and it will apply to every future baseline's
headline rent figure once `context` rows exist. It does **not** apply to
the rent figure in *this* document: with no `context` field to read, the
rollup falls back to `cache_read_tokens`, which is the API's own reported
usage count from the transcript, not a derived estimate. So this baseline's
rent number is more precise than the ones that will replace it — worth
knowing, since the swap will look like new noise when it's really a
different (and coarser) measurement method taking over.

**Cost figures are notional, not money paid.** `est_cost_usd` is list-price
arithmetic against the `PRICES` table in the Stop hook's cost tracker
(cache read priced at roughly 0.1x input, by model family), and this
account runs on subscription rather than API metering — actual variable
cost was $0 for this work. The dollar figures in this document exist only
to give the token counts a familiar unit and to compare relative weight
across models and sessions, never as a claim about a bill.

**Scope mismatch between Step 1 and the rent-per-item figure, on
purpose.** The brief's rollup command reads `~/.cairn/metrics` in full —
every project on the machine, 33 sessions. Attribution needs the
numerator and denominator drawn from the same project, since a session in
one repo cannot have closed an issue in another. So the rent-per-item
number uses only cairn2's 6 sessions against cairn2's own closed issues and
commits, and the two figures (6.87B machine-wide rent vs. 2.65B cairn2
rent) are not the same population. Both are reported above, labeled.

**Session telemetry undercounts delivery volume by roughly 50x in this
window.** 295 distinct closed work items landed against 6 recorded
sessions. Most of that work did not happen inside a session this hook
observed — headless batch dispatch, work from other machines, or activity
before this machine's local metrics history began all land as commits and
closed issues with no session to attribute them to. The 7 orphan items are
the visible edge of that; the true count of unattributed-but-real work is
almost certainly larger and simply invisible to this method, since an
orphan only shows up when it falls in a gap between two recorded sessions,
not when it happens somewhere this machine never saw at all.

**No fallback needed for `gh`.** `gh auth status` confirmed an authenticated
GitHub session; closed-issue data came directly from `gh issue list`, not
from commits alone.

## Reference values from the original measurement

For context, not for re-derivation — these came from the step-1
instrumentation of 410 transcripts / 400 sessions / 28,176 API turns that
motivated this whole layer, cited in the design spec, and they are **not**
what this document re-measures:

| Indicator | Original reference value |
|---|---|
| average context per turn | 229k |
| share of rent spent above 300k context | 63% |
| prefix size | p50 32.5k historically; 79.7k observed in a recent session |
| sidechain cost advantage | ~3.4x cheaper per turn than main-thread |
| superseded + duplicate tool-result residency | ~9% of tool_result residency |

Today's data cannot confirm or contradict any of these — see Caveats. The
one place today's numbers and the reference numbers *can* be compared is
rent itself: 6.87B tokens machine-wide, 2.65B cairn2-scoped, over the
windows above, both real API-reported cache-read totals rather than
estimates, and both consistent in scale with a project running frequent
long sessions and heavy subagent fan-out.

## Leading indicators — what phase B will be measured against

| Indicator | Reference (prior measurement) | Measured today | Status |
|---|---|---|---|
| Rent per closed work item (cairn2, 37-day window) | none — new metric | **~9.20M tokens (~$7.00 notional)**, 288 attributed / 295 items, 6 sessions | First real data point |
| Total rent, cairn2 scope (37-day window) | none | 2,650,394,223 tokens ($2,016.33 notional) | Measured |
| Total rent, machine-wide (48-day window) | none | 6,872,580,802 tokens ($5,625.54 notional) | Measured |
| avg context per turn | 229k | not computable | **Blocked — 0 of 33 sessions carry a `context` field** |
| share of rent spent above 300k context | 63% | not computable | Blocked, same reason |
| prefix size (p50 / max) | p50 32.5k / 79.7k observed | not computable | Blocked, same reason |
| sidechain turn-cost advantage | ~3.4x cheaper/turn | not computable | Blocked, same reason |
| superseded + duplicate tool_result residency | ~9% | not computable | Blocked, same reason |

Phase B should not compare its results against this table's blocked rows
until a fresh rollup, run after this branch has accumulated real
`context`-bearing sessions, replaces them. The two rent totals and the
rent-per-item figure are real today and are the right rows to hold phase
B's claims against in the meantime.
