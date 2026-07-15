---
description: "Cairn — one entrypoint, every verb. Run /cairn help for the verb reference."
argument-hint: "<verb> [args]"
---

Route this cairn invocation:

1. Split `$ARGUMENTS` at the first whitespace: the first token is the **verb**,
   the remainder is the verb's arguments. No arguments at all → the verb is
   `help`.
2. Read `skills/cairn-trailhead/SKILL.md` (this plugin) and find the verb's
   row in the routing table.
3. Row found with status `live` → read its subroutine file
   (`skills/cairn-trailhead/verbs/<verb>.md`) and execute it with the
   remainder as its arguments, under the skill's shared rules.
4. Row found with status `reserved-*` → tell the user which tier it ships in
   and show `/cairn help`.
5. No row → execute `verbs/help.md`, passing the unrecognized token so help
   can echo it and suggest the nearest verb. Never fall through to `do`.
