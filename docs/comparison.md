# How cairn compares — mechanisms, not vocabulary

Ever noticed that every agent-workflow tool now claims "drift detection"
and "adversarial review"? The words stopped meaning anything — so this
page doesn't argue vocabulary. It compares **mechanisms**: what the
software actually computes, where the source of truth actually lives,
and what happens when a claim is wrong…

**Maintenance contract:** this is a standing page, not launch copy.
Every competitor row carries a *last verified* date. If a row is stale
or wrong, [open an issue](https://github.com/eventually-consistent-code/cairn2/issues)
— a corrected row with a fresh date beats a flattering one. We never
repeat a competitor's unverifiable marketing claims, and we expect the
same courtesy.

Cairn's column reflects version 2.3.x: 39 verbs, 79 typed MCP tools,
1117 passing tests, 8 tracker backends. Counts are CI-measured and move
with each release (verified 2026-08-14).

## The head-to-head — tools doing a similar job

These are the closest substitutes: agent planning/memory layers you'd
consider *instead of* cairn.

| Mechanism | cairn | GSD lineage (GSD / GSD Pro / open-gsd / buildomator) | Superpowers | gstack | claude-mem |
|---|---|---|---|---|---|
| **Where work-item truth lives** | Your external tracker — 8 write-through backends (GitHub, GitLab, Jira, Asana, Azure Boards, ClickUp, Linear, zero-credential local). Plans mirror to it; it remains the source your team already reads. | Repo files. GSD added one-way GitHub sync after sustained user demand — export, not a source-of-truth mirror. | No tracker concept — it's a skills/discipline layer. | Repo files. | No tracker concept — it's a memory layer. |
| **Drift: what is actually computed** | Plan↔external-tracker drift *math*: the server diffs plan-referenced issues against live tracker state (missing, closed-unverified, edited, unplanned) and blocks ship on flags. | buildomator's "drift-detection safeguards" are *internal* state drift — HANDOFF.json checkpoints and worktree staleness. Nothing diffs against an external tracker. | None. | None found. | None. |
| **Verification** | Goal-backward verify gate: a phase passes only when the codebase delivers what the phase promised, evidenced in a committed VERIFICATION.md; closed-but-unverified issues are a drift flag, not a success. | GSD has a verifier for its own plan steps; no tracker cross-check. | Verification is prompt discipline (checklists), not a computed gate. | None found. | n/a |
| **External review** | Claim-verified-against-source cross-vendor review: `peers` seats codex, grok, antigravity, and opencode, and a claim without a locatable evidence ref is discarded before convergence. | GSD Pro routes across models for *generation* — multi-model routing, not adversarial verification of claims. | None. | None found. | n/a |
| **Memory honesty** | Provenance-checked cards: each memory records the file+commit it came from; recall runs `git diff` against that provenance and flags `STALE` instead of asserting stale facts. | Plan/handoff files carry state; no provenance re-check on recall. | None. | None found. | Capture + summarization; no provenance refs, no staleness checking on recall. |
| **Harness reach** | Claude Code plugin first-class; one installer wires the same server + verbs into Grok Build, Copilot CLI, Codex, Gemini CLI, Cursor, OpenCode, Zed. | GSD targets 8+ harnesses (file conventions travel well). | Claude Code-centric skills. | Single-harness. | Claude Code-centric. |
| *Last verified* | 2026-08-14 (CI) | 2026-08-13 | 2026-08-13 | 2026-07 — **not re-verified in the August pass**; treat this column as possibly stale and expect a refresh next survey | 2026-08-13 |

Honest credit where due: cairn keeps GSD's best ideas — the phase
shape, the depth dial, goal-backward verification — and adds the layer
those flows can't hold in files: tracker truth and provenance-checked
memory.

## Adjacent, not substitutes — different job

You'll use some of these *alongside* cairn. Each row says why it
doesn't replace the mechanisms above.

**Native Tasks (Claude Code).** The platform's built-in task list:
local, session-scoped, dependency edges, with an open feature request
for sync. It answers "what am I doing right now", not "what does my
team's tracker say". The two compose instead of competing: cairn
mirrors native Tasks to your tracker automatically — a task created
in-session appears as a tracker item and closes itself when the task
completes (hook-driven, no polling; task ids are session-scoped, so
cairn keys them per session). *Verified against Claude Code 2.1.223,
2026-08-14.*

**Auto Memory (Claude Code).** On by default since 2.1.59 — session
continuity is now a platform freebie, and cairn doesn't compete with
it. What it doesn't do is provenance: nothing records which file+commit
a remembered fact came from, so nothing can tell you the fact went
stale. That check is cairn's memory mechanism. *2026-08-13.*

**beads.** A maturing local issue tracker (Dolt-backed, dependency
types, ready-work detection, its own plugin). It lives at the layer
*below* cairn's mirror — it's a place work items can live, not a
plan-to-tracker mirror with drift math. Cairn ships its own
zero-credential local backend today; beads occupies the same slot in a
different stack. *2026-08-13.*

**Anthropic's Product Management plugin.** First-party knowledge-work
suite; adjacent today, and we watch it each survey. No tracker
mirroring found as of this writing. *2026-08-13.*

**Agent IDEs (Cursor, Copilot Workspace, Devin).** The coding
environment itself. Cairn is the work-management layer that rides along
inside them — the installer wires Cursor explicitly. *2026-08-13.*

## Try it

```
/plugin marketplace add eventually-consistent-code/cairn2
/plugin install cairn
```

or, for any bare-MCP harness: `npm i @eventually-consistent/cairn-server`
— a fresh install boots the full tool surface with no extra setup
(smoke-tested from the public registry, 2026-08-14). Quickstart:
[docs/00-quickstart.md](00-quickstart.md). The proof behind the review
claims: [the council case study](case-study-council.md).
