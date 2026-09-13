# 0010 — Default seats fold into review, byte-identically

Date: 2026-09-11. Status: accepted.

## Context

Adding a roster mechanism to an existing review verb risks two
regressions: a second parallel review path (the old hardcoded axes plus
a new panel), and silent behavior drift for every project that never
configures a seat.

## Decision

Fold, never stack. Review's five axes and the seat-shaped audit lenses
ARE the default roster entries — the same five viewpoints, now data.
With no seats configured, the composed panel reproduces the previous
hardcoded behavior exactly, and a regression test pins the no-config
roster byte-for-byte (names, order, content). Anchored 0-10 scores land
BESIDE pass/fail verdicts as calibration signal; they never replace or
gate verdicts. Internal seats are framing lenses — cheap, same-model;
the external peers council remains the genuinely adversarial mechanism.
One review path exists.

## Consequences

- Zero migration: unconfigured projects see identical output.
- Any future edit to a default seat is a visible, reviewable data
  change that trips the byte-identical pin.
- The lenses-vs-council distinction is stated wherever both appear,
  preventing a second council from growing by accident.

Commits: a2dfab7 (fold), 8d213b6 (wave-brief reuse).
