---
verb: peers
args: "(none = status) | review [target] | plan <phase>"
status: live
---

Convene the external AI CLIs (codex, opencode, antigravity, grok) as
reviewers — a second (third, fourth) opinion on top of cairn's own
judgment, never a replacement for it. `peer_run` moves bytes to a peer and back; everything
below is the loop that decides what a peer's answer is actually worth.
**A peer saying something doesn't make it true** — every peer finding gets
verified against the code (or the plan) before it goes anywhere near the
tracker.

## Focus ask (before either mode runs)

Before `review` or `plan` dispatches anything, ask ONE AskUserQuestion:
what should the peers focus on? Options are concrete candidates cairn
derives from the target (for `review`: the axes or hotspots the resolved
diff actually touches; for `plan`: the phase's stated goal and its riskiest
tasks), with "full pass — no particular focus" as the first, recommended
option; free text arrives via the built-in Other. The chosen focus is
woven verbatim into every peer prompt AND into cairn's own first pass, so
the whole run targets what the user cares about instead of a generic
sweep. One question, asked once per run — never re-asked between rounds,
never asked at all for bare `peers` (status is read-only).

## Run state (both modes)

A `review`/`plan` run is stateful so it survives interruption. At
dispatch — right after the focus ask — call `peer_state(op: "start")`
with the run's slug, mode, target, chosen focus, and the roster
`peer_list()` reported available. From there the store is the run's
memory, not the conversation: every `peer_run` reply lands via
`op: "record_output"` (verbatim, per peer per round), every
`parseFindings` result via `op: "record_findings"` (stable ids f1,
f2, ...), and every adversarial judgment via `op: "verdict"` —
`verified`, `dead`, `disputed`, or `open-disagreement` — the moment
it's made, never batched for later. `op: "close"` ends the run: it
refuses to close while any finding is still disputed or unjudged, and
its summary is the ONLY source for the `audit_record` findings —
provenance ("raised by <peer> round <n>; verdict <v>") assembles from
the records, never from what the conversation remembers. `start`
refuses a slug that already has an unfinished run — resume it (below)
or `op: "abandon"` it explicitly; nothing gets silently clobbered.

### Resuming an interrupted run

A run that died mid-flight (crash, `/clear`, timeout) resumes instead
of restarting: `peer_state(op: "status")` reports what's recorded and
what's missing — peers with no round-1 output, disputed findings whose
peer hasn't answered round 2, findings not yet at a final verdict.
Re-run only the missing pieces, recording as usual, then continue the
normal flow to `close`.

## Bare `peers` — status

`peer_list()` rendered plainly: provider, on PATH or not, enabled or not,
input cap. No workspace-wide judgment here, just the facts a caller needs
before deciding whether `review`/`plan` will have anyone to talk to. Zero
peers on PATH is a normal result, not a warning — say so and stop; don't
suggest installing anything unasked.

## `peers review [target]`

1. Run cairn's own five-axis review FIRST, in full — same target
   resolution, same five axes, same finding discipline as the `review`
   verb. This is not optional and not skimmed: peers augment cairn's
   review, they don't stand in for it.
2. **Leak-scan the outbound content** (see below) before step 3 ever
   touches a peer.
3. For each peer `peer_list()` reports on PATH and enabled: `peer_run` with
   the ask built from the `findings-request` template
   (`templates/peers/findings-request.md`, filled via the server's
   `loadTemplate` — `focus` = the chosen focus verbatim, `dimension` = the
   axis this pass targets or "full pass", `content` = the leak-scanned
   diff). The template carries the whole structured contract — fenced-JSON
   findings matching the server's Finding schema — so nothing gets
   re-worded per run. Record each reply the moment it lands
   (`peer_state` `record_output`), then split it with `parseFindings`:
   validated `findings` plus verbatim `unparsed` leftovers — the
   `findings` pile goes straight into `record_findings`. Judge BOTH
   piles in step
   4 — off-schema prose in `unparsed` can still hold a real finding; it
   just arrives without the contract's guarantees. No peer on
   PATH → skip straight to step 6; that's proceed-without, not a stall.
4. Judge every peer finding adversarially against the actual code — not
   against what the peer says the code does. A peer claiming a bug that
   the code doesn't actually have is a finding that dies right here, never
   reaching the tracker. A peer surfacing something cairn's own pass
   missed is a real finding, provenance and all. Record each judgment
   as it's made (`peer_state` `verdict`): dies-right-here is `dead`, a
   verified survivor is `verified`, anything unsettled is `disputed`.
