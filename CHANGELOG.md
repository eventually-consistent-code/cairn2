# Changelog

## v2 — survey verb: project-wide research (2026-07-30)

- New `/cairn:survey ["<topic>"]`: project-wide research into a resumable
  `SURVEY.md` (scout's done/pending markers), a hard discussion gate, then
  approved roadmap changes applied via route mechanics (decimal phase
  insert — never renumber, locked-decision CONTEXT.md edits, mirrored
  issues). Composition of existing tools; no server changes (38 verbs).
- Research fan-out is now mandatory and multi-agent for `scout`, `survey`,
  and `plan --deep`: one subagent per pending topic, model routed per the
  work class of the topic (mechanical → haiku-tier, synthesis →
  sonnet-tier, judgment → opus-tier); sections commit as each agent
  finishes, so a killed run keeps everything completed.
- `/cairn:new` now recommends `/cairn:survey` before `/cairn:plan 1` —
  whole-project research is cheapest when nothing is planned yet.

## v2 — Confluence documentation connector (2026-07-24)

- Docs connector SPI: normalized `DocsConnector` interface, capability
  flags, registry with per-connector validation, and an optional docs
  config block — pluggable for future Notion / GitBook / Slite / SharePoint
  adapters.
- Confluence adapter: Cloud v2 REST client, Atlassian token auth,
  body-cursor pagination, and a dependency-free markdown → storage-format
  converter that degrades gracefully.
- Publishing: README becomes the project landing page inside a
  folder named for the project; the docs tree becomes child pages with
  generated contents sections; re-publish updates in place (identity =
  title + ancestry, space-wide title conflicts auto-disambiguated).
- Surface: `docs_publish` / `docs_status` server tools and the `docs` verb
  (65 tools, 37 verbs); config writes rebuild connectors without restart.
- Testing: shared docs-connector behavioral contract, in-memory fake
  enforcing production constraints, in-process tool tests, env-gated live
  suite — 555 passing tests.
- Fixes from live dogfooding: unbalanced list markup on multi-level indent
  jumps; space-wide title-collision handling. Also fixed: tracker
  connections now rebuild after config edits instead of holding stale
  backends.

## v1 — Marketing launch (2026-07-24)

- Projects section on eventually-consistent.io with cairn overview,
  competitive positioning, and quick-start pages; repository made public.
