# Behavioral eval suite

The verb procedures are prose a model executes. 1400-odd unit tests
and five guards pin everything byte-comparable about the plugin; none
of them can ask "what does an agent actually DO with `/cairn:ship`
when the drift report is red?" This suite does. It runs under the
native `claude plugin eval` harness (early access as of Claude Code
2.1.267 — see Availability), against a mocked cairn server, and grades
judgment the guards cannot diff.

## The decision rule — guard vs eval

**Byte-comparable → guard. Judgment-under-execution → eval. Never
eval what a guard can diff.**

| Claim | Where it's checked |
|---|---|
| routing table ↔ verb files ↔ command shims agree | `scripts/check-surface.mjs` |
| tool count, version surfaces, diagram labels, dist freshness | `scripts/check-pins.mjs`, `check-versions.mjs`, `check-diagrams.mjs`, `check-dist.mjs` |
| review panel = five seats, in order, with these categories | `server/test/seats.test.ts` (byte-identical pin) |
| `do` confirms before a mutating verb, runs a read-only one directly, stays out of a plain question | `evals/01–03` |
| `mark` makes exactly one tracker call and never asks | `evals/04` |
| `ship` stops on flagged drift and leads with the flag's own line | `evals/05` |
| `review` writes the record before filing and never files a refuted finding | `evals/06` |

A structural claim added to an eval is a bug: move it to a guard. A
judgment claim added to a guard is a false pin: move it here.

## Layout

```
evals/
  01-do-confirms-before-mutating/   prompt.md + graders/*.md
  02-do-runs-readonly-directly/
  03-do-should-not-fire/            the should-NOT-fire case (required)
  04-mark-one-call-capture/
  05-ship-refuses-on-drift/
  06-review-records-before-filing/
  mocks/cairn/                      stand-in for the cairn MCP server
    _tools.json                     saved tools/list (data, not a pin)
    <tool>.md                       canned result per tool
  results/<timestamp>/              aggregate-result.json + report.html (gitignored)
```

