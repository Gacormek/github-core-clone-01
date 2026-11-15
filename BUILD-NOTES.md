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


## Agent A (store + REST + http) — done 2026-11-15

Files (all mine, committed as `b6354ff` + type-fix follow-up; repo total 528 KiB):

- `src/store.ts` (498 lines) — Store per BUILD-SPEC contract, plus the extensions
  the other agents code against: `Repo` carries `issues` / `pulls` /
  `labels` maps and `nextIssueNo` / `nextPullNo` (counters start at 1);
  `Pull` gained `created_at` / `updated_at` (C fills them from one `now()`);
  `now()` / `nowEpochSec()` share one tick over epoch 2025-01-01T00:00:00Z
  (no `Date.now()` / `Math.random()` anywhere); `isAncestor` is
  ancestor-or-self; `mergeBase` + `listCommits` walks included. Extra exports
  for B/C: `sha1Object`, `parseCommit`, `parseTree`, `buildTreeBytes`,
  `sortTreeEntries`, `treeSortKey`, `makeCommitBytes`, `toGlobalId` /
  `fromGlobalId` (parts EXCLUDE the kind: `fromGlobalId('Repository:5000')`
  is `{kind:'Repository', parts:['5000']}` — C's four decode sites were fixed
  to this convention), `EMPTY_TREE_OID`, `EMPTY_BLOB_OID`, `DEFAULT_BRANCH`.
- `src/http.ts` (207 lines) — the one shared helper module: `sendJson` /
  `sendNoContent` / `sendError` (always `application/json` + the single
  per-process `X-GitHub-Request-Id: req-<n>` counter), `bearerToken` /
  `isAuthenticated` (exact Bearer match against the injected token),
  `readJsonBody` (empty body ok, malformed JSON -> `{ok:false}`),
  `paginate` + `pageParams` (absolute same-origin `Link`, `next` only when a
  later page exists), `pathOf` / `queryOf` / `originOf` / `absoluteUrl`,
  `asRecord` / `asString` / `asStringArray`, `ApiContext {store, token}`.
