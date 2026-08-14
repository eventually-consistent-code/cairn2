---
name: mcp-v2-migration
description: Use when executing the MCP SDK v1→v2 migration (phase 12, native grain) — validated codemod path, the zod 3→4 fix inventory, and the test-triage method proven by probe-6651a387's full dress rehearsal.
---

# MCP v2 migration — validated path and fix inventory

Cairn's server migrates from `@modelcontextprotocol/sdk` ^1.12 to the v2
scoped packages with the official codemod plus a bounded set of mechanical
zod fixes. Proven end to end 2026-08-14 on a full server copy: typecheck
clean, dist builds, standalone stdio serves all tools, test parity with
baseline. Verdict VALIDATED, resolution proceed — sized as a work item,
not a phase.

## The landscape (verified against npm/GitHub, 2026-08-14)

- Old monolith `@modelcontextprotocol/sdk` is **frozen at 1.30.0**
  (2026-07-27). No 2.x will land there.
- v2 shipped the same day as scoped packages: `@modelcontextprotocol/server`,
  `/client`, `/core`, plus framework adapters (`/node`, `/express`,
  `/fastify`, `/hono`) — all at 2.0.0.
- `@modelcontextprotocol/codemod` 2.0.0 is the official v1→v2 migration
  tool: `npx @modelcontextprotocol/codemod v1-to-v2 <dir>`.
- `@modelcontextprotocol/server-legacy` (frozen v1 SSE + OAuth helpers)
  is explicitly deprecated — do not adopt it.

## What the codemod does (observed on cairn's server)

- Rewrites all `server.tool`/`registerTool` call sites in `src/index.ts`
  (69 registrations), wraps raw object-literal `inputSchema`s with
  `z.object()`.
- Migrates test files using the SDK client and **29 drill files** — drills
  are in the blast radius, budget for them.
- Swaps `package.json` deps: removes `sdk`, adds `server` + `client`.
- Does NOT reformat output — run the formatter after.

## The real cost: zod 3 → 4 (v2 requires zod >=4.2.0)

The MCP API changes were fully automated; every hand-fix was zod. Full
inventory + exact patch patterns: `references/fix-inventory.md`. The
classes:

1. **`z.record` single-arg is gone** — `z.record(V)` →
   `z.record(z.string(), V)`. 9 sites.
2. **`.default({})` on object schemas changed semantics** — zod 4's
   `.default()` short-circuits; use `.prefault({})` for the old
   parse-then-default behavior. config.ts + index.ts.
3. **Enum-keyed records became exhaustive** — `z.record(z.enum(KEYS), V)`
   now requires EVERY key. This one **changed runtime behavior silently**
   (broke 11 config/peers tests: absent providers rejected as
   `CONFIG_INVALID`). Fix: `z.partialRecord(z.enum(KEYS), V)`.

## What to avoid, and why

- **Don't keep the zod ^3 range with v2 packages.** It installs cleanly
  and the server starts normally — failure surfaces only at the first
  `tools/list`. Runtime-only trap; the codemod warns about exactly this.
- **Don't trust typecheck-clean as done.** The exhaustive-enum-record
  change type-checked after the arity fix but still failed at runtime.
  Plan a behavior-diff sweep over every schema (`.default`/`.prefault`,
  enum-keyed records) — that's the second issue of the work item.
- **Don't triage test failures without a location control.** The dress
  rehearsal showed 20 "failures" that also fail on a pristine v1 copy at
  the same path (tests reach for repo-root files: `scripts/`, `hooks/`,
  `harness/`, `templates/`, root `package.json`). Copy the pristine
  server next to the migrated one and run the same files — anything
  failing in both is environment, not migration.

## Phase 12 sizing (locked by the probe)

Two issues: (1) server migration — scoped v2 packages, zod 4 floor,
drills, formatter pass; (2) zod-4 behavior-diff sweep over every schema.
No architectural surgery: cairn never touched initialize-time state or
session identity, so the stateless protocol change is absorbed by the SDK.

## Origin

- Probe session: `probe-6651a387` (archive:
  `.cairn/probe/archive/probe-6651a387.md`)
- Tracker issue: #85 (closed, resolution `proceed`)
- Probed 2026-08-14; SDK versions: monolith 1.30.0, scoped family 2.0.0
- Artifacts: `.cairn/probe/probe-6651a387/` — includes `server-v2/`, the
  fully migrated, test-parity copy (reference diff for the real
  migration) and `server-v1-control/` (pristine location control)
- Feeds: phase 12 "native grain" (roadmap v4); sibling skill:
  [[native-task-hook-mirror]]
