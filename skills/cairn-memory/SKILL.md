---
name: cairn-memory
description: Use when a repo has cairn.json and the cairn MCP tools (mem_*) are available — the cairn 2.0 memory lifecycle. Owns the distill-then-drop policy (what deserves a durable card vs. disposable index), scoped recall conventions, staleness handling, and the capacity-guard advisory.
---

# cairn memory (anti-rot policy)

The server owns mechanism (indexing, search, card storage, git-diff staleness
checks). This skill owns judgment: what's worth keeping, when to distill, and
how to act on a stale or over-capacity signal.

## Activation gate

Apply when `cairn.json` exists AND the `mem_*` MCP tools are available.

## Two tiers — what goes where

| Tier | Store | Lifetime | Tools |
|---|---|---|---|
| 1 — index | SQLite FTS at `~/.cairn/index/` (outside the repo) | disposable, rebuildable | `mem_index`, `mem_search`, `mem_stats` |
| 2 — cards | `.cairn/memory/cards/*.md` (git-committed) | durable | `mem_card_create`, `mem_card_list`, `mem_card_recall` |

Index reference-grade material you'll cite later (docs, API surfaces,
research dumps) via `mem_index`, labeled with a `source` string and, when
relevant, `phase`/`issueId`. Never index logs, test output, or build
output — that's ephemeral; read it, act on it, don't persist it.

## Distill-then-drop

At issue close and phase transition, ask: "what here deserves a card?" A
card is a single durable fact — a decision, constraint, gotcha, or
reference — not a session summary. Write it with `mem_card_create`, citing
the file(s) and commit(s) that back it as `provenance`. Then let the old
index scope simply stop being searched — no deletion needed; tier 1 is
disposable by design.

## Scoped recall

Search the task at hand, not the whole project's noise:
`mem_search(query, phase: <N>)` or `(issueId: <id>)`. Widen only when the
narrow search comes up empty.

## Staleness — the anti-rot headline

`mem_card_recall` re-verifies every card's provenance against the current
repo (a git diff since the recorded commit) before returning it. A card can
come back `stale: true` with `staleReasons`. Never treat a stale card as
ground truth — re-verify the claim against the current code, then either
update the card's body (rewrite the file) or delete it if it no longer
applies. A stale card left unaddressed is worse than no card.

## Capacity guard

Call `mem_stats()` at phase transitions and periodically during long runs.
Compare `approxTokens` against `cairn.json`'s `memory.tokenThreshold`
(default 150000 — read the file directly, no tool needed for this). Over
threshold: advise splitting the active issue into sub-tasks (`issue_create`
plus a tracker dependency link) rather than continuing to pile work into one
context. This is advisory — the tool cannot pause execution; you act on the
signal.

## Precedence & safety

- Tier 1 is disposable — losing the index loses nothing durable, so there's
  no "backup" concern.
- Tier 2 cards are git-committed — treat them like code: review, PR, don't
  hand-edit frontmatter into malformed shapes. A malformed card is skipped
  by `mem_card_list`/`mem_card_recall`, not surfaced as an error — it
  silently drops out of recall. Check `git status`/`git diff` after
  hand-editing a card.
