# Verification record

## Tier 0 — Trailhead (2026-07-15)

### Surface conformance
- `node scripts/check-surface.mjs` → clean: 11 live, 17 reserved, 23 server
  tools. All five detector classes verified against seeded breakages
  (missing live subroutine, reserved-verb file, unknown tool reference —
  each produced the expected named failure, then restored to clean).
- Server untouched: `npx vitest run` 217 passed / 6 skipped; `tsc --noEmit`
  clean after every task.

### Always-present token footprint (method: `ceil(chars/4)` over each
registered command's `description` + `argument-hint`)
| state | cost |
|---|---|
| before (7 command files) | ~172 tok |
| after (entrypoint + 7 shims, transition period) | ~213 tok |
| post-P5′ cutover (entrypoint only) | ~23 tok |

Stated plainly: during the shim transition the always-present cost is ~41
tokens HIGHER (one extra registered command). The 86% reduction (172 → 23)
lands when shims are removed at P5′. The structural win (subroutine bodies
and routing table load only on invocation) applies now.

### Deviations from plan
- Plan said 16 reserved verbs / 27 table rows; the Tier 0 spec's verb table
  counts 17 / 28. Spec is authoritative; implemented 17/28 and corrected the
  plan doc.

### Dogfood drill — PENDING (needs a live session with cairn2 installed)
Steps to run: install cairn2 as a local plugin; in a scratch repo with
`cairn.json` configured against a real tracker: `/cairn new` → `/cairn plan 1`
→ `/cairn work 1` → `/cairn verify 1` → `/cairn ship`; plus
`/cairn do "what's the status"` (expect: routes to status, runs without
confirmation) and `/cairn wrok` (expect: help with "did you mean work?").
Record results here.
