// MCP surface: POST /mcp, JSON-RPC 2.0 Streamable HTTP (plain JSON answers).
//
// Two eras, both served:
//   (a) 2026-07-28: server/discover -> {supportedVersions, capabilities, serverInfo};
//       every request declares its revision in _meta (read, never enforced).
//   (b) legacy: initialize -> {protocolVersion, capabilities:{tools:{}}, serverInfo},
//       then notifications/initialized (202, no body).
//
// tools/list serves >=6 tools, built once and frozen, so two calls stringify
// byte-identical. tools/call maps argument synonyms (owner_login, full_name,
// head_ref, pr_number, ...) onto the canonical names, and acts on the same
// store REST and GraphQL use.
//
// Wire errors: unknown tool -> -32601, missing required argument -> -32602,
// non-JSON body -> HTTP 400 + -32700, no auth -> HTTP 401. Never HTTP 500.
//
// Node 22 stdlib only. The JSON/auth/body helpers come from src/http.ts (one
// per-process X-GitHub-Request-Id counter); merge logic is shared with
// src/graphql.ts. Handlers take the shared ApiContext ({store, token}).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthenticated, readJsonBody, sendError, sendJson, sendNoContent, type ApiContext } from './http.ts';
import {
  createIssueInStore,
  createPullInStore,
  mergePullRequestInStore,
  repoGlobalId,
  type StoreIssue,
  type StoreLike,
  type StorePull,
  type StoreRepo,
} from './graphql.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Server identity + protocol versions.
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

