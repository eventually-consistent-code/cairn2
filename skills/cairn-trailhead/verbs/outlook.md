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

1. `outlook_get()` — one card per registered project: snapshot (phase
   table, open-session counts, verb-supplied tracker block), staleness
   verdict, or `{name, error}` when that project couldn't be read.
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

Reserved for the drill-in iteration (#91): match by name (substring,
case-insensitive) against registry entries; ambiguity lists the matches.
Until #91 lands, bare-board plus a note that drill-in is coming is the
honest render — don't fake depth the snapshot doesn't have.
