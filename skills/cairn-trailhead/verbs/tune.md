---
verb: tune
args: "[key] [value]"
status: live
---

Config editor over cairn.json — all writes through `config_set`, never
hand-edits (single-writer rule).

- Bare `tune`: `config_get` → show the effective config grouped (tracker /
  agents / memory / continuity / leakGuard), marking values that are
  defaults vs explicitly set. Ask which group to change, then batch that
  group's edits into ONE AskUserQuestion. Apply via `config_set`; echo the
  resulting effective values.
- `tune <key> <value>`: direct dot-path set — build the nested patch from
  the dot path (`continuity.resume auto` → `{continuity: {resume:
  "auto"}}`), `config_set`, echo old → new. Value `null` deletes the key.
  Coerce values by the target key's type before patching (`"false"` →
  `false`, `"200000"` → `200000`; quoted strings stay strings) — the server
  rejects type mismatches with `CONFIG_INVALID` and the file is untouched,
  so a wrong guess is safe but report it plainly.
- `tune leakguard off|on` = `config_set({leakGuard: {enabled: false|true}})`
  — the guard's front door.
- Secrets: the server refuses credential-looking keys/values. When that
  happens, point at the env vars the backend actually reads (the adapter's
  *Env config keys name them).
