# BUILD-NOTES — github-core-clone-01 (coordination scratchpad; DELETE before submit)

## Agent C (GraphQL + MCP) — store contract additions needed from Agent A

`src/store.ts` per BUILD-SPEC does not expose where issues/pulls live. Agent C codes
against this extension — implemented by Agent A exactly as specified
(`Repo.issues` / `Repo.pulls` maps, verified 2026-11-15), and `src/graphql.ts`
now imports the real store types/helpers directly (see the refactor note below):

- `Repo` MUST carry `issues: Map<number, Issue>` and `pulls: Map<number, Pull>`,
  initialised empty by `createRepo()`. Agent C writes into these maps directly
  (`repo.issues.set(number, issue)`, `repo.pulls.set(number, pull)`) using
  `store.nextIssueNumber(repo)` / `store.nextPullNumber(repo)` / `store.nextId()` /
  `store.now()` from the spec contract. Same-object mutation: GraphQL/MCP mutate the
  Issue/Pull objects in place (e.g. `issue.state = 'closed'`), REST must read the same
  objects from the same maps.
- `Pull.head` / `Pull.base` are `{ref, sha}`; `Pull.state` is `'open' | 'closed'`
  (merged PRs stay `state: 'closed'` + `merged: true`).
- GraphQL/MCP merge performs its own squash merge via the store git helpers
  (`getObject`/`putObject`/`getRef`/`setRef`/`isAncestor`) — tree/commit bytes are
  parsed in `src/graphql.ts` (`parseTree`/`parseCommit`/`flattenTree`), no tree
  building needed (squash commit reuses the head tree oid).
- `isAncestor(repo, a, b)` MUST return true when `a === b` (ancestor-or-self), the
  merge-base walk in `src/graphql.ts` relies on it.

## Agent C — refactor (2026-11-15): store.ts + http.ts have landed, modules now import them

- `src/graphql.ts` / `src/mcp.ts` import the real `src/store.ts` (types `Store`,
  `Repo`, `Issue`, `Pull`, `Comment`, `Label`; helpers `parseCommit`,
  `parseTree`, `toGlobalId`, `fromGlobalId`, `makeCommitBytes` not needed) and
  the real `src/http.ts` (`ApiContext`, `sendJson`, `sendError`,
  `isAuthenticated`, `readJsonBody`, `sendNoContent`). Local HTTP helpers are
  deleted; one per-process `X-GitHub-Request-Id` counter now lives in `http.ts`.
  Handlers are `handleGraphQL(req, res, ctx: ApiContext)` and
  `handleMcp(req, res, ctx: ApiContext)`.
- `StoreLike` remains exported as an alias for `Store` (back-compat for any
  importer); `ForgeContext` is an alias for `ApiContext`.
- Gotcha fixed during the switch: store's `fromGlobalId` returns `parts`
  WITHOUT the kind (`['5000','6']`), unlike the stub's split — the four
  decode sites (repo/issue/pull `*FromGlobalId` + `node(id:)` resolver) were
  off by one until fixed. Global ids are now identical across surfaces:
  GraphQL `id` == REST `node_id` (both `toGlobalId`).
- The `Repo.issues` / `Repo.pulls` maps Agent A implemented match the
  BUILD-NOTES contract exactly; `isAncestor` is ancestor-or-self as required.
- `Pull` gained `created_at`/`updated_at` in the real store; `createPullInStore`
  fills both from one `now()` call.

## Agent C — test results (2026-11-15, stub store + stub REST in /tmp/gql-mcp-test/)

Harness: `/tmp/gql-mcp-test/` — `store-stub.ts` (BUILD-SPEC contract + the two
maps above), `server.ts` (wires the real `src/graphql.ts` + `src/mcp.ts` with a
minimal REST stub for cross-surface checks), `test.ts` (45 checks mirroring
checks-graphql.ts / checks-mcp.ts documents and wire shapes verbatim),
`edge.ts` (6 extra edge checks). Run with `node --experimental-strip-types`.
Token used: `test-token-123` (test-only, never a real credential).

- `test.ts`: **45/45 passed** — all 20 GraphQL behaviours (viewer, repository
  fields, 3 introspection probes, open-issues order, issue-by-number,
  create/close issue + REST view, PR list + files, create/merge PR + REST view,
  addComment + REST view, invalid field 200+errors naming noSuchFieldOnViewer,
  unauthenticated 401, node(id:), unknown repo null without errors, batched 2
  ops in order, global-id stability/opacity, cursor pagination 7 = 5+2,
  unknown issue null, malformed JSON 400) and all MCP behaviours (discover,
  legacy initialize + notifications/initialized 202, tools/list >=6 + schemas,
  tools/list byte-identical twice, create_repo/get_repo/create_issue/
  list_issues/create_pull_request/merge_pull_request + REST parity, unknown
  tool -32601, parse error 400/-32700, missing args -32602, concurrent calls
  keep ids, no-auth 401, synonym args owner_login/full_name, ping, duplicate
  repo isError, missing repo isError).
- `edge.ts`: **6/6 passed** — `__schema`, unknown top-level field, multi-op
  document, mergeable CONFLICTING on same-file divergent change, conflicted
  merge fails with errors and PR stays open, double merge 200 then 405.
  (Fixture note: real REST enforces GitHub semantics — updating an existing
  file needs its current blob `sha`, else 409. The edge fixture now GETs the
  sha first.)
- NOT yet verified against the real kit runner (`sdk/run.ts`): needs Agent A's
  REST + Agent B's git + integration `app.ts` wiring. `src/store.ts` and
  `src/http.ts` did not exist when Agent C finished; modules code against the
  contract above and carry local HTTP helpers until `http.ts` lands.

## Agent C — kit runner verification (2026-11-15, fresh server, real modules)

Wiring `/tmp/gql-mcp-test/serve.ts`: real `Store` (viewer =
`scenarioViewerLogin()` = `adaiversen`, as the sealed scenario requires) +
`handleRest` + Agent B `createGitHandler` + `handleGraphQL` + `handleMcp` on
:18777. `sdk/run.ts --url http://127.0.0.1:18777 --token test-token-123 --json`:

- **graphql 20/20, mcp 15/15.** Whole suite: git 30/30, repos 15/15,
  issues 15/15, pulls 20/20, protocol 4/5, feature 595/600, agent 200/200,
  score 795 (perf not run).
- The single protocol failure (`protocol.request-id`: GET /api/v3/ without
  `x-github-request-id`) is an artifact of `serve.ts` itself — it hardcodes
  the API-root answer; the real `app.ts` must route GET /api/v3/ through
  `handleRest` (which sends the header). Nothing to fix in Agent C's files.
- A second kit run against the SAME server process scores lower (repos
  already exist -> 422): the runner needs a fresh server per run, as the
  sealed env provides.

