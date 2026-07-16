# Task 1 report — core/continuity.ts + config + errors + contract schema

## What I implemented

**Step 1 — error codes + config block + template**
- `server/src/errors.ts`: added `HANDOFF_INVALID`, `HANDOFF_STALE` to `ErrorCode` (verbatim per brief). Only `HANDOFF_INVALID` is thrown by this task's code; `HANDOFF_STALE` is plumbing for a later task (readHandoff never throws for staleness, per spec).
- `server/src/config.ts`: added the `continuity` block to `ConfigSchema` exactly as specified — `resume` enum (`prompt`/`auto`/`off`, default `prompt`), `checkpoint` (default `true`), `wipCommits` (default `false`), `recallIndex.{enabled,maxCards}` (defaults `true`/`20`), whole block `.default({})` so existing `cairn.json` files without a `continuity` key still parse.
- `templates/cairn.json.example`: mirrored the `continuity` block (shown explicitly, same pattern as the existing `agents` block).

**Step 2 — continuity.ts + contract schema**
- `server/src/core/continuity.ts` (new): `handoffPath`/`bannerPath` (shared `pathHash` helper using the exact `sha256(resolve(dir)).slice(0,16)` scheme from `indexDbPath`), `Handoff` interface + `HandoffSchema` (zod), `readHandoff`, `writeHandoff`, `clearHandoff`.
- `server/schema/handoff-v1.json` (new): hand-written JSON Schema mirroring the zod shape, with `required` = the 13 always-present fields and `properties` = all 16 fields (adds `phase`, `issue`, `plan` as optional).

**Step 3 — tests + guards**
- Extended `server/test/config.test.ts` with 4 new tests (defaults apply, explicit overrides, partial-override defaulting, and an existing-fixture-without-continuity-block backward-compat check).
- New `server/test/continuity.test.ts` (22 tests): path-hash parity with `indexDbPath`, the fixture/contract check against `schema/handoff-v1.json`, `readHandoff` (null-when-absent, `HANDOFF_INVALID` on bad JSON and on schema-invalid JSON with the `nextAction` string, stale at >14d / not-stale at 13d via injected `created`), `writeHandoff` (stamps version/created, merges patches, derives `project` via `basename(resolve(projectDir))`, skeleton guard keeps the richer file, skeleton guard does *not* block a write that keeps richness, unregistered guard is silent, `CONFIG_INVALID` still propagates, atomic write leaves no `.tmp`), `clearHandoff` (false when absent, true + removes file, idempotent second call).

## Design decisions (not pinned exactly by the brief — flagging for review)

- `phase`, `issue`, `plan` are optional in both the zod schema and JSON schema (`required` excludes them); everything else, including the nested `task.{current,title}` and all five array fields, is always present (defaulting to `""`/`[]`/`false` inside `writeHandoff`'s merge, not via zod `.default()`). I deliberately avoided zod's `.default()` for anything covered by `z.ZodType<Handoff>` — `.default()` makes a field's *input* type differ from its *output* type, which breaks the `z.ZodType<Handoff>` assignability check the brief asks for (Input defaults to `Handoff` too, and an optional input can't satisfy a required target). Used `.optional()` only where Input/Output genuinely agree, and did defaulting by hand in `writeHandoff`'s `blankHandoff()`.
- `clearHandoff` deletes the file outright rather than writing an empty skeleton — this sidesteps any conflict with the skeleton guard (which governs `writeHandoff`, not deletion) and matches "clearHandoff(projectDir): boolean" reading naturally as "did a handoff exist to clear."
- `writeHandoff` treats a corrupt *existing* file as absent (falls back to `blankHandoff`) rather than throwing — only `readHandoff` throws `HANDOFF_INVALID` on corrupt content, per the brief's literal wording ("invalid JSON/schema → throw" appears only under `readHandoff` in the interfaces list). This keeps writes resilient even if a prior session left a mangled file.
- `writeHandoff` re-throws any `CairnError` from `loadConfig` that isn't `CONFIG_MISSING` (e.g. `CONFIG_INVALID`) rather than swallowing it — brief says "on CONFIG_MISSING skip silently," implying other config errors are a real problem worth surfacing. Covered by a test.