5. Converge: round 2 runs ONLY over material disagreements — a peer
   standing by a finding cairn's first pass disputed, or a peer citing
   something the round-1 verification didn't settle. Round-2 sends use the
   `round2-steelman` template (`templates/peers/round2-steelman.md`, same
   slots; `content` = the peer's disputed finding plus cairn's
   counter-read), which forces a verdict — concede, refute with NEW
   evidence, or stand by with stated confidence — instead of a free-form
   rehash. Hard cap at two
   rounds, no exceptions; a peer that still disagrees after round 2 gets
   noted as an open disagreement in the record, not a third round.
   Round-2 replies get `record_output` (round 2) like any other, and
   every disputed finding ends the round re-judged: `verified`, `dead`,
   or `open-disagreement`.
6. Survivors follow `review`'s exact closing discipline: `issue_create`
   with label `cairn:review`, severity as the literal first line, plain
   language a non-engineer could read cold. Add provenance the plain
   review never carries — which peer(s) raised it, which round it
   survived to.
7. `peer_state(op: "close")`, then `audit_record(scope:
   "peers-review-<slug>", verdict, findings)` with the verdict and
   findings exactly as close's summary returned them — `<slug>` follows
   `review`'s exact slugging rule (lowercase, collapse
   every run of non-`[a-z0-9]` to one hyphen), the same slug the run
   started under. Crediting provenance in the
   record is what makes this run distinguishable from a plain `review` —
   which peers ran, which rounds, what survived versus what got thrown
   out under adversarial check.

## `peers plan <phase>`

1. Leak-scan the phase's `PLAN.md` content (see below) before it goes to
   any peer.
2. For each available peer: `peer_run` with the plan content (cap-aware —
   a constrained peer gets truncated input, not a skipped run), asking for
   critique against the phase's stated goal. Same recording discipline
   as `review`: `record_output` per reply, `record_findings` for the
   parsed pile.
3. Judge each critique adversarially — verify it against the actual
   PLAN.md and phase context before it counts as material, same rule as
   `review`: a peer's opinion is a claim, not a finding, until checked.
   Record each verdict as it's made, same vocabulary as `review`.
4. Converge, same two-round hard cap as `review` — round 2 only for
   critiques cairn's own judgment disputed in round 1.
5. Material, verified critiques become plan edits directly when the call
   is unambiguous; route to a `cairn:audit` issue instead when the plan's
   owner should decide (a scope call, a tradeoff, anything opinionated
   enough that cairn shouldn't silently rewrite the plan out from under
   the person who wrote it). If a converged critique makes an already-open
   `cairn:audit` issue moot, `issue_comment` explaining why, then
   `issue_close` — a resolved question doesn't get to sit open.
6. `peer_state(op: "close")`, then `audit_record(scope:
   "peers-plan-<phase>", verdict, findings)` sourced from close's
   summary — `<phase>` is the phase number/slug as it appears in the
   routing table, same provenance requirement as `peers review`.

## Outbound leak gate (hard rule)

Peer input is code or plan content leaving this machine for an external
CLI. Before EVERY `peer_run` call, in either mode above, scan the exact
content about to go out against the leak patterns
(`hooks/scripts/leak-patterns.mjs` — the same source the commit-time leak
guard and `distill`'s scrubbing gate consume, applied here to outbound peer
input instead of a git diff). A hit STOPS the send: name the matching
lines to the user and let them decide whether to redact and retry or skip
that peer entirely. This is never a soft warning that gets sent anyway —
a hit blocks that `peer_run` call, full stop, until the user says
otherwise.

## Absent peers

Zero peers on PATH, or every peer disabled in `cairn.json`, is a normal
outcome: proceed with cairn's own review/plan judgment alone, say plainly
that no peers were available, and record the run exactly as usual. A
missing external CLI NEVER blocks `review` or `plan` from completing —
peers are an augmentation, and the verb's job is to degrade gracefully to
"cairn reviewed this alone" rather than stall waiting on a CLI nobody
installed.

## Mirror rules

Same discipline as `review`, `audit`, `trace`, `triage`, and `basecamp`:
every `issue_create`/`issue_comment` body is plain language, no code
blocks, no file paths, no internal refs a non-engineer would bounce off
of. Peer names and round numbers are fine in the tracker body (provenance,
not internals) — file:line and the verification detail stay in the
`audit_record`, same audience split `review` already draws.
