# Context economy layer — design

Date: 2026-09-20
Status: approved design, not yet planned
Supersedes: the proposals in `~/repos/claude-cache/HANDOFF-cairn-cache-layer.md`
Measurement: `~/repos/claude-cache/MEASUREMENT-step1-transcripts.md`

## Outcome

Cut the context a session holds, and the number of turns that hold it, without
degrading output quality. Target: 50% reduction in cache_read tokens per unit
of delivered work, held against leading indicators until the per-work-item
baseline is real.

## What the measurement changed

The handoff proposed three things: a local MoE pre-digest (C), a local peer
plus vector retrieval (A), and a deterministic tool-output cache (B). Step-1
instrumentation of 410 transcripts / 400 sessions / 28,176 API turns does not
support any of them as the primary lever.

**Subagent fan-out is not the problem — it is the best compression already in
use.** Sidechains are 60% of turns and 26% of cache_read: ~3.4x cheaper per
turn than the main thread. Policy should push work *into* subagents.

**Cost is session shape, not careless reads.** Median `Read` result is 878
tokens; p90 is 3,259; exactly one read in 1,346 exceeded 100k. A local digest
compresses individual reads, and there is nothing in a median read to
compress. The money is thousands of small items entering early and never
leaving: 76% of tool_result residency is created in the first 40% of a session.

**63% of all cache_read is spent above 300k of context.** No cache, digest, or
retrieval change touches that number.

**Vector retrieval solves an unobserved problem.** The "lexical miss → read the
whole file" failure the handoff predicts does not appear in the data.

Arithmetic ceiling of the three original proposals combined: roughly 19%. They
cannot reach the target.

## The harness constraints that decide the design

Verified against the Claude Code 2.1.267 binary:

- `updatedInput` is supported — **a PreToolUse hook can rewrite tool input.**
- `updatedOutput` does not exist — **nothing can rewrite or evict a tool
  result.** Eviction is not available to cairn at any hook.
- The harness already evicts: `tengu_time_based_microcompact`, a `keepRecent`
  policy, and the literal `[Old tool result content cleared]`. It triggers on
  `context_hint` — a server-side signal that the context window is nearly full.

The keystone: **cost-optimal eviction and window-safety eviction are different
policies, and only the second one exists.** The harness protects the window,
not the wallet. It intervenes around 900k; 63% of spend happens above 300k.
The gap between those two numbers is the whole opportunity.

Since cairn cannot evict, its levers are prevention at source, signalling,
session turnover, routing to sidechains, and prefix hygiene.

## Section 1 — the metric

**Rent** is the primary series: `cache_read` tokens. That is the measured
97.4% term; everything else is rounding. It is what a session pays per turn
for bytes it already bought.

**Two faces, one collection path.**

- *Quota face* — raw tokens per work item. Correct under a subscription, where
  dollars are fiction.
- *Money face* — the same tokens priced through the existing `PRICES` table in
  `stop-costtracker.mjs`, labelled notional. Correct for API-billed users of
  the plugin, who are most of them.

**Denominator.** Not the active-context tag. Across the whole recorded history
only 7 of 33 sessions carry an issue tag, 24 are untagged and carry 45% of
spend, and 4 distinct issues appear in total. Work is counted instead from
durable timestamped facts:

- primary: tracker issues closed within the session's time span
- secondary: commits landed in the repo within that span
- deduped where a commit closes an issue

This is derivable retroactively over the full history, so the baseline exists
the day it ships rather than 30 days later.

**Primary KPI:** rent per closed work item, 30-day trailing.

**Leading indicators**, with today's baseline:

| Indicator | Baseline |
|---|---|
| avg context per turn | 229k |
| share of rent spent above 300k context | 63% |
| prefix size | p50 32.5k historical; 79.7k observed today |
| sidechain cost advantage | 3.4x cheaper per turn |
| superseded + duplicate residency | ~9% of tool_result residency |

The 50% target is held against these indicators until attribution produces a
real per-work-item baseline. The indicators are trustworthy today; the KPI is
not.

## Section 2 — architecture and components

### A finding in cairn's own house

