<!--
  Peer prompt template — round 2 convergence (steelman) over a disputed
  round-1 finding.
  Slots (filled by the server's loadTemplate; every {{slot}} occurrence is
  replaced, an unfilled slot is left verbatim so the gap shows):
    {{focus}}     — the run's chosen focus, unchanged from round 1
    {{dimension}} — the review dimension/axis this pass targets
    {{content}}   — the disputed material: your original finding AND the
                    reviewing agent's counter-read of the same code/plan
-->

Round 2. In round 1 you raised a finding; the reviewing agent verified it
against the actual material and disagreed. Below are both sides — your
original claim and the counter-read.

Focus for this run: {{focus}}
Review dimension: {{dimension}}

## The disagreement

{{content}}

## Your job

First, steelman the counter-read: state the strongest honest version of
the case against your finding, in one or two sentences. Then pick exactly
one verdict:

1. `concede` — the counter-read is right; your finding is withdrawn.
2. `refute` — you stand by the claim AND you can cite **new** evidence, an
   evidence location not present in your round-1 finding. Restating round-1
   evidence louder is not a refutation; a refute without new evidence will
   be treated as `stand-by`.
3. `stand-by` — you still believe the finding but have no new evidence.
   State your confidence honestly; a low-confidence stand-by is a useful
   signal, not a failure.

Reply with a single ```json fenced object in exactly this shape:

```json
{
  "verdict": "concede | refute | stand-by",
  "steelman": "the strongest version of the case against your finding",
  "newEvidence": "refute only — the NEW evidence location, e.g. file:line",
  "confidence": "high | medium | low",
  "reasoning": "one or two sentences on why you landed here"
}
```

This is the final round — there is no round 3. An unresolved disagreement
gets recorded as exactly that, so make this answer your best one.
