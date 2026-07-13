# cairn-server

MCP server for cairn 2.0. See `docs/superpowers/specs/2026-07-12-cairn-2-design.md`.

## Test rings

1. `npm test` — unit + contract-vs-FakeTracker (CI, no network)
2. `npm run test:live` — contract vs a real backend. Per spec, an adapter is
   NOT shipped until live-green.

Each `.live.test.ts` skips cleanly when `CAIRN_LIVE_TESTS` and its backend's
env vars aren't set, so `npm test` never touches the network.

## Adapter status

| type | unit | contract (fake) | contract (cached) | live status | live env vars |
|---|---|---|---|---|---|
| `github` | ✅ | ✅ | ✅ | 🟢 live-green (8/8, sandbox, 2026-07-13) | `CAIRN_TEST_GITHUB_REPO`, `GITHUB_TOKEN` (or `gh auth login`) |
| `gitlab` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_GITLAB_PROJECT`, `GITLAB_TOKEN` |
| `jira` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_JIRA_BASE_URL`, `CAIRN_TEST_JIRA_PROJECT_KEY`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| `asana` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_ASANA_PROJECT_GID`, `ASANA_TOKEN` |
| `azure-boards` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_AZURE_ORG_URL`, `CAIRN_TEST_AZURE_PROJECT`, `AZURE_DEVOPS_PAT` |
| `clickup` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_CLICKUP_DEFAULT_LIST`, `CAIRN_TEST_CLICKUP_SPACE` (or `CAIRN_TEST_CLICKUP_FOLDER`), `CLICKUP_TOKEN` |

"contract (fake)" is ONE shared run of `test/contract.ts` against `FakeTracker`
(and `CachedTracker(FakeTracker)` for "contract (cached)") — it is not a
per-adapter run; each adapter's own live-gate coverage is what "live status"
reports above.

"contract (fake)"/"contract (cached)" mean the adapter's behavior is exercised
indirectly — every adapter shares the same `trackerContract` suite
(`test/contract.ts`), which today runs directly against `FakeTracker` and
`CachedTracker(FakeTracker)`. The adapter-specific "contract" coverage lives
in each `<name>.live.test.ts`, gated as shown below; "unit" is each adapter's
own `<name>.unit.test.ts` against fixture HTTP responses.

## Running the live gates

Only `github` is live-green today — it's been run against a real sandbox
repo. The other five adapters are fully implemented and pass unit +
contract-fake but have not yet been run against live credentials; run their
gate below before relying on them in production.

### github

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_GITHUB_REPO="<you>/cairn-sandbox"   # a throwaway repo you own
gh auth status || gh auth login                        # or export GITHUB_TOKEN
cd server && npm run test:live
```

### gitlab

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_GITLAB_PROJECT="<you>/cairn-sandbox"  # a throwaway project you own
export GITLAB_TOKEN="<personal access token, api scope>"
cd server && npx vitest run test/gitlab.live.test.ts
```

### jira

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_JIRA_BASE_URL="https://your-domain.atlassian.net"
export CAIRN_TEST_JIRA_PROJECT_KEY="SAND"                # a throwaway project you own
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="<token from https://id.atlassian.com/manage-profile/security/api-tokens>"
cd server && npx vitest run test/jira.live.test.ts
```

### asana

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_ASANA_PROJECT_GID="<numeric project gid>"  # a throwaway project you own
export ASANA_TOKEN="<personal access token>"
cd server && npx vitest run test/asana.live.test.ts
```

### azure-boards

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_AZURE_ORG_URL="https://dev.azure.com/your-org"
export CAIRN_TEST_AZURE_PROJECT="<throwaway project you own>"
export AZURE_DEVOPS_PAT="<PAT with Work Items (Read & Write) scope>"
cd server && npx vitest run test/azure-boards.live.test.ts
```

### clickup

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_CLICKUP_DEFAULT_LIST="<throwaway list id>"
export CAIRN_TEST_CLICKUP_SPACE="<throwaway space id>"   # or CAIRN_TEST_CLICKUP_FOLDER
export CLICKUP_TOKEN="<personal API token>"
cd server && npx vitest run test/clickup.live.test.ts
```

Every suite creates issues/milestones (or the backend's phase equivalent)
prefixed `contract:` in the sandbox project. Clean up by closing them or
deleting the sandbox; the suite never touches anything it did not create.

## Rebuilding `dist/`

The `server/dist/` directory is committed to the repository so that marketplace installations (via git clone or tarball) can run the MCP server without requiring a build step. When you modify files in `server/src/`, you must rebuild and commit the updated `dist/` directory:

```bash
cd server && npm run build && git add dist && git commit -m "…"
```

Contributors should always rebuild `dist/` alongside source changes; a CI check for drift is planned as future work.
