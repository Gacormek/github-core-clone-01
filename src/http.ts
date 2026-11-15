// Shared HTTP helpers for every surface of the forge (REST, git, GraphQL, MCP).
// Every module imports these instead of duplicating the protocol discipline:
//   - every JSON reply carries Content-Type: application/json and a monotonic
//     X-GitHub-Request-Id: req-<counter> (counter per process, starts at 1)
//   - error bodies always carry a string `message`
//   - auth is one Bearer comparison against the injected token
//   - pagination honours per_page/page and emits an absolute same-origin Link header
//
// Ownership note (BUILD-SPEC module map): Agent A owns this file. Agents B and C import
// sendJson / sendError / bearerToken / isAuthenticated / readJsonBody / paginate from
// here; they do not reimplement them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** What every surface handler receives: the store and the one bearer token. */
export interface ApiContext {
  store: Store;
  token: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/** The next request id: `req-1`, `req-2`, … — one counter per process. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body, always with the JSON content type and a request id. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with no body (e.g. 204), still carrying the request id. */
export function sendNoContent(res: ServerResponse, status = 204): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** Answer with `{"message": <string>}` plus the standard JSON headers. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The bearer token on the request, if the Authorization header carries one. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return match === null ? null : (match[1] ?? '').trim();
}

/** True when the request presents exactly the injected token (empty token never matches). */
export function isAuthenticated(req: IncomingMessage, token: string): boolean {
  if (token === '') return false;
  const presented = bearerToken(req);
  return presented !== null && presented === token;
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query of a request URL, or an empty set when it does not parse. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The request's origin (`http://host`), from its Host header. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return `http://${typeof host === 'string' && host !== '' ? host : '127.0.0.1'}`;
}

/** An absolute same-origin URL for `pathname` with `query` attached. */
export function absoluteUrl(req: IncomingMessage, pathname: string, query: Readonly<Record<string, string>>): string {
  const url = new URL(pathname, originOf(req));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

export type BodyResult =
  | { ok: true; value: unknown } // `value` is undefined when the body is empty
  | { ok: false; error: string };

/**
 * Read the whole request body and parse it as JSON. An empty body is not an error
 * (value undefined); anything unparsable is `{ok:false}` so the caller answers 400.
 */
export async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > MAX_BODY_BYTES) return { ok: false, error: 'request body too large' };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: 'could not read request body' };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'malformed JSON body' };
  }
}

// ---------------------------------------------------------------------------
// Pagination: `page` (default 1) and `per_page` (default 30, clamped 1..100).

export interface PageParams {
  page: number;
  perPage: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const rawPage = Number(query.get('page'));
  const rawPerPage = Number(query.get('per_page'));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  const perPage = Number.isFinite(rawPerPage)
    ? Math.min(100, Math.max(1, Math.trunc(rawPerPage)))
    : 30;
  return { page, perPage };
}

export interface PageResult<T> {
  items: T[];
  /** The Link header value, or null when there is only one page. */
  link: string | null;
}

/**
 * Slice `items` to the requested page and build the Link header from the request's
 * own URL (same origin, all other query parameters preserved). `next` appears only
 * when a later page exists; `last` is included whenever there is more than one page.
 */
export function paginate<T>(req: IncomingMessage, items: readonly T[], params: PageParams): PageResult<T> {
  const { page, perPage } = params;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (totalPages <= 1) return { items: pageItems, link: null };
  const base = new URL(req.url ?? '/', originOf(req));
  const linkFor = (target: number): string => {
    const url = new URL(base);
    url.searchParams.set('page', String(target));
    url.searchParams.set('per_page', String(perPage));
    return `<${url.toString()}>`;
  };
  const relations: string[] = [`${linkFor(1)}; rel="first"`];
  if (page > 1) relations.push(`${linkFor(page - 1)}; rel="prev"`);
  if (page < totalPages) relations.push(`${linkFor(page + 1)}; rel="next"`);
  relations.push(`${linkFor(totalPages)}; rel="last"`);
  return { items: pageItems, link: relations.join(', ') };
}

// ---------------------------------------------------------------------------
// Small JSON-body readers for handlers (defensive, never throw).

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}