## TDD Evidence

**RED — config.test.ts (continuity block not yet in ConfigSchema)**
```
$ npx vitest run test/config.test.ts
 FAIL  test/config.test.ts > loadConfig > continuity respects explicit overrides
AssertionError: expected undefined to deeply equal { resume: 'auto', …(3) }
 FAIL  test/config.test.ts > loadConfig > continuity.recallIndex defaults apply when continuity block is present but recallIndex omitted
TypeError: Cannot read properties of undefined (reading 'resume')
 FAIL  test/config.test.ts > loadConfig > an existing fixture config without a continuity block still parses (backward compatible)
TypeError: Cannot read properties of undefined (reading 'resume')
 Test Files  1 failed (1)
      Tests  4 failed | 7 passed (11)
```
Expected: `cfg.continuity` didn't exist yet on `ConfigSchema`.

**GREEN — config.test.ts**
```
$ npx vitest run test/config.test.ts test/errors.test.ts
 ✓ test/errors.test.ts (1 test) 1ms
 ✓ test/config.test.ts (11 tests) 7ms
 Test Files  2 passed (2)
      Tests  12 passed (12)
```

**RED — continuity.test.ts (module didn't exist)**
```
$ npx vitest run test/continuity.test.ts
 FAIL  test/continuity.test.ts [ test/continuity.test.ts ]
Error: Failed to load url ../src/core/continuity.js (resolved id: ../src/core/continuity.js) in
/Users/jsreed/repos/cairn2-a0/server/test/continuity.test.ts. Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```
Expected: `src/core/continuity.ts` hadn't been written yet.

**GREEN — continuity.test.ts**
```
$ npx vitest run test/continuity.test.ts
 ✓ test/continuity.test.ts (22 tests) 16ms
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

**Full suite + typecheck (final, before commit)**
```
$ npx vitest run
 Test Files  25 passed | 6 skipped (31)
      Tests  243 passed | 6 skipped (249)

$ npx tsc --noEmit
(clean, no output)
```
243 passing (was 217 before this task; +22 continuity.test.ts, +4 config.test.ts). No pre-existing tests broken. Confirmed no residue left in real `~/.cairn/handoff` or `~/.cairn/banner` after the run (tests use the real `homedir()` and clean up in `afterEach`).

## Files changed

- New: `server/src/core/continuity.ts`, `server/schema/handoff-v1.json`, `server/test/continuity.test.ts`
- Modified: `server/src/errors.ts`, `server/src/config.ts`, `templates/cairn.json.example`, `server/test/config.test.ts`

## Self-review findings

- **Completeness**: all brief interfaces implemented with the exact signatures listed. All 3 steps' test requirements covered (path-hash parity, contract fixtures, skeleton guard, unregistered guard, stale flag at >14d, atomic-write residue check).
- **Quality**: names read clearly (`isRich`, `blankHandoff`, `pathHash`, `readRaw`); comments explain intent per the codebase's established voice (see `staleness.ts`, `active-context.ts`) rather than restating code.
- **Discipline**: no new dependencies; `node:`-prefixed imports only; reused `loadConfig`/`CairnError` rather than reinventing config/error handling; did not add anything beyond the brief's stated interfaces (no extra exported helpers, no premature `HANDOFF_STALE` throw site since that belongs to a later task).
- **Testing**: TDD evidence above (two RED→GREEN cycles: config, then continuity). All test assertions exercise real behavior (real filesystem via tmpdir, real hashing, real staleness math) rather than mocks. Full-suite + tsc run clean before commit.
- One thing I did **not** do: didn't add a `writeHandoff` runtime re-validation pass on the merged object before writing (relying on TS to guarantee shape at the call site, consistent with how `active-context.ts` doesn't re-validate either). Flagging in case a later task's callers bypass TS types (e.g. deserializing tool-call args) and want that safety net added at the MCP-tool-wiring layer (Task 2) instead.
