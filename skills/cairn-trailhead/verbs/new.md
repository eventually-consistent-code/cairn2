---
verb: new
args: "[project name]"
status: live
---

Start a new cairn 2.0 project in this repo, per the `cairn-planning` skill.

1. Confirm `cairn.json` exists. Missing → ask which tracker backs this
   project (one AskUserQuestion): **local** first — "issues live in this
   repo as plain files; no accounts, no credentials" — then the seven hosted
   options. Local chosen → write a minimal `cairn.json`
   (`{"tracker": {"type": "local", "config": {"prefix": "<project slug,
   2–10 lowercase alphanumerics>"}}}`), then check `.gitignore`: if any
   pattern matches `.tracker/`, show the offending line and stop until the
   user removes it — the store only works committed. Hosted chosen → point
   at that backend's block in `templates/cairn.json.example` and stop for
   credentials setup as before.
2. Interview the user briefly: vision, 3–10 requirements, phase breakdown. Native
   plan mode is appropriate for this conversation at standard/deep depth.
   The interview also asks the mode once (skip when cairn.json already
   sets `user.mode`): vibe — cairn drives end-to-end (default) — or
   engineer — you claim issues, write code, and make the design calls;
   cairn pairs, verifies, and keeps the tracker mirror honest for both.
   Engineer chosen → collect the tracker handle too and set both via
   `config_set` in one patch.
3. `plan_scaffold_project(name: <argument or the agreed name>)`, then write the
   vision and requirements into `.cairn/plans/PROJECT.md` and the phase table
   into `roadmap.md`.
4. For each phase N: `plan_scaffold_phase(number, name)` and
   `plan_phase_ensure(number, name)` → tracker phase id.
5. For each requirement: `issue_create(title, body, phase: <phase id>)`, then
   record the ids per phase with `plan_issues_set(phaseDir, issues)`.
6. Report: phases created, issues created, next step `/cairn:plan 1`.
