# BUILD-NOTES — github-core-clone-01 (coordination scratchpad; DELETE before submit)

## Agent C (GraphQL + MCP) — store contract additions needed from Agent A

`src/store.ts` per BUILD-SPEC does not expose where issues/pulls live. Agent C codes
against this extension (structural typing — `src/graphql.ts` defines its own `StoreLike`
interface, no import of `store.ts`, so the real `Store` class just needs to satisfy it):

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

## Agent C — HTTP helper note for integration

`src/http.ts` does not exist yet, so `src/graphql.ts` and `src/mcp.ts` each carry a
small local `sendJson`/`readBody`/auth helper plus their own `X-GitHub-Request-Id`
counter. Integration (`app.ts`/`http.ts`) should unify these into one helper and one
per-process counter; the handler signatures are
`handleGraphQL(req, res, {store, token})` and `handleMcp(req, res, {store, token})`.

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
- NOT yet verified against the real kit runner (`sdk/run.ts`): needs Agent A's
  REST + Agent B's git + integration `app.ts` wiring. `src/store.ts` and
  `src/http.ts` did not exist when Agent C finished; modules code against the
  contract above and carry local HTTP helpers until `http.ts` lands.