`scripts/check-footprint.mjs` reports 2,264 tokens resident and passes with 36
to spare. Cairn's 86 MCP tool schemas are **11,396 estimated tokens** —
descriptions 4,819, schemas 5,388, plus envelope. Real resident cost is
~13,660 tokens. The guard counts the slash-listing descriptions and excludes
on-demand bodies, but tool schemas are neither: they are resident on every
turn of every session, and they are 83% of cairn's real rent. The guard
watches the small half and reports clean.

### Placement

New `server/src/context/` sibling module; hooks extend what already exists.

**The layer pays its own rent.** It adds exactly one MCP tool
(`context_meter`, ~100 tokens). Everything else lives in hook scripts and
repo scripts, which cost nothing resident. A context-cost layer that ships six
new tool schemas has spent its own savings before it starts.

### Components

**1. Meter.** Extends `hooks/scripts/stop-costtracker.mjs`, which already makes
one forward pass over the transcript per Stop, throttled at 30s. Residency
accounting rides that same pass — no new hook, no second pass. New row fields:
per-producer residency, band histogram, prefix size, turn count, average
context.

**2. Attribution.** `server/src/context/attribution.ts`. A reporting-time join,
not a hook: session span → issues closed + commits landed. Depends on no tags,
and runs retroactively.

**3. Band signal.** Two channels, deliberately asymmetric:

- *statusline*, for the human: live context and band, **zero context cost**
- *`additionalContext`*, for the agent: only at a band crossing, once per band
  per session, at most two lines

Bands at 150k / 300k / 500k, taken from the measured distribution.

**A plugin cannot provide a statusline.** The harness's capability table admits
hooks, skills, agents and MCP servers from a plugin, but `statusLine` only from
user or project settings. So the free channel is opt-in: `/cairn:tune` offers
to write it into the user's settings, and never writes it unasked. The agent
channel must therefore stand alone and carry the signal by itself wherever the
statusline is absent, which is the default.

**4. Turnover.** A band crossing prompts a checkpoint through the existing
`continuity_checkpoint` and `waypoint`. Cairn cannot restart a session — no
harness API exists for it — so this is advisory by construction, which matches
the chosen authority level. The new piece is measuring **re-entry cost**
(prefix + handoff + re-reads) so that restart-versus-ride is an argued number.

**5. Context guard.** `hooks/scripts/pretooluse-contextguard.mjs`. The only
enforcing component. See section 3.

**6. Footprint audit.** Closes the blind spot above: `check-footprint.mjs`
grows to count MCP tool schemas, with the budget re-pinned at the true figure
and enforced in CI; plus a report-only machine-wide mode ranking every
installed plugin by resident cost. That is what makes a 79.7k prefix
actionable, and most of that prefix belongs to plugins other than cairn.

### Data flow

```
transcript → meter (Stop hook) → context-meter state file (per-project
                                 planning state dir)
                               → one row on the per-project metrics log
                                        ↓
                      statusline + band hook read the state file
                                        ↓
                    report joins rent against git and tracker
```

### Failure posture

Every hook stays fire-and-forget and swallows its own errors, except the
guard's deliberate refusal, which must be loud (ADR 0016 — harness guards
refuse visibly rather than sandbox).

## Section 3 — the guard's correctness rules

### Scope, cut to what the data supports

Bounding "firehose" output was proposed and then cut. Bash results across the
corpus: 7,318 calls, median 99 tokens, p90 954, **max 7,295**. There is not one
firehose in the record, and `Read` is already capped at 2,000 lines by the
harness. That rule would bound output nothing is producing.

It survives as **shadow mode only**: the meter records what the rule would have
blocked, and the rule is built only if shadow data finds a target.

The guard therefore ships with **one rule**: do not re-read a file that is
unchanged and already resident. Ceiling ~9% of tool_result residency, ~4% of
total. Modest — the investment is sized to match. Turnover is where the money
is.

### The governing principle

**Fail open, always.** A wrongly-blocked read costs a turn and confuses the
agent; a wrongly-allowed read costs tokens. Those are not symmetric, so every
ambiguity resolves to *allow*.

### Threats to residency, each forcing a fail-open

