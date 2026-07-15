---
description: Start a new cairn project — interview, plan artifacts, tracker mirror, issues
argument-hint: "[project name]"
---

Start a new cairn 2.0 project in this repo, per the `cairn-planning` skill.

1. Confirm `cairn.json` exists (else point at `templates/cairn.json.example` and stop).
2. Interview the user briefly: vision, 3–10 requirements, phase breakdown. Native
   plan mode is appropriate for this conversation at standard/deep depth.
3. `plan_scaffold_project(name: $ARGUMENTS or the agreed name)`, then write the
   vision and requirements into `.cairn/plans/PROJECT.md` and the phase table
   into `roadmap.md`.
4. For each phase N: `plan_scaffold_phase(number, name)` and
   `plan_phase_ensure(number, name)` → tracker phase id.
5. For each requirement: `issue_create(title, body, phase: <phase id>)`, then
   record the ids per phase with `plan_issues_set(phaseDir, issues)`.
6. Report: phases created, issues created, next step `/cairn:plan 1`.
