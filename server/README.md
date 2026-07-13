# cairn-server

MCP server for cairn 2.0. See `docs/superpowers/specs/2026-07-12-cairn-2-design.md`.

## Test rings

1. `npm test` — unit + contract-vs-FakeTracker (CI, no network)
2. `npm run test:live` — contract vs a real backend. Per spec, an adapter is
   NOT shipped until live-green.

## Running the GitHub live gate

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_GITHUB_REPO="<you>/cairn-sandbox"   # a throwaway repo you own
gh auth status || gh auth login                        # or export GITHUB_TOKEN
cd server && npm run test:live
```

The suite creates issues/milestones prefixed `contract:` in the sandbox repo.
Clean up by closing them or deleting the repo; the suite never touches
anything it did not create.

## Rebuilding `dist/`

The `server/dist/` directory is committed to the repository so that marketplace installations (via git clone or tarball) can run the MCP server without requiring a build step. When you modify files in `server/src/`, you must rebuild and commit the updated `dist/` directory:

```bash
cd server && npm run build && git add dist && git commit -m "…"
```

Contributors should always rebuild `dist/` alongside source changes; a CI check for drift is planned as future work.