| Threat | Detection | Response |
|---|---|---|
| Harness microcompact cleared old results | `microcompact_boundary` transcript subtype, plus `[Old tool result content cleared]` | wipe ledger entries older than the boundary |
| `/compact` | PreCompact hook, where `precompact-refresh.mjs` already fires | wipe ledger |
| `/clear` | new session id; the ledger is session-scoped | resets naturally |
| The read happened in a **subagent**, not this context | match `isSidechain` on the prior result against the current invocation | if undeterminable, allow |
| File changed underneath | mtime + size + content hash | allow |
| Prior read was **partial** | ledger records the returned range and truncation flag | block only if the requested range is a subset of the resident range |

The subagent row is the one that would have bitten us: sidechains share a
session id but not a context window, and they are 60% of all turns. A naive
ledger would block main-thread reads for bytes that only ever existed inside a
subagent.

### Ledger

`{path, hash, size, mtime, rangeStart, rangeEnd, truncated, turnIndex,
sidechain, resultUuid}` — written by PostToolUse, read by PreToolUse, stored
per session in the project's planning state directory.

Refusal text carries its evidence: which turn read the file, that it is
unchanged since, and how to override.

## Section 4 — testing and rollout

### Testing

`server/test/hooks.test.ts` already exercises the hook scripts; the meter and
guard extensions test where the existing ones do.

- **Residency math** — pure functions in `server/src/context/`, run against
  fixture transcripts. The 410 real transcripts are the golden corpus: the
  meter must reproduce the figures in the measurement doc, which makes the
  analysis itself a regression test.
- **Fail-open table** — one case per threat in section 3, each asserting
  *allow*. The subagent case carries the most cases.
- **Attribution** — session span to closed issues and commits, including
  overlapping sessions, a commit closing two issues, and a session that closes
  nothing.
- **Guards** — `check-footprint` re-pinned at the true figure with schemas
  counted; tool-count pins in `mcp.test.ts` and `standalone.test.ts` move for
  the one new tool; `check-dist` requires the rebuild committed in the same
  logical unit.

### Rollout

| Phase | Ships | Behavior change | Gate to next |
|---|---|---|---|
| **A** | meter, attribution, report, footprint audit | none | real per-work-item baseline exists |
| **B** | statusline + band crossings | signal only | bands observed crossed and acted on |
| **C** | turnover protocol + re-entry cost | advisory | restart measurably beats riding |
| **D** | guard rule 1, shadow then enforcing | first enforcement | shadow shows a real target |

Phase A ships first and alone. It changes nothing and produces the number every
later claim depends on — including the honest possibility that the target needs
revising once the denominator is real.

### Kill criteria

A cost layer that costs more than it saves is the failure mode here.

- If phase C shows re-entry cost exceeding turnover savings, C is wrong and the
  gateway escape hatch returns to the table.
- If D's shadow mode finds under ~2% recoverable, D never ships.
- If the layer's own resident footprint exceeds ~500 tokens, it has eaten its
  margin and gets cut back.

### Principal risk

Turnover savings depend on compliance, and cairn can only advise — it cannot
restart a session. If the band signal is ignored, phases B and C produce
nothing.

## Rejected, with reasons

**Local MoE pre-digest (handoff proposal C).** Compresses individual reads;
the median read is 878 tokens. Adds latency and a blind-spot risk — the local
model would decide what Opus never sees — to claim a term worth ~1% of spend.

**Vector retrieval alongside FTS5 (handoff proposal A part 2).** Solves a
retrieval failure that does not appear in the data.

**Local peer provider (handoff proposal A part 1).** Cheap and low-risk, but it
saves nothing on its own. Shelved, not refuted; it can return if a later phase
finds work worth running locally.

**Deterministic tool-output cache (handoff proposal B).** Cached bytes still
enter context, so it saves the turn and not the residency — and residency is
97.4% of the bill.

**Local API gateway (handoff dropped it; new evidence partly revives it).** A
proxy at `ANTHROPIC_BASE_URL` owns the message list and is the only thing that
could implement the cost-optimal eviction the harness refuses to do before
900k. Genuinely the highest ceiling here. Rejected anyway: the auth path is a
subscription OAuth token, and putting a proxy in it is a credential-handling
risk that standing policy forbids. It also fights the harness's own cache
prefix, breaks across upgrades, and silently dropping a result the model still
needed is an invisible correctness failure. Documented as the escape hatch if
phase C's kill criterion fires.

## Open items

- The exact re-pinned `check-footprint` budget, set once schemas are counted in
  the guard rather than estimated here.
