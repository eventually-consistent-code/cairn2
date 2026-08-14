# Hook lab — repro recipe + captured payloads

Everything below was captured live on CLI 2.1.223 (2026-08-14),
probe-1733c5c9. Re-run this recipe after CLI upgrades before trusting the
constraints — event coverage is the thing most likely to change (an
update event may appear later; there is an open platform feature request
for native Task sync).

## Registration (worked verbatim)

`.claude/settings.json` in the lab project:

```json
{
  "hooks": {
    "TaskCreated": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/dump-hook.sh\""
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/dump-hook.sh\""
          }
        ]
      }
    ]
  }
}
```

Note: an unknown event name (`TaskUpdated`) in this block is accepted
silently and never fires — no validation error.

## Dump script

```bash
#!/bin/bash

set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
cat >> "$dir/payloads.jsonl"
echo "" >> "$dir/payloads.jsonl"

exit 0
```

## Driver (headless child session)

```bash
claude -p "Use TaskCreate to create a task with subject 'probe-ping' and \
description 'hook payload capture test'. Then use TaskUpdate to set that \
task's state to completed. Do nothing else. Reply with just the task id." \
  --allowedTools "TaskCreate,TaskUpdate" --settings .claude/settings.json
```

## Captured payloads (experiment 1, verbatim)

```json
{"session_id":"dc5eed96-5229-44d9-bd63-6a203206bbf9","transcript_path":"~/.claude/projects/-Users-jsreed-repos-cairn2--cairn-probe-probe-1733c5c9-hook-lab/dc5eed96-5229-44d9-bd63-6a203206bbf9.jsonl","cwd":"<repo>/.cairn/probe/probe-1733c5c9/hook-lab","prompt_id":"a708e1a6-f190-41bf-8b5f-f56a498198d2","hook_event_name":"TaskCreated","task_id":"1","task_subject":"probe-ping","task_description":"hook payload capture test"}
{"session_id":"dc5eed96-5229-44d9-bd63-6a203206bbf9","transcript_path":"~/.claude/projects/-Users-jsreed-repos-cairn2--cairn-probe-probe-1733c5c9-hook-lab/dc5eed96-5229-44d9-bd63-6a203206bbf9.jsonl","cwd":"<repo>/.cairn/probe/probe-1733c5c9/hook-lab","prompt_id":"a708e1a6-f190-41bf-8b5f-f56a498198d2","hook_event_name":"TaskCompleted","task_id":"1","task_subject":"probe-ping","task_description":"hook payload capture test"}
```

Experiment 2 (create → in_progress → rename → complete) produced exactly
two events: `TaskCreated` with the original subject, `TaskCompleted` with
the **renamed** subject (`probe-ping-2-renamed`). Nothing fired for the
in_progress transition or the rename itself. Both sessions produced
`task_id: "1"` — session-scoped counter, not globally unique.

## Timing (experiment 3)

| Run | Hook | Wall clock |
|-----|------|-----------|
| baseline A | dump only | 21.3s |
| baseline B | dump only | 20.9s |
| instrumented | dump + `sleep 5` | 27.7s |

Two events × 5s = +10s if fully serial; observed +6.6s. TaskCreated's
hook blocks mid-session; TaskCompleted's overlaps teardown. Conclusion:
hook execution blocks session progress — spool locally, mirror from a
detached worker.

## Spool pattern (the shape the real build should take)

```
hook (fast, local, never fails the session):
  append JSON line -> ~/.cairn/spool/task-events.jsonl
  exit 0

detached worker (launched by hook if not running, or by server):
  read spool, for each event:
    TaskCreated  -> issue_create, record (session_id, task_id) -> issue id
    TaskCompleted -> look up mapping, issue_update title (true-up), issue_close
  retry with backoff; spool survives offline periods
```
