# 0012 — One finding set, no matter how many seats

Date: 2026-09-11. Status: accepted.

## Context

Multiple viewpoints over one target rediscover the same defects. If
each seat's findings flow to the tracker independently, a five-seat
panel turns one bug into five issues — noise that erodes the
mirrors-everything principle the tracker discipline depends on.

## Decision

Deduplication is a hard requirement and runs BEFORE severity ranking
and issue creation, in both review's and audit's closing disciplines.
Findings merge when they name the same file, sit within a two-line
window of the cluster's anchor (anchored to the lowest line so windows
never chain-drift), and make the same claim — exact normalized-text
fast path, else token-overlap similarity at or above one half. The
merged finding credits every raising seat by name with each seat's
score attributed, keeps the highest severity, and takes its canonical
wording from the highest-severity raiser. Distinct claims at one
location stay separate. Output order is deterministic. The engine is a
pure dependency-free library — no new tool surface.

## Consequences

- N seats never means N issues; tracker noise is bounded by real
  defects, not roster size.
- Seat crediting preserves the yield statistic's input (which seats
  actually surface surviving findings).
- Determinism makes dedup testable under shuffle and safe to re-run.

Commits: b031a97 (dedup engine and closing-discipline wiring).
