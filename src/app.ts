// app.ts — the whole forge, wired into one server.
//
// One Store, one ApiContext {store, token}, shared by all four surfaces so a repo,
// issue or pull created on one surface reads back identically on the others:
//   - GET  /healthz            -> 200 {"ok": true} (no auth; the env's boot check)
//   - /api/v3 and /api/v3/*    -> handleRest (REST v3; includes GET /api/v3/ itself,
//                                so the root answer carries X-GitHub-Request-Id)
//   - POST /api/graphql        -> handleGraphQL
//   - POST /mcp                -> handleMcp
//   - /{owner}/{repo}.git/*    -> git smart HTTP (upload-pack v2/v0, receive-pack v0;
//                                unauthenticated by design — the kit's git client
//                                sends no bearer token)
//   - anything else            -> 404 {"message": "Not Found"}
//
// The viewer login is the sealed scenario's (adaiversen, id 1000), re-derived from
// the kit seed by scenarioViewerLogin() in store.ts — the bearer token carries no
// login. The token comes from MAKEFUN_SHOP_TOKEN at process start; the modules
// themselves never read process.env. Nothing here binds a port or exits: main.ts
// owns the lifecycle, this file only builds the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, scenarioViewerLogin } from './store.ts';
import { sendJson, type ApiContext } from './http.ts';
import { handleRest } from './rest.ts';
import { createGitHandler } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store(scenarioViewerLogin());
  const ctx: ApiContext = { store, token: process.env.MAKEFUN_SHOP_TOKEN ?? '' };
  const git = createGitHandler(store);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = (req.method ?? 'GET').toUpperCase();

        // The env's boot check calls this twice: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3, including the GET /api/v3/ root (handleRest answers it with
        // X-OAuth-Scopes and the shared X-GitHub-Request-Id header).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, ctx)) return;
        }

        // GraphQL v4 and MCP: POST only; anything else on these paths is a 404.
        if (method === 'POST' && path === '/api/graphql') {
          await handleGraphQL(req, res, ctx);
          return;
        }
        if (method === 'POST' && path === '/mcp') {
          await handleMcp(req, res, ctx);
          return;
        }

        // Git smart HTTP. The handler returns true when the path is a git route
        // (it answers 404 itself for a missing repo); false falls through.
        // It reads POST bodies asynchronously, so a true return means "handled",
        // even though the bytes may still be in flight.
        if (git(req, res)) return;

        // Everything else, every method: GitHub's 404 body.
        if (!res.writableEnded) sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler threw after routing: never leave the socket hanging, and
        // never leak a stack — the suite only ever needs a JSON error body.
        if (!res.writableEnded) sendJson(res, 500, { message: (err as Error).message });
      }
    })();
  });
}
