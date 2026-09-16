# cairn2 — Claude context

Work-harness plugin for Claude Code (and 7 other harnesses): a TypeScript
MCP server + verb skills that mirror all work into an external tracker.

## Commands

```bash
cd server && npm ci && npm test        # full suite (vitest, ~1387 tests)
node scripts/check-surface.mjs         # verbs/tools/seats drift guard
node scripts/check-dist.mjs            # committed dist freshness
node scripts/check-pins.mjs            # tool-count pin agreement
node scripts/check-versions.mjs        # version surfaces agree
node scripts/check-diagrams.mjs        # diagram count labels agree
node scripts/release.mjs <version>     # bump every version surface (cut-first: write the CHANGELOG entry first)
```

Guards run from the **repo root**; tests from `server/`. Shell cwd
persists between commands — always `cd` from an absolute path.

## Architecture

The plugin layer (`commands/`, `skills/`, `hooks/`) owns policy and
judgment; `server/` (TypeScript MCP) owns every mechanism with a wrong
answer — state transitions, tracker mirroring, drift math, validation.
Eight tracker adapters behind one SPI; docs connectors are a sibling
subsystem. `docs/ARCHITECTURE.md` + `docs/adr/` carry the full picture.

## Gotchas

- `server/dist` is **committed**. Any commit touching `server/src` must
  `npm run build` and commit dist in the same logical unit —
  check-dist enforces it.
- Tool-count pins live in `server/test/mcp.test.ts` and
  `server/test/standalone.test.ts`; both move with every registered
  tool. check-surface self-computes and needs no edit.
- Generated surfaces are never hand-edited: README marker spans
  (`scripts/refresh-readme.mjs`), harness spine
  (`scripts/gen-agents.mjs`), command shims (`scripts/gen-commands.mjs`).
  Regenerate after merges that touch their inputs — branch-side green
  is not merge-side green.
- A pre-commit leak guard blocks planning-directory path literals in
  staged changes (server src/dist exempt). Phrase docs around it.
- Some tests are environment-conditional (live-credential and
  external-CLI gated) — skip counts vary by machine; the passed count
  is the stable baseline.
- Conventional commits. Git author uses the repo-local
  eventually-consistent-code noreply identity — never a personal email.

## Releases

Write the real `## vX.Y.Z` CHANGELOG entry, then `node
scripts/release.mjs X.Y.Z` (uses the entry as-is; refuses placeholder
scaffolds), commit, tag `vX.Y.Z`, push — the publish workflow gates on
tests and version agreement.
