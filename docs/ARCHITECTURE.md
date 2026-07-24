# Architecture

Cairn is a Claude Code plugin backed by a TypeScript MCP server. The plugin
layer (commands, skills, hooks) owns policy and judgment; the server owns
every mechanism with a wrong answer — state transitions, tracker mirroring,
drift math, staleness checks. External work trackers are the source of truth
for work items; git owns prose.

## Server subsystems

- `tracker/` — six tracker adapters (GitHub, GitLab, Jira, Asana,
  Azure Boards, ClickUp) behind one normalized interface with per-backend
  capability flags, a shared HTTP core (retry/backoff, typed errors), and a
  contract test suite every adapter must pass.
- `planning/` — plan artifacts, tracker mirroring, drift detection,
  milestone lifecycle.
- `memory/` — disposable FTS index + git-committed memory cards with
  provenance and staleness checking.
- `docs/` — documentation connectors (below).
- `core/` — continuity, sessions, active context.

## Docs connector subsystem (v2)

Publishes repo documentation outward to a team wiki. Deliberately a sibling
of the tracker subsystem, not an extension of it — trackers manage work
items, docs connectors publish documentation, and nothing is shared but the
HTTP core and the config pattern.

- **SPI** (`server/src/docs/types.ts`) — `DocsConnector` (ensureRoot,
  getPage, findPage, listChildren, createPage, updatePage) plus
  `DocsCapability` flags. Bodies cross the SPI as **markdown**; each adapter
  owns conversion to its product's native format. This keeps the interface
  neutral for future Notion / GitBook / Slite / SharePoint adapters.
- **Registry** (`server/src/docs/registry.ts`) — same two-level config shape
  as the tracker registry: the top-level config block names the connector
  and carries an opaque config record; the adapter module's Zod schema does
  the deep validation. Credentials never live in config — only env-var
  *names* do.
- **Confluence adapter** (`server/src/docs/adapters/confluence.ts`) —
  Confluence Cloud v2 REST client reusing the shared HTTP core, Atlassian
  API-token Basic auth, and a body-cursor pagination variant (Confluence
  puts the next link in the response body rather than a Link header).
  Projects follow the space convention: a **folder named for the project**
  under the space root, with the landing page and doc tree inside it
  (folder lookup is case-insensitive via CQL search; folders have no
  title-filtered v2 listing).
- **Converter** (`server/src/docs/markdown.ts`) — dependency-free
  markdown → Confluence storage format (XHTML) for a supported subset:
  headings, paragraphs, nested lists, fenced code (code macro with CDATA
  escaping), tables, blockquotes, links; images degrade to links and
  unknown constructs degrade to escaped text. Conversion never throws.
  List nesting clamps to one level per indent step — multi-level jumps
  previously produced unbalanced markup Confluence rejects.
- **Publisher** (`server/src/docs/publish.ts`) — README.md becomes the
  landing page; `docs/` (plus a root CHANGELOG.md) becomes the child page
  tree; directory pages get generated child listings and the landing page
  gets a Documentation contents section with real page URLs (two-pass
  publish). Idempotent: pages are matched by title + ancestry and updated
  in place. Confluence titles are unique per **space**, so a title already
  taken elsewhere publishes under a `Title (Context)` disambiguation
  instead of failing. Remote pages are not deleted when local files
  disappear.
- **Surface** — `docs_publish` / `docs_status` MCP tools with a per-project
  connector memo (evicted on config writes), and the `docs` verb for
  publish/status from chat.

### Testing

A shared behavioral contract suite (`server/test/docs-contract.ts`) runs
against every connector: the in-memory fake (which enforces the space-wide
unique-title rule so unit tests hit production constraints), and — behind
an environment gate — a live Confluence space. Publisher and converter are
pure and unit-tested without HTTP.
