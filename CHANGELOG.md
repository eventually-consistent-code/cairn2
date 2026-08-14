# Changelog

## v2.3.0 — release integrity (2026-08-14)

- One answer to "what version is running where": `config_probe` reports the
  running server, plugin-cache, repo-file, and npm-latest versions with
  plain-language drift lines ("installed vX, available vY"), and
  `cairn-setup --check` walks every harness install surface read-only —
  version stamps are now written alongside every installed artifact — and
  exits non-zero when anything lags, so it can gate.
- The release itself became one command: `scripts/release.mjs
  <version|patch|minor|major>` bumps all four version surfaces (three
  version files + the marketplace pin) atomically with a changelog
  scaffold, and refuses outright when the surfaces already disagree.
- CI now enforces version agreement on main before any tag exists
  (`scripts/check-versions.mjs` — includes the marketplace pin and a
  runtime-dep mirror check), and the publish workflow's tag gate covers
  `.claude-plugin/plugin.json`, which was previously checked by nothing.
- The plugin channel stopped depending on luck: the marketplace source is
  pinned to the release tag (installed = released, replacing the mutable
  working-tree clone), and a root lockfile makes Claude Code's installer
  actually materialize the server's dependencies in the versioned cache —
  closing the failure class where an installed plugin's MCP server died on
  a missing package.
- Publish workflow triggers only on release-shaped tags (vX.Y.Z); milestone
  tags no longer fire spurious runs.

## v2.2.0 — the planning intelligence + the product council (2026-08-13)

- `/cairn:peers council [dimensions]`: external AI reviewers judge the
  PRODUCT — functionality, look-and-feel, market position, and code —
  with rubric-anchored dimension scorecards, evidence packets screened by
  the leak gate, clustering convergence with a steelman round, a typed
  recommendations report (COUNCIL.md) behind the shared proposal gate,
  and a persistent dispositions table so rejected ideas don't come back
  without new evidence. Proven by a live council reviewing cairn itself.
- Peers runtime hardening from that council's own findings: reviewers run
  contained by default (scratch cwd holding only their packet; read-only
  sandbox flags where the CLI supports them; project access is an
  explicit `execCapable` grant), fan-out throttles to a resource-aware
  concurrency budget (`peerFanout.maxConcurrent` override), convergence
  state survives interruption and sources audit provenance from records,
  and the finding format is a validated schema with tolerant parsing and
  reusable prompt templates.
- The map is a first-class queryable surface: `map_query` (multi-hop BFS,
  AND-combined type/label filters), freshness metadata
  ({builtAt, updatedAt, generation}), edge-safe `edgesAdd`/`edgesRemove`
  patching (wholesale replace is rebuild-only), and plan/scout/survey now
  read the map when one exists.
- Research checkpoints are parsed, not trusted: `research_sections`
  validates one marker grammar for scout/survey/council (a typo'd marker
  is a named error, never silently done), with realpath containment and
  atomic validated flips. Survey runs are dated epochs with a recorded
  proposal→decision→artifact dispositions footer, behind a single shared
  proposal-gate spec.
- Errors speak human first: 4xx tracker rejections get an honest
  `TRACKER_REJECTED` code with body-derived next actions (5xx stays
  TRACKER_DOWN), and every verb renders a plain-language line + next
  action before the typed detail. `ship` now confirms before pushing
  (one-line summary, push/hold; `ship.confirm: false` restores silent).
- Peer roster: Antigravity (`agy`) replaces Gemini; every peer runs from
  a deterministic cwd with verified invocation conventions; opencode
  latency diagnosis baked into its timeout hint.
- 75 typed MCP tools, 1016 passing tests, three mechanical drills
  (peers 15, council 20, map 11 checks).

## v2.1.0 — ship the backlog (2026-07-31)

- New `/cairn:survey ["<topic>"]` verb: project-wide research into a
  resumable `SURVEY.md`, a hard discussion gate, then approved roadmap
  changes applied via route mechanics (decimal phase insert, mirrored
  issues); `/cairn:new` now recommends survey before `/cairn:plan 1`.
- Research fan-out is now mandatory and multi-agent for `scout`, `survey`,
  and `plan --deep`: one subagent per pending topic, model routed by work
  class (mechanical/synthesis/judgment); sections commit as each agent
  finishes, so a killed run keeps everything completed.
- Decimal phase numbers land server-side: `plan_scaffold_phase` /
  `plan_phase_ensure` accept N.1–N.9 fractional inserts without
  renumbering; status/import/continuity round-trip them, and invalid
  numbers return structured `CONFIG_INVALID` errors.
- Ninth and tenth tracker backends: Linear (GraphQL CRUD, native issue
  links, phases-as-Projects) and a zero-credential Local (maildir) adapter
  backed by a pure graph module (ready frontier, effective priority,
  dangling-edge detection), plus `tracker_migrate` to promote a local
  project to a hosted backend.
- Docusaurus docs connector (filesystem adapter, native TOC) joins
  Confluence; a docs honesty pass adds the Atlassian scoped-token caveat,
  retires the connector-expansion promise, and reorders the quickstart
  GitHub-first.
- Cairn now runs beyond Claude Code — Grok, GitHub Copilot, Codex, Gemini,
  Cursor, OpenCode, and Zed adapters — alongside tracker surface growth
  (issue attachments, Jira sprint/estimate fields, custom status
  vocabulary) and hardened npm publish/CI (OIDC trusted publisher,
  dist-freshness + tag-version-match gates).
- Counts: 38 verbs, 71 tools, 766 tests.

## v2 — survey verb: project-wide research (2026-07-30)

- New `/cairn:survey ["<topic>"]`: project-wide research into a resumable
  `SURVEY.md` (scout's done/pending markers), a hard discussion gate, then
  approved roadmap changes applied via route mechanics (decimal phase
  insert — never renumber, locked-decision CONTEXT.md edits, mirrored
  issues). Composition of existing verbs plus targeted server support (38 verbs).
- Decimal phase numbers land server-side to back route's `insert <N.5>` and
  survey's apply stage: `plan_scaffold_phase` / `plan_phase_ensure` accept
  one fractional digit (N.1–N.9), dirs sort as `01.5-slug` between
  neighbors, status/import/continuity round-trip them, and invalid numbers
  return structured `CONFIG_INVALID` errors (766 tests).
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
