---
verb: outlook
args: "[<project>]"
status: live
---

The portfolio view — every cairn project on this machine on one board,
from the snapshots each project already writes about itself. Aggregation
never opens a project or touches a tracker: the registry and the mirror
snapshots are the whole read surface, so the board renders in one call
even when half the fleet is broken.

## Bare `outlook` — the board

1. `outlook_get(artifact: true)` — one card per registered project:
   snapshot (phase table, open-session counts, verb-supplied tracker
   block), staleness verdict, or `{name, error}` when that project
   couldn't be read. `artifact: true` also refreshes the shareable
   written board at the returned `artifactPath` (machine-level, NOT
   in-repo — a committed fleet board would leak every project's name
   into one repo); mention the path in the render so the user knows
   where the shareable copy lives.
2. Render per-project cards, basecamp-board spirit: project name, where
   it stands (highest verified phase / next planned phase from the
   snapshot's phase table), open-session counts, the tracker block's
   open/in-progress/blocked numbers when present, last activity
   (snapshot `ts`).
3. Staleness is a flag, not an apology: `stale: true` cards show the
   `staleReason` (repo moved since snapshot) in one short line. A
   project with no snapshot yet renders its card with the error line
   the tool provides — flagged, not hidden (basecamp convention).
4. Close with a one-line rollup: N projects, M current, K stale,
   J unreadable.

Manager language throughout — same leak-guard discipline as the tracker
mirror: no file paths in the rollup line, no internal jargon on cards.
The paths ARE on the cards (they're how the user disambiguates two
same-named repos) — keep them, but lead with the name.

Empty registry is not an error: explain that projects self-register the
first time cairn's server starts in them, and that visiting a project
with any cairn verb is enough to put it on the board.

## `outlook <project>` — drill-in

1. `outlook_get()` and match `<project>` against card names (substring,
   case-insensitive). Ambiguous → list the matches and stop; no match →
   list what IS registered.
2. Render the one card in full: complete phase table (number, name,
   planned/verified, issue count), open sessions by kind, the tracker
   block (counts, suggested next verb, as-of date), last activity, and
   the staleness line with its reason when stale.
3. Depth honesty: the snapshot is everything the drill-in knows — it
   does NOT open the project or its tracker. When the card is stale or
   thin, say so and point at the real fix: run any cairn verb in that
   project (or the lifecycle gates) to refresh its snapshot. Don't fake
   depth the snapshot doesn't have.
