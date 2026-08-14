---
verb: ship
args: ""
status: live
---

Pre-ship gate, then ship:

1. `plan_drift()` — anything flagged: **stop** and report; do not push.
2. `plan_status()` — every phase with VERIFICATION.md must show all its issues
   closed (`issue_get` spot-check); report any still open and stop.
3. Engineer mode only (`user.mode: engineer` in cairn.json): no
   cairn-authored PR may still be awaiting human review — list any that
   are and stop. Human review is the merge gate; ship never overrides it.
4. Clean gate → commit outstanding plan-doc changes, then confirm before
   pushing: render a one-line summary of exactly what's about to happen —
   `N commits → origin/<branch>`, plus any tracker mutations the gate itself
   performed (reassignments, ledger repairs) — and ask ONE AskUserQuestion
   (push / hold). Push only on "push"; on "hold", stop and report.
   `ship.confirm: false` in cairn.json skips the ask (silent flow).
   After the push: `outlook_emit(tracker: {open, inProgress, blocked,
   nextVerb, asOf})` FIRST — the snapshot outlives the handoff, so the
   board still knows where this project stands after the session state is
   wiped — then `continuity_clear()` (shipping ends the session), and
   (if the project uses PRs) offer to open/update one.

   > Provenance: adopted from the 2026-08-12 product council (REC-5),
   > accepted by the project owner over cairn's no-action recommendation.
   > Vibe mode's silent-judgment rule explicitly does NOT apply to this ask.

Never push with flagged drift or open issues on a verified phase.
