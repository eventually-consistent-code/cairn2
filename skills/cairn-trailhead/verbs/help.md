---
verb: help
args: "[verb]"
status: live
---

Render the verb reference from the routing table in SKILL.md.

1. Called with an unrecognized token: say so ("`wrok` isn't a cairn verb —
   did you mean `work`?") using nearest-match against the table, then render.
2. Called with a live verb name: show that verb's purpose, args, and
   subroutine procedure summary only.
3. Otherwise render the full reference:
   - **Live verbs** in lifecycle order (`new → plan → work → verify → ship`,
     then `status import remember recall do help`), each with purpose + args.
   - **Coming next**, compact, by tier: A0 waypoint · A scout probe draft
     route summit auto fast resync · B mark retro distill brief tune ·
     C trace · D triage · F basecamp.
4. Close with: freeform works too — `/cairn do "<what you want>"`.

Every verb reads `.cairn/profile.md` when present and calibrates
tone/depth to it — advisory only, never a change to what a verb decides.