// ---------------------------------------------------------------------------
// Tools: built once, frozen, stringified from the same object every time.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, Record<string, unknown>>, required: string[]): ToolDef {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({ type: 'object' as const, properties: Object.freeze(properties), required: Object.freeze(required) }),
  });
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a repository owned by the authenticated user.', {
    name: { type: 'string', description: 'Repository name.' },
    description: { type: 'string', description: 'Repository description.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Issue title.' },
    body: { type: 'string', description: 'Issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository, optionally filtered by state.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    state: { type: 'string', description: 'Issue state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Pull request title.' },
    head: { type: 'string', description: 'Head branch name.' },
    base: { type: 'string', description: 'Base branch name.' },
    body: { type: 'string', description: 'Pull request body.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number (squash merge onto the base branch).', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    pull_number: { type: 'integer', description: 'Pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
]);

// ---------------------------------------------------------------------------
// Argument synonyms (github-mcp-server shapes + the suite's documented map).
// ---------------------------------------------------------------------------

function pick(args: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (args[key] !== undefined) return args[key];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Canonical arguments for a tool call, accepting every documented synonym. */
interface CanonicalArgs {
  owner?: string;
  repo?: string;
  name?: string;
  description?: string;
  private?: boolean;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  pull_number?: number;
  state?: string;
}

function canonicalArgs(args: Record<string, unknown>): CanonicalArgs {
  const out: CanonicalArgs = {};
  const owner = asString(pick(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']));
  const repo = asString(pick(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']));
  const fullName = asString(pick(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']));
  if (owner !== undefined) out.owner = owner;
  if (repo !== undefined) out.repo = repo;
  if (out.repo === undefined && fullName !== undefined && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2) as [string, string];
    if (o !== '' && r !== '') {
      out.owner = o;
      out.repo = r;
    }
  }
  const name = asString(pick(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']));
  if (name !== undefined) out.name = name;
  const description = asString(pick(args, ['description', 'about', 'summary']));
  if (description !== undefined) out.description = description;
  const priv = asBool(pick(args, ['private', 'is_private']));
  if (priv !== undefined) out.private = priv;
  const title = asString(pick(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']));
  if (title !== undefined) out.title = title;
  const body = asString(pick(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']));
  if (body !== undefined) out.body = body;
  const head = asString(pick(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']));
  if (head !== undefined) out.head = head;
  const base = asString(pick(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']));
  if (base !== undefined) out.base = base;
  const pullNumber = asInt(pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']));
  if (pullNumber !== undefined) out.pull_number = pullNumber;
  const state = asString(pick(args, ['state', 'status']));
  if (state !== undefined) out.state = state;
  return out;
}

// ---------------------------------------------------------------------------
// Store access + tool implementations.
// ---------------------------------------------------------------------------

function repoJson(repo: StoreRepo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner.login, id: repo.owner.id, node_id: repoGlobalId(repo), type: repo.owner.type },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueJson(issue: StoreIssue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullJson(pull: StorePull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
  };
}

/** Tool result envelope: human-readable text plus structured content. */
function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolErr(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function findRepo(store: StoreLike, args: CanonicalArgs): StoreRepo | null {
  const owner = args.owner ?? store.viewer.login;
  const repo = args.repo;
  if (repo === undefined) return null;
  return store.getRepo(owner, repo) ?? null;
}

/** Missing required canonical arguments, in declaration order. */
function missingArgs(args: CanonicalArgs, required: readonly (keyof CanonicalArgs)[]): string[] {
  return required.filter((key) => args[key] === undefined);
}

type ToolOutcome =
  | { kind: 'result'; value: Record<string, unknown> }
  | { kind: 'invalidParams'; message: string };

function callTool(store: StoreLike, name: string, rawArgs: Record<string, unknown>): ToolOutcome {
  const args = canonicalArgs(rawArgs);
  switch (name) {
    case 'create_repo': {
      const missing = missingArgs(args, ['name']);
      if (missing.length > 0) return { kind: 'invalidParams', message: `missing required argument(s): ${missing.join(', ')}` };
      const repo = store.createRepo(args.name as string, { private: args.private, description: args.description ?? null });
      if (repo === null) return { kind: 'result', value: toolErr(`Repository already exists: ${store.viewer.login}/${args.name}`) };
      return { kind: 'result', value: toolOk(repoJson(repo)) };
    }
    case 'get_repo': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length > 0) return { kind: 'invalidParams', message: `missing required argument(s): ${missing.join(', ')}` };
      const repo = findRepo(store, args);
      if (repo === null) return { kind: 'result', value: toolErr(`Not Found: ${args.owner}/${args.repo}`) };
      return { kind: 'result', value: toolOk(repoJson(repo)) };
    }
    case 'create_issue': {
      const missing = missingArgs(args, ['owner', 'repo', 'title']);
      if (missing.length > 0) return { kind: 'invalidParams', message: `missing required argument(s): ${missing.join(', ')}` };
      const repo = findRepo(store, args);
      if (repo === null) return { kind: 'result', value: toolErr(`Not Found: ${args.owner}/${args.repo}`) };
      const issue = createIssueInStore(store, repo, args.title as string, args.body ?? null);
      return { kind: 'result', value: toolOk(issueJson(issue)) };
    }
    case 'list_issues': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length > 0) return { kind: 'invalidParams', message: `missing required argument(s): ${missing.join(', ')}` };
      const repo = findRepo(store, args);
      if (repo === null) return { kind: 'result', value: toolErr(`Not Found: ${args.owner}/${args.repo}`) };
      const state = (args.state ?? 'open').toLowerCase();
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(issue));
      return { kind: 'result', value: toolOk(issues) };
    }
    case 'create_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing.length > 0) return { kind: 'invalidParams', message: `missing required argument(s): ${missing.join(', ')}` };
      const repo = findRepo(store, args);
      if (repo === null) return { kind: 'result', value: toolErr(`Not Found: ${args.owner}/${args.repo}`) };
      const headSha = store.getRef(repo, `refs/heads/${args.head as string}`);
      const baseSha = store.getRef(repo, `refs/heads/${args.base as string}`);
      if (headSha === undefined) return { kind: 'result', value: toolErr(`head ref not found: ${args.head}`) };
      if (baseSha === undefined) return { kind: 'result', value: toolErr(`base ref not found: ${args.base}`) };
      const pull = createPullInStore(store, repo, args.title as string, args.body ?? null, args.head as string, headSha, args.base as string, baseSha);
      return { kind: 'result', value: toolOk(pullJson(pull)) };
    }
    case 'merge_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'pull_number']);
      if (missing.length > 0) return { kind: 'invalidParams', message: `missing required argument(s): ${missing.join(', ')}` };
      const repo = findRepo(store, args);
      if (repo === null) return { kind: 'result', value: toolErr(`Not Found: ${args.owner}/${args.repo}`) };
      const pull = repo.pulls.get(args.pull_number as number);
      if (pull === undefined) return { kind: 'result', value: toolErr(`pull request not found: #${args.pull_number}`) };
      const outcome = mergePullRequestInStore(store, repo, pull);
      if (!outcome.ok) return { kind: 'result', value: toolErr(`merge failed: ${outcome.reason ?? 'unknown error'}`) };
      return { kind: 'result', value: toolOk({ ...pullJson(pull), merged: true, sha: outcome.sha }) };
    }
    default:
      return { kind: 'invalidParams', message: `unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatch.
// ---------------------------------------------------------------------------

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function discoverResult(): Record<string, unknown> {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

/**
 * Answer one JSON-RPC request object. Returns null for a notification (the
 * caller answers 202 with an empty body); otherwise the response object.
 */
function dispatchRpc(store: StoreLike, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = 'id' in request ? request.id : undefined;
  const isNotification = id === undefined;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    if (isNotification) return null;
    return rpcError(id, INVALID_REQUEST, 'request method must be a non-empty string');
  }
  if (method.startsWith('notifications/')) return null;
  if (isNotification) return null;

  const params = isRecord(request.params) ? request.params : {};

  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      if (offered !== undefined && !SUPPORTED_VERSIONS.includes(offered)) {
        return rpcError(id, INVALID_PARAMS, `unsupported protocol version: ${offered}`);
      }
      return rpcResult(id, {
        protocolVersion: offered ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : undefined;
      if (name === undefined) return rpcError(id, INVALID_PARAMS, 'tools/call needs a tool name');
      if (!TOOLS.some((entry) => entry.name === name)) {
        return rpcError(id, METHOD_NOT_FOUND, `unknown tool: ${name}`);
      }
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const outcome = callTool(store, name, args);
      if (outcome.kind === 'invalidParams') return rpcError(id, INVALID_PARAMS, outcome.message);
      return rpcResult(id, outcome.value);
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

/**
 * POST /mcp. Auth first (401), non-JSON body (HTTP 400 + -32700), notifications
 * (202, empty body), everything else a single JSON-RPC response (HTTP 200).
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }
  if (!isAuthenticated(req, ctx.token)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok || parsed.value === undefined) {
    // A body that is not JSON (or an empty body) is a JSON-RPC parse error.
    sendJson(res, 400, rpcError(null, PARSE_ERROR, 'Parse error'));
    return;
  }
  const body: unknown = parsed.value;
  if (Array.isArray(body)) {
    sendJson(res, 400, rpcError(null, INVALID_REQUEST, 'batch requests are not supported'));
    return;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, rpcError(null, INVALID_REQUEST, 'request must be a JSON-RPC object'));
    return;
  }
  const answer = dispatchRpc(ctx.store, body);
  if (answer === null) {
    sendNoContent(res, 202);
    return;
  }
  sendJson(res, 200, answer);
}
