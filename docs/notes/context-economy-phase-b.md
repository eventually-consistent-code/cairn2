# Context economy, phase B — killed at the gate

**Date:** 2026-09-29
**Outcome:** stop. The autocompact threshold is not lowered. `autocompactPct`
stays unset, which leaves the harness default alone.

## What phase B was going to do

Drop the autocompact threshold to 0.2 — compact at 20% of the window instead
of the harness default — and measure whether crossing boundaries that much
more often degraded the work. The simulation over recorded sessions predicted
average context falling from roughly 229k toward 116k, with `over500k` going
to zero. That number is where the plan's 50% claim came from.

## What actually happened

The operator ran a session at the low threshold and reported that it caused
massive problems doing ordinary work. The threshold was abandoned during that
session rather than carried to the end of a measured piece of work.

**This is a field report, not a measurement.** Stating plainly what does not
exist, because a later reader will otherwise assume it does:

- No boundary analysis was run against that session's transcript.
- No symptom count was taken, so there is no symptom-to-denominator ratio.
- No post-run rent comparison against the baseline exists.
- No false-positive list exists, because no detector output exists.

So the quantitative comparison phase B was built to produce is simply absent.
What replaced it is the one input the plan named as outranking all the
detectors.

## The gate

The gate was amended after phase A, when the whole-branch review found the
symptom detector had been blind to string-shaped prose and its reassuring
"0 symptoms" meant nothing. That amendment added a fourth rung and made it
the highest:

> **Your own judgement outranks all three.** You ran the session. If the work
> felt degraded — repeating yourself, re-establishing context, the model
> losing the thread — that is evidence the detectors cannot see, and it counts.

The gate fired on that rung. It is the weakest rung evidentially and the
strongest rung in authority, and that ordering was deliberate: the detectors
can only see repeated wording, and the amendment had just finished proving how
little they see.

## Why killed rather than tuned upward

The written kill criterion allowed for retreat instead of abandonment — raise
the threshold to 0.3, then 0.4, repeat, and record the saving at whatever
level quality allows. That path was not taken, for two reasons.

The saving only ever came from compacting *aggressively*. Each step back
toward the default gives up most of the predicted benefit, so the reasonable
end of the range is worth a fraction of the 50% while still costing a full
measured session per step to establish.

And a threshold that makes ordinary work unpleasant does not get adopted, so
its simulated saving is fiction whatever the number says. A context economy
measure nobody will run at is worth nothing.

## What stands, what does not

**Does not stand:** the 50% claim. It was a simulation over recorded sessions
and it has no supporting session. Nothing downstream should cite it.

**Stands:** everything the threshold machinery does. `thresholdDrift`, the
`contextEconomy.autocompactPct` config key, and the drift report in
`config_probe` are correct, tested and shipped. They report honestly when the
live threshold disagrees with the desired one — including reporting that
nothing is set, which is the current and intended state.

**Stands, and matters more now:** the two detector findings from phase A.
`detectSymptoms` matches repeated wording, not repeated meaning, so a symptom
is strong evidence of harm and its absence is weak evidence of safety. Any
future report using it must publish the denominator beside the count.

## Verified at kill time

Nothing was left applied anywhere:

- `cairn.json` — no `contextEconomy` block.
- Session environment — `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` absent.
- Machine-wide and project Claude settings — no env entry for it.
- `server/src/config.ts` — `autocompactPct` defaults to `null`, documented as
  leaving the harness default in place.

cairn reports drift against this setting. It has never set it, and after this
result it has no reason to.

## For whoever picks up phases C, D and E

Phase B was written as their gate. That gate is resolved as stop, not left
hanging — C, D and E are unblocked and inherit no failed precondition.

All three reduce what goes *into* the context window rather than changing when
the window gets cut: C is the band signal in the statusline and
`additionalContext` plus the subagent report cap, D is bounded loops, E is the
context guard. None of them needed phase B to succeed.

The useful thing phase B established is negative and worth carrying forward:
buying context economy by compacting harder is off the table here. That raises
the value of every approach that does not, which is all of them.
