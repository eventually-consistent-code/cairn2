# Fix inventory — exact patches from the dress rehearsal

Everything below was applied to the migrated copy at
`.cairn/probe/probe-6651a387/server-v2/` and verified: typecheck clean,
build clean, standalone stdio boot serving all tools, 1037/1057 tests
(identical failure set to the pristine location control). Diff the copy
against `server/` for the authoritative picture.

## Step order that worked

```bash
npx -y @modelcontextprotocol/codemod@2.0.0 v1-to-v2 .
npm pkg set 'dependencies.zod=^4.2.0'   # v2 floor — do NOT skip
npm install
npx tsc --noEmit                         # expect ~26 errors, all zod
```

Post-codemod error census (before fixes): 26 errors / 7 files —
`src/index.ts` (7), `src/config.ts` (6), `src/tracker/adapters/local.ts`
(4), `src/tracker/adapters/jira.ts` (4), `src/tracker/adapters/clickup.ts`
(2), `src/map/store.ts` (2), `src/tracker/adapters/azure-boards.ts` (1).
Dominant code TS2554 ("Expected 2-3 arguments, but got 1") = z.record
arity.

## Class 1 — z.record arity (9 sites)

zod 4 removed single-arg `z.record(valueSchema)`; key schema is required.

| File | Old | New |
|------|-----|-----|
| tracker/adapters/clickup.ts:21 | `z.record(z.string())` | `z.record(z.string(), z.string())` |
| tracker/adapters/azure-boards.ts:21 | `z.record(z.string())` | `z.record(z.string(), z.string())` |
| tracker/adapters/jira.ts:27 | `z.record(z.string())` | `z.record(z.string(), z.string())` |
| tracker/adapters/local.ts:27 | `z.record(z.enum(["open","in_progress","closed"]))` | `z.record(z.string(), z.enum([...]))` — key is the custom state NAME |
| map/store.ts:35 | `z.record(MapNodeSchema)` | `z.record(z.string(), MapNodeSchema)` |
| index.ts:387, 851, 1243 | `z.record(z.unknown())` | `z.record(z.string(), z.unknown())` |
| index.ts:1099, 1195 | `z.record(z.union(...))` | `z.record(z.string(), z.union(...))` |
| config.ts:10, 17 | `z.record(z.unknown())` | `z.record(z.string(), z.unknown())` |

## Class 2 — `.default({})` → `.prefault({})`

zod 4's `.default(v)` short-circuits (returns v without parsing inner
defaults); `.prefault(v)` restores zod-3 parse-then-default. Applied
blanket to `src/config.ts` and `src/index.ts`:

```bash
perl -pi -e 's/\.default\(\{\}\)/.prefault({})/g' src/config.ts src/index.ts
```

## Class 3 — exhaustive enum-keyed record (the runtime landmine)

`config.ts:60` — `peers: z.record(z.enum(PROVIDERS), PeerSchema)`.
zod 4 makes enum-keyed records exhaustive: a config naming only some
providers now FAILS validation ("peers.codex: Invalid input: expected
object, received undefined"). Type-checked fine; broke 11 tests at
runtime (4 config.test.ts + 7 peers-run.test.ts), surfacing as
`CONFIG_INVALID` where `PRECONDITION_FAILED` was expected.

Fix: `z.partialRecord(z.enum(PROVIDERS), PeerSchema)`.

**Sweep rule for the real migration:** grep every `z.record(z.enum` and
every `.default(`/`.prefault(` and decide each one deliberately — this
class is invisible to tsc when the arity is right.

## Test triage — the location control

Copy the PRISTINE server next to the migrated one and run the same
failing files there:

```bash
cp -R server .cairn/probe/<id>/server-v1-control
cd .cairn/probe/<id>/server-v1-control && npx vitest run <failing files>
```

Anything failing in both copies is environment (tests reaching for
repo-root `scripts/`, `hooks/`, `harness/`, `templates/`, root
`package.json`), not migration. In the rehearsal: exactly 20 such tests,
same set both sides — migrated copy at true parity.

## Codemod behavior notes

- Emits per-site INFO lines for every `inputSchema` it wraps with
  `z.object()` — noisy but harmless.
- Warns explicitly that a zod ^3 range "installs cleanly and then …
  fails at runtime (the server starts normally and the first tools/list
  reports the failure)". Believe it.
- Touches drills (29 files) and tests (4 files), not just src.
- Does not run a formatter; `prettier --write` the changed files after.