Case floor (mirrors `claude plugin eval init`'s invariants): at least
one should-NOT-fire case; every case carries at least one OUTCOME
grader (a `regex`/`llm` on the final message or a `tool_used` with
`input_match`), never `tool_used` alone; `runs: 3`; the no-plugin
baseline arm (`--ablation with-without`, the default) stays on so
every score answers "did the plugin do this, or would the model have
anyway". Six cases now; ten is the ceiling before the suite splits by
verb.

## Running it

Always the **path** form, from the repo root:

```bash
claude plugin eval . --json --no-publish --max-cost-usd 3
claude plugin eval . --case '05-*' --runs 1 --max-cost-usd 1   # one case, one run
claude plugin eval . --tag trigger --max-cost-usd 2            # the trigger-rate set (#202)
```

Never `claude plugin eval cairn@cairn-dev`: the marketplace checkout
under the plugins directory is a separate clone pinned to the last
release tag, so the plugin-name form grades the STALE copy. The path
form loads the working tree.

`--case` matches the case's frontmatter `name`, not its directory, and
only the last `--case` flag counts — run one glob at a time. Bill the
run to the subscription, not a Console key: an exported
`ANTHROPIC_API_KEY` in the shell makes every spawned session use it
(`env -u ANTHROPIC_API_KEY claude plugin eval …` when the shell exports
one). `${CLAUDE_PLUGIN_ROOT}` substitutes inside plugin command bodies,
never inside a case prompt — a prompt that needs a plugin file goes
through the slash command, not a literal path.

Costs: every case runs three times in two arms with a haiku judge on
the `llm` graders — roughly $0.25–0.55 per with-plugin run in this
suite, so a full run lands near $6–8. `--max-cost-usd` is not optional here — the run
exits 2 on breach and skips the paid graders for the breaching run.

Exit codes: 0 every case ≥ `--threshold` (default 1.0); 1 below
threshold / load error / no cases / gate closed; 2 partial (cost
ceiling or auth); 130/143 interrupted.

Results: `evals/results/<timestamp>/aggregate-result.json` is the same
document `--json` prints — `cases[].arms.{with,without}[].graders[]`
plus `aggregates`; camelCase, additive-only. `report.html` beside it.

## Trigger-rate baseline

The `trigger`-tagged cases (`evals/10–19`) measure whether a
description catches the natural-language ask it should (`*-fires`) and
ignores the near-miss it shouldn't (`*-holds`). Graded on the Skill
tool's dispatch, in both arms, three runs each. First measurement,
2026-09-19 at 820454b, sandbox cwd empty (no `cairn.json`):

| Description | Should-fire rate | Should-NOT-fire hold rate | Note |
|---|---|---|---|
| `do` | 0/3 | 3/3 | The router is bypassed when intent is obvious — "what should I work on next" went straight to the status verb (outcome reached 3/3). Not a defect; a fact about routers. |
| `mark` | 3/3 | 3/3 | |
| `ship` | 3/3 | 3/3 | |
| `review` | 3/3 | 3/3 | One run fired but ran out of turns before `seat_roster`. |
| `cairn-planning` (skill) | — | 3/3 | Should-fire needs a cwd carrying `cairn.json` (case.yaml scaffold) — not measured yet. |
| `cairn-memory` (skill) | — | 3/3 | Same. |

Baseline arm (no plugin): every `*-fires` case 0/3, every `*-holds`
case 3/3 — the descriptions add triggers and take none away. A later
description edit is judged against this table: rerun with
`--tag trigger`, compare per row. Cost of the run: $9.26.

## Mocks

`evals/mocks/cairn/` replaces the real cairn server for the run: the
real one never starts, mocked tools are auto-allowed, unmocked tools
on that server are denied. Each `<tool>.md` body is the JSON the
server would have returned (`{{input.x}}` interpolates the call's
input). The stand-ins are deliberately opinionated — `plan_drift`
returns a `stale-audit` flag, `audit_record` returns one confirmed and
one refuted finding — because the cases grade what the verb does with
an inconvenient answer, not a happy path.

`_tools.json` is the saved `tools/list` from `node server/dist/index.js`
(regenerate it after any `registerTool` change — it is data the mock
serves, not a count assertion; the two sanctioned tool-count pins stay
in `server/test`).

## Availability

`claude plugin eval` is early access, enabled per organization. When it
isn't enabled the command prints "`plugin eval` is currently in early
access" and exits 1 — it exists, it's gated. Self-test: run it in an
empty directory; "No eval cases found" means enabled. Clients that
cannot fetch server-side flags (Bedrock/Vertex/Foundry, LLM gateways,
telemetry-disabled clients, CI runners) use an enablement environment
variable provided during onboarding, set in the shell / CI environment
or `~/.claude/settings.json` `env` — never a repo's `.claude/settings.json`,
which the CLI does not trust for it. This doc does not name the
variable: obtain it through your Anthropic contact.

## CI lane

An allowed-to-fail workflow (`.github/workflows/evals.yml`) runs the
suite nightly (06:17 UTC), on manual dispatch, and on changes under
`skills/**`, `commands/**`, `evals/**`, `.claude-plugin/**`. It uploads
`evals/results/**` (aggregate JSON + report) as a 14-day artifact and
NEVER blocks a merge — `continue-on-error: true`; a stochastic lane
earns a blocking threshold only after its variance baseline exists.
The threshold starts at 0.7 and rises toward 1.0 as green nights
accumulate; the cost ceiling is $12 per run (the full suite plus the
trigger set costs ~$15 at three runs, so the lane trims by cost before
it trims by threshold — narrow with `--tag` if that bites).

Two repository secrets, both owner-set, neither assumed by the
workflow (it exits 1 with a plain message when the key is missing):

- `ANTHROPIC_API_KEY` — bills the eval sessions to a Console account.
  Subscription auth does not exist on a CI runner.
- `PLUGIN_EVAL_ENABLEMENT` — the early-access enablement assignment
  for hosts outside the per-organization rollout, as one `NAME=1`
  line. The workflow `export`s it, so the variable's name never enters
  the repo. Obtain it through your Anthropic contact (Availability).
