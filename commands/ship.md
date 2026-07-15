---
description: Ship — gate on drift-clean and no open issues in verified phases, then push
---

Pre-ship gate, then ship:

1. `plan_drift()` — anything flagged: **stop** and report; do not push.
2. `plan_status()` — every phase with VERIFICATION.md must show all its issues
   closed (`issue_get` spot-check); report any still open and stop.
3. Clean gate → commit outstanding plan-doc changes, push the branch, and (if the
   project uses PRs) offer to open/update one.

Never push with flagged drift or open issues on a verified phase.
