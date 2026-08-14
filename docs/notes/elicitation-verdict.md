# Elicitation adopt/park verdict (#99)

**Verdict: PARK** — with a concrete re-check trigger below. Server-side cost
is near zero (the SDK is ready today); the missing half is client support
across the seven non-Claude harnesses, and building against zero proven
clients buys us a forked code path and no users.

## What the pattern offers (post-2026-07-28 spec)

Elicitation is the protocol's structured ask-the-user primitive, and the
2026-07-28 revision made it practical for servers like ours:

- A `tools/call`, `prompts/get`, or `resources/read` handler can now return
  `resultType: 'input_required'` instead of a final result — the client
  collects the answer and re-drives the request. No long-lived server→client
  session needed.
- Form mode (`ElicitRequestFormParams`) carries a JSON Schema for the
  question — single/multi-select enums, typed fields — which is exactly the
  AskUserQuestion shape. URL mode exists too (browser handoff).
- The installed v2 SDK (`@modelcontextprotocol/server` ^2.0.0) supports all
  of it: the `inputRequired.elicit()` builder, schema validation, and a
  legacy shim that serves 2025-era clients by re-entering the handler
  server-side (`inputRequired.maxRounds`, `INPUT_REQUIRED_ROUNDS_EXCEEDED`),
  so one handler serves both protocol eras. Server support is a solved
  problem — we checked the type defs, it's shipped.

## What cairn would use it for

AskUserQuestion parity outside Claude Code. Today the proposal gates and
interviews (`new`'s project interview, `plan`'s depth/scope gate, `route`
confirmations) are verb-markdown driven: Claude Code renders them through
AskUserQuestion, every other harness falls back to plain conversational
text. Elicitation would let the *server* pose those questions with typed
options, uniformly, in any harness whose MCP client implements it — the
gates become structured everywhere instead of structured-in-one-harness.

## What adopting would cost

- **Client reality is the blocker.** Of the 8 harnesses (Claude Code, Grok
  Build, Copilot CLI, Codex, Gemini CLI, Cursor, OpenCode, Zed), we have
  verified none advertise the elicitation client capability today, and
  `input_required` fulfilment (2026-era) is newer still. Honest uncertainty:
  we have not audited each client's MCP stack version — but "unknown, likely
  sparse" is the working assumption, and the SDK's shim only helps for
  clients that at least handle server→client elicitation requests.
- **Architecture inversion.** Cairn's gates live in verb markdown, not in
  the server — the server is deliberately question-free. Moving interviews
  server-side means every gate grows an elicit path plus the existing text
  fallback (capability-sniffed), roughly doubling the surface for flows
  that already work everywhere today.
- **Testing/maintenance.** New InMemoryTransport elicitation fixtures, plus
  per-harness manual verification we can't automate.

## Re-check trigger

Revisit (open a fresh issue) when either fires:

1. Two or more non-Claude harnesses ship verified client-side elicitation
   or `input_required` fulfilment — check with a 10-minute capability probe
   (`client.getServerCapabilities` counterpart at connect time) per harness.
2. A gate/interview demonstrably misfires in a non-Claude harness (wrong
   answer shape breaking a proposal flow) — that turns "nice parity" into
   "correctness fix" and changes the math.

Until then: the verbs' plain-text fallback is universal, honest, and
shipped. Park it.