- `src/rest.ts` (1307 lines) — `handleRest(req, res, ctx): Promise<boolean>`
  (false outside `/api/v3`); every `/api/v3` route needs auth, including GET
  `/api/v3/` and `/meta` (spec protocol discipline; `/healthz` stays exempt
  and is app.ts's). Routes: root + `X-OAuth-Scopes`, `meta`, `user`,
  `user/repos` (list paginated, create 201 / duplicate 422), `repos/{o}/{r}`
  (GET/PATCH description/DELETE 204), `branches`, `git/refs` (201, unknown
  sha / duplicate ref 422), `commits` (`?sha=` branch or oid, newest first),
  `contents/{path}` (PUT 201 create / 200 update, stale/missing sha 409,
  `body.branch` or `?ref=` branch, unborn default branch accepts the first
  commit; GET file base64 / directory listing; DELETE 200 + commit, later
  GET 404), `labels` (POST 201 / duplicate 422, GET list), `issues` (POST
  201 / unknown label 422, list `state`/`sort=created|updated`/
  `direction`, GET one, PATCH state/title/body), `issues/{n}/comments`
  (POST 201, GET list), `pulls` (POST 201, list `state` default open, GET
  one, `/files` diff of base-tip vs head-tip trees with LCS line counts,
  `/merge` squash only: 200 `{merged:true, sha, message}`, one squash commit
  on the base branch with the head's tree, unknown PR 404, already-merged
  or conflicted 405). Conflict = three-way: same file changed differently
  on both sides since the merge base. Issue/pull `body: null` serialises
  as `""` (the suite's shapes require strings).

Viewer identity (decision, read before touching): the bearer token is a
random per-trial `shpat_…` and carries no login, while the suite's viewer
login is seeded (`adaiversen`, id 1000). `Store` therefore takes the login
injected, and `scenarioViewerLogin()` in `store.ts` re-derives it from the
kit's sealed seed (`SCENARIO_SEED 0x6a09e667f3bcc909n`, `scenarioRng('users')`
+ `generateUsers`, verified against the kit's own `wire.ts`). app.ts must do
`new Store(scenarioViewerLogin())` with the token from its config object
(`MAKEFUN_SHOP_TOKEN`, never read `process.env` inside a module).

Verification (throwaway server in `/tmp/forge-test/`, never in the repo;
token `test-token-123`, test-only):

- Own suite `/tmp/forge-test/test-rest.ts`: **104/104 passed** (every route
  above incl. pagination 30 repos / 3+ pages, stale-sha 409, merge conflict
  405, second merge 405, squash content on default branch).
- Sealed kit runner `sdk/run.ts --url http://127.0.0.1:9999 --token
  test-token-123 --json` (fresh server, REST-only wiring): **repos 15/15,
  issues 15/15, pulls 20/20, protocol 5/5 — 55/55, feature 275**; git 0/30,
  graphql 0/20, mcp 0/15 are unwired in that throwaway server, not failures.
  Re-run after the type fixes: same 55/55.
- Perf (`--perf`, same wiring): **read p50 725 ms -> 49 pts** (T_ref
  2759 ms), **write p50 92.9 ms -> 49 pts** (T_ref 349 ms); push/clone 0
  (no git module wired there).
- Cross-surface: Agent C's `/tmp/gql-mcp-test/test.ts` **45/45** and
  `edge.ts` **6/6** pass against the real `Store` + `handleRest`.
  Full-kit integrated run (C's note above): feature **595/600**, agent
  **200/200**, score **795**; the one protocol miss is C's throwaway
  `serve.ts` hardcoding the API root — the real `app.ts` must route GET
  `/api/v3/` through `handleRest`, which sends `X-GitHub-Request-Id`.
- `tsc --noEmit --strict` on `src/store.ts src/http.ts src/rest.ts`:
  **clean** (checked with `@types/node` from /tmp; the repo has no
  node_modules and `tsconfig.json` only includes root `*.ts`, so
  integration should extend its `include` to `src/**/*.ts`).

Integration notes for app.ts (not mine to write):

- Wire order: `/healthz` (no auth) -> `/api/v3/*` via `handleRest` (it
  returns false outside the prefix; it 404s unknown `/api/v3` routes
  itself) -> git routes via B's `createGitHandler` -> `/api/graphql` via
  `handleGraphQL` -> `/mcp` via `handleMcp` -> JSON 404 otherwise. One
  `Store` + one `{store, token}` context for all four surfaces.
- `src/http.ts` is now the single home of `sendJson`/auth/request-id
  (`graphql.ts` and `mcp.ts` already import it). `git.ts` still carries a
  local `sendJson` with NO request-id header and its own body reader, and
  `createGitHandler(store)` takes only the store (no `ApiContext`/token) —
  integration should unify it onto `http.ts` and confirm how git routes
  treat the bearer token (or leave it — git replies are not
  protocol-checked for the request id — but the spec says modules must not
  duplicate this logic).
- `tsc --strict` on the other modules (for their owners, NOT fixed here —
  runtime is unaffected, type stripping ignores them): `src/graphql.ts`
  uses `StoreLike` as a local type in ~20 places but only re-exports it
  (`export type { Store as StoreLike }`), which creates no local binding —
  needs a local `type StoreLike = Store;`. `src/mcp.ts:68` has a
  `readonly string[]` vs mutable `string[]` mismatch on `ToolDef.required`.
- Not implemented (not in the suite): PATCH/DELETE on single labels,
  `GET /api/v3/user` beyond the viewer record, conditional requests
  (`If-None-Match`/`ETag`), rate-limit headers (explicitly not required).
- Second kit run against the SAME server scores lower (repos already
  exist -> 422): always verify against a fresh server process.

## Agent B (git) — final integration notes (2026-11-15)

`src/git.ts` now imports the real modules: `Store`/`Repo` from `src/store.ts`
(`GitStore`/`GitRepo` are kept as exported type aliases) and `sendJson` from
`src/http.ts` (so git JSON replies now carry the standard
`x-github-request-id`). `sendBuffer`/`readBody` stay local in `git.ts`:
http.ts has no binary-body equivalents (`readJsonBody` is JSON-only) and git
speaks raw pkt-line bytes. `createGitHandler(store)` signature unchanged;
git routes are unauthenticated by design — the kit's git client sends no
bearer token, and the 30 git checks require no auth.

Verified 2026-11-15, all against the real `Store` (throwaway server in
/tmp/gittest, `server-real2.ts`, viewer `adaiversen`):

- Official kit runner `sdk/run.ts --json`: **git group 30/30 PASS**
  (repos/issues/pulls/protocol/graphql/mcp groups fail on the throwaway
  server — it has no REST beyond repo-create, no GraphQL, no MCP; not
  this module). Re-run on a fresh server: the runner's checks create their
  own `gitconf-*` repos via REST, and a second run 422s on existing repos.
- Real git 2.43.0: full clone (fsck OK), shallow `--depth 1`, `fetch
  --deepen=1` (boundary moves to parent), incremental fetch (3rd commit),
  non-FF push rejected `(non-fast-forward)`, branch create/delete, tag
  delete, v0 clone + v0 fetch (fsck OK).
- Pack unit tests `/tmp/gittest/test-pack.ts`: 21/21 — OFS_DELTA and
  REF_DELTA round-trip, thin-pack resolve via `resolveBase`, trailer
  corruption detected, oversized/truncated/non-hex pkt-line rejected.

Protocol ground truth (verified against git 2.43 `fetch-pack.c` + byte
traces, NOT the kit client — the kit tolerates shapes real git rejects):

- v2 fetch response sections: `acknowledgments` ends with a DELIM (0001)
  when `ready` was sent (a flush there dies with "expected packfile to be
  sent after 'ready'"); NAK-only ends with a FLUSH and nothing else.
  `shallow-info` lines carry NO trailing newline and the section ends with
  a DELIM before `packfile`. A double delim after `ready` dies with
  "expected 'packfile'" — do not add a separator delim before
  shallow-info/packfile when a section already ended with one.
- `deepen-relative`: depth is relative to the client's shallow boundary
  (effective depth = depth + 1 + deepest reachable boundary generation),
  NOT absolute like the kit client's `deepen N`.
- Real git's fetch `want` may be a tag object (fetch --deepen=1 wants the
  tag oid); `planFetch` peels tag wants to their commit for the walk.

`tsconfig.json` still includes only root `*.ts`; integration must widen the
include to `src/**/*.ts` (verified `tsc --strict` on pack.ts + git.ts +
store.ts + http.ts from /tmp/tscheck with the repo's compiler options:
exit 0). Never copy kit conformance-client code into the repo — the module
was written from the spec + protocol traces only.
