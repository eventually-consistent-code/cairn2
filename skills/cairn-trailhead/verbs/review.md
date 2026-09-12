---
verb: review
args: "[target] | --fix"
status: live
---

Five-axis code review of a diff, branch, or phase — a fresh read against
the code as it stands, not a retro-check against old claims (that's
`audit`). Every review closes the same way: a record, then tracker issues
for anything that matters.

## Target resolution

| target | resolves to |
|---|---|
| (none) | the working diff — `git diff` plus whatever's staged |
| a branch name | the range between that branch and `main` |
| a phase number | that phase's ledgered commit ranges (read `LEDGER.md` for the phase — the base/head commits recorded there, not a guess at the range) |

No target means the working diff, full stop — don't go hunting for a
"more interesting" target when the caller didn't name one.

## The panel — the axes come from the roster

Call `seat_roster` once at dispatch: the valid seats, in roster order,
ARE the review panel — the axes are not hardcoded in this file. One
framing line to keep straight: internal seats are framing lenses —
cheap, same-model; `peers` remains the genuinely adversarial external
council. There is exactly one review path, and this is it.

With no project seats and no `seats` config block, the roster is exactly
the five shipped defaults, in this order — today's review, byte for
byte:

| seat | what it's looking for |
|---|---|
| correctness | logic errors, wrong edge-case handling, off-by-ones, state that can drift out of sync |
| clarity | code a future reader (or agent) will misread — misleading names, buried intent, comments that lie |
| architecture | the wrong layer doing the work, coupling that will bite the next change, reuse that got skipped |
| security | injection, auth gaps, secrets in the diff, trust boundaries crossed without a check |
| tests | claims the diff makes that nothing verifies — new behavior with no test, a test that can't actually fail |

A project-added seat (`.cairn/roles/*.md`) joins the panel where the
roster puts it, same rules as every default. A seat disabled in
`cairn.json` sits out with exactly one line in the record
("`<name>`: disabled by config — sat out"); an invalid seat file
likewise gets its roster note echoed as one line. Never silently shrink
the panel — the record shows every seat, seated or not.

**Dispatch — which seats fire this pass.** The dial defaults to `off`:
the full panel fires, exactly as above. On `auto`, derive scope signals
from the resolved diff per the standard vocabulary (`touches-auth`,
`touches-server`, `touches-docs`, `touches-tests`, `touches-config`,
`touches-ci`, `touches-scripts` from paths; `diff-small` under 50
changed lines, `diff-large` over 500 — the tested rules live in
`server/src/seats/signals.ts`) and seat only the seats whose declared
`signals` intersect the derived set. A seat declaring NO signals always
fires — declaring signals is how a seat opts into gating. Auto also
consults the per-seat yield store (`~/.cairn/yield/`, written after each
pass: per seat +1 dispatched plus its raised/surviving finding counts):
a seat with ten or more dispatches and fewer than one surviving finding
per ten gets gated on that evidence — never the security seat, never a
dose-`full` seat. `inherit` follows cairn.json `seats.dispatch`
(`seat_roster` returns it; absent means off). Every gated seat lands in
the record in ONE report line, never silently:
"seats gated this pass: X (no matching signals), Y (low yield)".
Custom signal names a project seat declares beyond the standard
vocabulary never fire this iteration — nothing derives them yet, so on
`auto` such a seat needs at least one standard signal (or none at all)
to keep its chair.

Walk the resolved diff against each seat's lens. A clean seat is still
worth a line in the record ("no findings") — silence isn't the same as
checked.

**Anchored score, beside the verdict — never a gate.** Each seat also
reports a 0-10 score on its own scale. At dispatch, quote the seat's
anchors (`anchor_ten` / `anchor_five` / `anchor_zero`) and its honesty
line verbatim from the definition file — defaults under
`templates/seats/`, project seats under `.cairn/roles/` (`seat_roster`
names each seat's source). The score lands beside that seat's findings
and the overall verdict in the record, and that's all it does: no
threshold hangs off it, no pass/fail derives from it, no finding gets
upgraded or downgraded because of it. When the seat's honesty line
applies — the evidence wasn't actually read — report `unscored`; an
invented number is worse than none.

Findings keep today's shape exactly. Every finding gets ranked
**critical**, **important**, or **minor**, and every finding names a
`file:line` and a concrete failure scenario — not "this could be a
problem" but the actual input or sequence that breaks it. A finding
without a scenario is a hunch, not a finding; downgrade it or cut it
before it goes in the record.

## Closing discipline — every review, no exceptions

1. For each finding rated **critical** or **important**: `issue_create`
   with label `cairn:review`, the severity as the literal first line of
   the body (`Critical: …` / `Important: …`), plain language a
   non-engineer could read cold — the scenario, not the stack trace.
2. **Minor** findings stay in the review record only. The record already
   has them; a tracker full of minors is a tracker nobody reads.
3. `audit_record(scope: "review-<target>", verdict, findings)` — every
   review ends here, clean or not. `<target>` is whatever resolved above
   (`working`, the branch name, or `<phase>`). Before using it in the scope,
   slug the target — lowercase it and collapse every run of characters
   outside `[a-z0-9]` to a single hyphen (e.g., `feature/ABC-123` becomes
   `feature-abc-123`, `HEAD~3` becomes `head-3`). A clean pass is still a
   finding worth recording — it's the proof the review ran.

Skipping the record because the diff looked fine is still skipping it.

## `--fix`

Only after the record exists and the critical/important issues are filed.
Same contract as `audit` — two shapes, and only two:

- **Mechanical** (the fix is obvious and small — a missing null check, a
  wrong comparison, a test that should've existed): fix it directly, one
  commit per finding, then `issue_comment` with a plain-language "what was
  wrong / what changed" note, then `issue_close`.
- **Investigation-shaped** (the fix isn't obvious, or touches more than
  the finding itself): open `trace_start` instead and hand it off — don't
  guess at a fix under review's roof.

Never an improvised inline fix for anything in between. Not clearly
mechanical means investigation-shaped by default — that's the safe side
to be wrong on.

## Mirror rules

Same discipline as `audit` and `trace`: plain language, no code blocks, no
file paths, no internal refs a non-engineer would bounce off of, on
everything that lands on the tracker. `file:line` and the failure scenario
belong in the review record, not the issue body — the record is for
engineers re-deriving the fix, the issue is for a manager triaging by
severity. The severity-first-line rule is the one place those two
audiences meet: it's the first thing both of them read.
