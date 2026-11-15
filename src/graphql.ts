// GraphQL v4 surface: POST /api/graphql.
//
// Minimal parser + executor for exactly the documents gh and github-mcp-server send
// (see sdk/conformance/checks-graphql.ts for the full list). No full GraphQL engine:
// one recursive-descent parser over the query subset, one resolver table per type,
// opaque base64url global ids, cursor pagination over the issues connection.
//
// Auth: Bearer <token> on every call; missing/wrong -> 401 {"message": ...}.
// Unknown field -> HTTP 200 + {data: null, errors: [{message}]} naming the field.
// Unknown repository -> {data: {repository: null}} with no errors key.
// Batched JSON array bodies -> array of per-operation results, in order.
//
// Node 22 stdlib only. No import of src/store.ts: the store is typed structurally
// (StoreLike) against the BUILD-SPEC contract plus the two maps documented in
// BUILD-NOTES.md (Repo.issues / Repo.pulls), so the real Store class satisfies it
// without a code change here.

import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Store contract (structural; mirrors BUILD-SPEC + BUILD-NOTES.md additions)
// ---------------------------------------------------------------------------

export interface StoreUser {
  id: number;
  login: string;
  type: 'User' | 'Organization';
}

export interface StoreLabel {
  id: number;
  name: string;
  color: string;
}

export interface StoreComment {
  id: number;
  body: string;
  created_at: string;
}

export interface StoreIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: StoreLabel[];
  comments: StoreComment[];
  created_at: string;
  updated_at: string;
}

export interface StorePull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface StoreRepo {
  id: number;
  name: string;
  full_name: string;
  owner: StoreUser;
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  objects: Map<string, { type: string; bytes: Buffer }>;
  refs: Map<string, string>;
  issues: Map<number, StoreIssue>;
  pulls: Map<number, StorePull>;
}

export interface StoreLike {
  viewer: StoreUser;
  repos: Map<string, StoreRepo>;
  createRepo(name: string, opts: { private?: boolean; description?: string | null }): StoreRepo | null;
  getRepo(owner: string, name: string): StoreRepo | undefined;
  nextIssueNumber(repo: StoreRepo): number;
  nextPullNumber(repo: StoreRepo): number;
  nextId(): number;
  now(): string;
  getObject(repo: StoreRepo, oid: string): { type: string; bytes: Buffer } | undefined;
  putObject(repo: StoreRepo, type: string, bytes: Buffer): string;
  getRef(repo: StoreRepo, ref: string): string | undefined;
  setRef(repo: StoreRepo, ref: string, oid: string): void;
  isAncestor(repo: StoreRepo, ancestorOid: string, tipOid: string): boolean;
}

/** What app.ts passes in: the shared store plus the bearer token to enforce. */
export interface ForgeContext {
  store: StoreLike;
  token: string;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers (local until src/http.ts lands; see BUILD-NOTES.md)
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
  });
  res.end(text);
}

function sendMessage(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function authed(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Opaque global ids: base64url of "<Kind>:<ids...>" — never the raw database id.
// ---------------------------------------------------------------------------

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64decode(text: string): string | null {
  if (typeof text !== 'string' || text === '' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: StoreRepo): string {
  return b64encode(`Repository:${repo.id}`);
}

export function issueGlobalId(repo: StoreRepo, issue: StoreIssue): string {
  return b64encode(`Issue:${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: StoreRepo, pull: StorePull): string {
  return b64encode(`PullRequest:${repo.id}:${pull.number}`);
}

export function commentGlobalId(comment: StoreComment): string {
  return b64encode(`IssueComment:${comment.id}`);
}

export function userGlobalId(user: StoreUser): string {
  return b64encode(`User:${user.id}`);
}

interface DecodedId {
  kind: string;
  parts: string[];
}

/** Decode a global id; null when it is not one of ours. */
export function decodeGlobalId(id: unknown): DecodedId | null {
  if (typeof id !== 'string') return null;
  const text = b64decode(id);
  if (text === null) return null;
  const parts = text.split(':');
  const kind = parts[0];
  if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment' && kind !== 'User') return null;
  return { kind, parts };
}

/** Find a repository by numeric database id (scan: repos are keyed owner/name). */
export function findRepoById(store: StoreLike, dbid: number): StoreRepo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === dbid) return repo;
  }
  return undefined;
}

/** Opaque issue-connection cursor: base64url of "cursor:<index>". */
export function cursorFor(index: number): string {
  return b64encode(`cursor:${index}`);
}

export function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const text = b64decode(cursor);
  if (text === null) return null;
  const match = /^cursor:(\d+)$/.exec(text);
  return match === null ? null : Number(match[1]);
}

// ---------------------------------------------------------------------------
// Git object helpers: tree/commit parsing, flattening, diffing, squash merge.
// Only what GraphQL needs (PR files, mergeable, mergePullRequest). No tree
// building: a squash commit reuses the head tree oid verbatim.
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into entries. */
export function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = bytes.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > bytes.length) break;
    const mode = bytes.toString('utf8', offset, space);
    const name = bytes.toString('utf8', space + 1, nul);
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
}

/** Parse a commit object's header (tree + parents). */
export function parseCommit(bytes: Buffer): ParsedCommit {
  const text = bytes.toString('utf8');
  const head = text.split('\n\n', 1)[0] ?? '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** Flatten a tree (recursively) to path -> {oid, mode}. Missing tree -> empty map. */
export function flattenTree(store: StoreLike, repo: StoreRepo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  if (treeOid === '') return;
  const obj = store.getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.bytes)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      flattenTree(store, repo, entry.oid, path, out);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
}

export function treeOfCommit(store: StoreLike, repo: StoreRepo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = store.getObject(repo, commitOid);
  if (obj === undefined || obj.type !== 'commit') return out;
  flattenTree(store, repo, parseCommit(obj.bytes).tree, '', out);
  return out;
}

export function commitParents(store: StoreLike, repo: StoreRepo, commitOid: string): string[] {
  const obj = store.getObject(repo, commitOid);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.bytes).parents;
}

/** First ancestor of `from` (walking parents, generation order) that is also an ancestor of `to`. */
export function mergeBase(store: StoreLike, repo: StoreRepo, from: string, to: string): string | null {
  if (from === '' || to === '') return null;
  if (from === to) return from;
  if (store.isAncestor(repo, from, to)) return from;
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const parent of commitParents(store, repo, current)) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (store.isAncestor(repo, parent, to)) return parent;
      queue.push(parent);
    }
  }
  return null;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
}

/** Paths whose blob differs between two flattened trees. */
export function diffTrees(base: Map<string, { oid: string; mode: string }>, head: Map<string, { oid: string; mode: string }>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) changes.push({ path, status: 'added' });
    else if (b !== undefined && h === undefined) changes.push({ path, status: 'removed' });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) changes.push({ path, status: 'modified' });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

function tipOf(store: StoreLike, repo: StoreRepo, ref: string): string {
  return store.getRef(repo, `refs/heads/${ref}`) ?? '';
}

/**
 * Is this pull request mergeable? CONFLICTING when the same file changed differently
 * on the head side and on the base tip side since the merge base; MERGEABLE otherwise;
 * UNKNOWN when a ref needed for the answer is missing.
 */
export function computeMergeable(store: StoreLike, repo: StoreRepo, pull: StorePull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = tipOf(store, repo, pull.base.ref);
  const headTip = tipOf(store, repo, pull.head.ref) || pull.head.sha;
  if (baseTip === '' || headTip === '') return 'UNKNOWN';
  const base = mergeBase(store, repo, headTip, baseTip);
  if (base === null) return 'CONFLICTING';
  const baseTree = treeOfCommit(store, repo, base);
  const tipTree = treeOfCommit(store, repo, baseTip);
  const headTree = treeOfCommit(store, repo, headTip);
  const headChanged = new Map<string, string | null>();
  for (const change of diffTrees(baseTree, headTree)) {
    headChanged.set(change.path, change.status === 'removed' ? null : (headTree.get(change.path)?.oid ?? null));
  }
  for (const change of diffTrees(baseTree, tipTree)) {
    if (!headChanged.has(change.path)) continue;
    const tipOid = change.status === 'removed' ? null : (tipTree.get(change.path)?.oid ?? null);
    if (tipOid !== headChanged.get(change.path)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

export interface MergeOutcome {
  ok: boolean;
  sha?: string;
  reason?: string;
}

/**
 * Squash-merge a pull request: one commit on the base branch carrying the head tip's
 * tree, parented on the base tip. Mutates the pull in place (state closed, merged).
 * Returns ok:false with a reason when it cannot merge (conflict / missing refs /
 * already merged) — the caller turns that into a GraphQL/MCP error.
 */
export function mergePullRequestInStore(store: StoreLike, repo: StoreRepo, pull: StorePull): MergeOutcome {
  if (pull.merged || pull.state === 'closed') return { ok: false, reason: 'pull request is already closed' };
  const mergeable = computeMergeable(store, repo, pull);
  if (mergeable === 'CONFLICTING') return { ok: false, reason: 'merge conflict' };
  if (mergeable === 'UNKNOWN') return { ok: false, reason: 'cannot resolve head or base ref' };
  const baseTip = tipOf(store, repo, pull.base.ref);
  const headTip = tipOf(store, repo, pull.head.ref) || pull.head.sha;
  const headObj = store.getObject(repo, headTip);
  if (headObj === undefined || headObj.type !== 'commit') return { ok: false, reason: 'head commit not found' };
  const headTree = parseCommit(headObj.bytes).tree;
  const epoch = Math.floor(Date.parse(store.now()) / 1000);
  const login = store.viewer.login;
  const ident = `${login} <${login}@users.noreply.github.com> ${epoch} +0000`;
  const message = `${pull.title} (#${pull.number})`;
  const bytes = Buffer.from(
    `tree ${headTree}\nparent ${baseTip}\nauthor ${ident}\ncommitter ${ident}\n\n${message}\n`,
    'utf8',
  );
  const sha = store.putObject(repo, 'commit', bytes);
  store.setRef(repo, `refs/heads/${pull.base.ref}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = store.now();
  pull.merge_commit_sha = sha;
  return { ok: true, sha };
}

// ---------------------------------------------------------------------------
// Minimal GraphQL document parser (query/mutation subset gh sends).
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: string[];
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // Block string """...""" or plain "..." (escapes: \" \\ \/ \b \f \n \r \t \uXXXX).
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw.replace(/\\"""/g, '"""') });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const e = input[j + 1] as string;
          if (e === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[e] ?? e;
            j += 2;
          }
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.tokens[this.pos] as Token;
    if (tok.kind !== 'eof') this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected '${value}', got '${tok.value}'`);
  }

  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected a name, got '${tok.value}'`);
    if (value !== undefined && tok.value !== value) throw new Error(`expected '${value}', got '${tok.value}'`);
    return tok.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty document');
    return { operations };
  }

  private parseOperation(): OperationNode {
    const tok = this.peek();
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | undefined;
    if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
      operation = tok.value;
      this.next();
      if (this.peek().kind === 'name') name = this.next().value;
    }
    const variables = this.parseVariableDefinitions();
    // Directives on the operation (none in the documents we serve): skip "@name(args)".
    while (this.peek().kind === 'punct' && this.peek().value === '@') this.skipDirective();
    const selection = this.parseSelectionSet();
    return { operation, name, variables, selection };
  }

  private skipDirective(): void {
    this.next(); // '@'
    this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
  }

  private parseVariableDefinitions(): string[] {
    const names: string[] = [];
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return names;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated variable definitions');
      this.expectPunct('$');
      names.push(this.expectName());
      this.expectPunct(':');
      this.skipType();
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.next();
    return names;
  }

  /** Skip a type reference: Name, [T], T!, [T!]! ... */
  private skipType(): void {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      let typeCondition: string | undefined;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      while (this.peek().kind === 'punct' && this.peek().value === '@') this.skipDirective();
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    while (this.peek().kind === 'punct' && this.peek().value === '@') this.skipDirective();
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return args;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated arguments');
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.next();
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    switch (tok.kind) {
      case 'string':
        return { kind: 'string', value: tok.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(tok.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(tok.value) };
      case 'name':
        if (tok.value === 'true') return { kind: 'boolean', value: true };
        if (tok.value === 'false') return { kind: 'boolean', value: false };
        if (tok.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: tok.value };
      case 'punct':
        if (tok.value === '$') return { kind: 'variable', name: this.expectName() };
        if (tok.value === '[') {
          const values: ValueNode[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
            if (this.peek().kind === 'eof') throw new Error('unterminated list value');
            values.push(this.parseValue());
          }
          this.next();
          return { kind: 'list', values };
        }
        if (tok.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
            if (this.peek().kind === 'eof') throw new Error('unterminated object value');
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.next();
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation '${tok.value}' in a value`);
      default:
        throw new Error(`unexpected token '${tok.value}' in a value`);
    }
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  for (const arg of field.args) {
    if (arg.name === name) return resolveValue(arg.value, variables);
  }
  return undefined;
}

function argObject(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Schema tables (introspection) + field resolvers + executor.
// ---------------------------------------------------------------------------

/** A resolved field: its GraphQL object type (null for scalars) and its value. */
interface Resolved {
  t: string | null;
  v: unknown;
}

class GqlError extends Error {}

interface ExecState {
  store: StoreLike;
  vars: Record<string, unknown>;
}

/** An issue (or pull, or comment) together with its repository — ids need the repo. */
interface IssueRef {
  repo: StoreRepo;
  issue: StoreIssue;
}

interface PullRef {
  repo: StoreRepo;
  pull: StorePull;
}

interface CommentRef {
  repo: StoreRepo;
  issue: StoreIssue;
  comment: StoreComment;
}

interface ConnectionValue {
  nodes: unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null };
  totalCount: number;
}

interface TypeInfoValue {
  name: string;
  kind: string;
  fields: string[];
  enumValues: string[];
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name'],
  Label: ['id', 'name', 'color', 'description'],
  Comment: ['id', 'body', 'createdAt', 'author'],
  PullRequestChangedFile: ['path', 'status', 'additions', 'deletions', 'changes'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['CODE', 'ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeInfo(name: string): TypeInfoValue | null {
  if (name in TYPE_FIELDS) {
    return { name, kind: 'OBJECT', fields: TYPE_FIELDS[name] as string[], enumValues: [] };
  }
  if (name in ENUM_VALUES) {
    return { name, kind: 'ENUM', fields: [], enumValues: ENUM_VALUES[name] as string[] };
  }
  if (name === '__Type' || name === '__Schema' || name === '__Field' || name === '__EnumValue') {
    return { name, kind: 'OBJECT', fields: [], enumValues: [] };
  }
  return null;
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  if (bytes[bytes.length - 1] !== 0x0a) lines += 1;
  return lines;
}

function paginate<T>(items: T[], first: unknown, after: unknown): { page: T[]; pageInfo: ConnectionValue['pageInfo'] } {
  const start = decodeCursor(after) ?? -1;
  const from = start + 1;
  const count = typeof first === 'number' && first >= 0 ? Math.trunc(first) : items.length;
  const page = items.slice(from, from + count);
  const endIndex = from + page.length - 1;
  return {
    page,
    pageInfo: {
      hasNextPage: from + page.length < items.length,
      endCursor: page.length > 0 ? cursorFor(endIndex) : null,
      hasPreviousPage: from > 0,
      startCursor: page.length > 0 ? cursorFor(from) : null,
    },
  };
}

function issuesConnection(repo: StoreRepo, args: Record<string, unknown>): ConnectionValue {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => want.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  if (orderBy.field === 'COMMENTS') {
    list.sort((a, b) => (a.comments.length - b.comments.length) * direction || (a.number - b.number) * direction);
  } else {
    list.sort((a, b) => (a.number - b.number) * direction);
  }
  const { page, pageInfo } = paginate(list, args.first, args.after);
  return { nodes: page.map((issue) => ({ repo, issue }) as IssueRef), pageInfo, totalCount: list.length };
}

function pullsConnection(repo: StoreRepo, args: Record<string, unknown>): ConnectionValue {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
      return want.has(state);
    });
  }
  list.sort((a, b) => b.number - a.number);
  const { page, pageInfo } = paginate(list, args.first, args.after);
  return { nodes: page.map((pull) => ({ repo, pull }) as PullRef), pageInfo, totalCount: list.length };
}

interface ChangedFileValue {
  path: string;
  status: 'ADDED' | 'MODIFIED' | 'REMOVED';
  additions: number;
  deletions: number;
  changes: number;
}

function pullFilesConnection(store: StoreLike, repo: StoreRepo, pull: StorePull, args: Record<string, unknown>): ConnectionValue {
  const baseTip = store.getRef(repo, `refs/heads/${pull.base.ref}`) ?? '';
  const headTip = store.getRef(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseTree = baseTip === '' ? new Map() : treeOfCommit(store, repo, baseTip);
  const headTree = headTip === '' ? new Map() : treeOfCommit(store, repo, headTip);
  const files: ChangedFileValue[] = [];
  for (const change of diffTrees(baseTree, headTree)) {
    let additions = 0;
    let deletions = 0;
    if (change.status !== 'removed') {
      const headBlob = headTree.get(change.path);
      const obj = headBlob === undefined ? undefined : store.getObject(repo, headBlob.oid);
      if (obj !== undefined) additions = countLines(obj.bytes);
    }
    if (change.status !== 'added') {
      const baseBlob = baseTree.get(change.path);
      const obj = baseBlob === undefined ? undefined : store.getObject(repo, baseBlob.oid);
      if (obj !== undefined) deletions = countLines(obj.bytes);
    }
    files.push({
      path: change.path,
      status: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  const { page, pageInfo } = paginate(files, args.first, args.after);
  return { nodes: page, pageInfo, totalCount: files.length };
}

// ---------------------------------------------------------------------------
// Mutations (act on the same store objects REST reads).
// ---------------------------------------------------------------------------

/** Create an issue in the store (shared by GraphQL mutations and MCP tools). */
export function createIssueInStore(store: StoreLike, repo: StoreRepo, title: string, body: string | null): StoreIssue {
  const number = store.nextIssueNumber(repo);
  const ts = store.now();
  const issue: StoreIssue = {
    id: store.nextId(),
    number,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    created_at: ts,
    updated_at: ts,
  };
  repo.issues.set(number, issue);
  return issue;
}

/** Create a pull request in the store (shared by GraphQL mutations and MCP tools). */
export function createPullInStore(
  store: StoreLike,
  repo: StoreRepo,
  title: string,
  body: string | null,
  headRef: string,
  headSha: string,
  baseRef: string,
  baseSha: string,
): StorePull {
  const number = store.nextPullNumber(repo);
  const pull: StorePull = {
    id: store.nextId(),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
  };
  repo.pulls.set(number, pull);
  return pull;
}

function inputOf(field: FieldNode, state: ExecState): Record<string, unknown> {
  const input = argValue(field, 'input', state.vars);
  if (!isRecord(input)) throw new GqlError(`mutation ${field.name} needs an input object`);
  return input;
}

function repoFromGlobalId(store: StoreLike, id: unknown, what: string): StoreRepo {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository' || decoded.parts.length !== 2) {
    throw new GqlError(`${what} is not a repository id`);
  }
  const repo = findRepoById(store, Number(decoded.parts[1]));
  if (repo === undefined) throw new GqlError(`repository not found for ${what}`);
  return repo;
}

function issueFromGlobalId(store: StoreLike, id: unknown, what: string): IssueRef {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue' || decoded.parts.length !== 3) {
    throw new GqlError(`${what} is not an issue id`);
  }
  const repo = findRepoById(store, Number(decoded.parts[1]));
  const issue = repo?.issues.get(Number(decoded.parts[2]));
  if (repo === undefined || issue === undefined) throw new GqlError(`issue not found for ${what}`);
  return { repo, issue };
}

function pullFromGlobalId(store: StoreLike, id: unknown, what: string): PullRef {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest' || decoded.parts.length !== 3) {
    throw new GqlError(`${what} is not a pull request id`);
  }
  const repo = findRepoById(store, Number(decoded.parts[1]));
  const pull = repo?.pulls.get(Number(decoded.parts[2]));
  if (repo === undefined || pull === undefined) throw new GqlError(`pull request not found for ${what}`);
  return { repo, pull };
}

function doCreateIssue(store: StoreLike, field: FieldNode, state: ExecState): IssueRef {
  const input = inputOf(field, state);
  const repo = repoFromGlobalId(store, input.repositoryId, 'createIssue input.repositoryId');
  const title = asString(input.title);
  if (title === undefined || title === '') throw new GqlError('createIssue input.title is required');
  const body = input.body === undefined || input.body === null ? null : String(input.body);
  return { repo, issue: createIssueInStore(store, repo, title, body) };
}

function doCloseIssue(store: StoreLike, field: FieldNode, state: ExecState): IssueRef {
  const input = inputOf(field, state);
  const ref = issueFromGlobalId(store, input.issueId, 'closeIssue input.issueId');
  ref.issue.state = 'closed';
  ref.issue.updated_at = store.now();
  return ref;
}

function doAddComment(store: StoreLike, field: FieldNode, state: ExecState): { node: CommentRef; cursor: string } {
  const input = inputOf(field, state);
  const ref = issueFromGlobalId(store, input.subjectId, 'addComment input.subjectId');
  const body = asString(input.body);
  if (body === undefined) throw new GqlError('addComment input.body is required');
  const ts = store.now();
  const comment: StoreComment = { id: store.nextId(), body, created_at: ts };
  ref.issue.comments.push(comment);
  ref.issue.updated_at = ts;
  return { node: { repo: ref.repo, issue: ref.issue, comment }, cursor: cursorFor(ref.issue.comments.length - 1) };
}

function doCreatePullRequest(store: StoreLike, field: FieldNode, state: ExecState): PullRef {
  const input = inputOf(field, state);
  const repo = repoFromGlobalId(store, input.repositoryId, 'createPullRequest input.repositoryId');
  const baseRef = asString(input.baseRefName);
  const headRef = asString(input.headRefName);
  const title = asString(input.title);
  if (baseRef === undefined || headRef === undefined || title === undefined || title === '') {
    throw new GqlError('createPullRequest needs baseRefName, headRefName and title');
  }
  const baseSha = store.getRef(repo, `refs/heads/${baseRef}`);
  const headSha = store.getRef(repo, `refs/heads/${headRef}`);
  if (baseSha === undefined) throw new GqlError(`base ref ${baseRef} not found`);
  if (headSha === undefined) throw new GqlError(`head ref ${headRef} not found`);
  const body = input.body === undefined || input.body === null ? null : String(input.body);
  return { repo, pull: createPullInStore(store, repo, title, body, headRef, headSha, baseRef, baseSha) };
}

function doMergePullRequest(store: StoreLike, field: FieldNode, state: ExecState): PullRef {
  const input = inputOf(field, state);
  const ref = pullFromGlobalId(store, input.pullRequestId, 'mergePullRequest input.pullRequestId');
  const outcome = mergePullRequestInStore(store, ref.repo, ref.pull);
  if (!outcome.ok) throw new GqlError(`mergePullRequest failed: ${outcome.reason ?? 'unknown error'}`);
  return ref;
}

// ---------------------------------------------------------------------------
// Field resolution.
// ---------------------------------------------------------------------------

function unknownField(typename: string, name: string): never {
  throw new GqlError(`Field '${name}' doesn't exist on type '${typename}'`);
}

function resolveField(typename: string, value: unknown, field: FieldNode, state: ExecState): Resolved | null {
  const { store, vars } = state;
  const args = argObject(field, vars);
  switch (typename) {
    case 'Query': {
      switch (field.name) {
        case 'viewer':
          return { t: 'User', v: store.viewer };
        case 'repository': {
          const repo = asString(args.owner) !== undefined && asString(args.name) !== undefined
            ? store.getRepo(args.owner as string, args.name as string)
            : undefined;
          return repo === undefined ? null : { t: 'Repository', v: repo };
        }
        case 'node': {
          const decoded = decodeGlobalId(args.id);
          if (decoded === null) return null;
          if (decoded.kind === 'Repository') {
            const repo = findRepoById(store, Number(decoded.parts[1]));
            return repo === undefined ? null : { t: 'Repository', v: repo };
          }
          if (decoded.kind === 'Issue') {
            const repo = findRepoById(store, Number(decoded.parts[1]));
            const issue = repo?.issues.get(Number(decoded.parts[2]));
            return repo === undefined || issue === undefined ? null : { t: 'Issue', v: { repo, issue } as IssueRef };
          }
          if (decoded.kind === 'PullRequest') {
            const repo = findRepoById(store, Number(decoded.parts[1]));
            const pull = repo?.pulls.get(Number(decoded.parts[2]));
            return repo === undefined || pull === undefined ? null : { t: 'PullRequest', v: { repo, pull } as PullRef };
          }
          return null;
        }
        case '__type': {
          const info = asString(args.name) === undefined ? null : typeInfo(args.name as string);
          return info === null ? null : { t: '__Type', v: info };
        }
        case '__schema': {
          return { t: '__Schema', v: {} };
        }
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'Mutation': {
      switch (field.name) {
        case 'createIssue':
          return { t: 'CreateIssuePayload', v: { issue: doCreateIssue(store, field, state) } };
        case 'closeIssue':
          return { t: 'CloseIssuePayload', v: { issue: doCloseIssue(store, field, state) } };
        case 'addComment':
          return { t: 'AddCommentPayload', v: { commentEdge: doAddComment(store, field, state) } };
        case 'createPullRequest':
          return { t: 'CreatePullRequestPayload', v: { pullRequest: doCreatePullRequest(store, field, state) } };
        case 'mergePullRequest':
          return { t: 'MergePullRequestPayload', v: { pullRequest: doMergePullRequest(store, field, state) } };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'User': {
      const user = value as StoreUser;
      switch (field.name) {
        case 'login':
          return { t: null, v: user.login };
        case 'name':
          return { t: null, v: user.login };
        case 'id':
          return { t: null, v: userGlobalId(user) };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'Repository': {
      const repo = value as StoreRepo;
      switch (field.name) {
        case 'id':
          return { t: null, v: repoGlobalId(repo) };
        case 'databaseId':
          return { t: null, v: repo.id };
        case 'name':
          return { t: null, v: repo.name };
        case 'nameWithOwner':
          return { t: null, v: repo.full_name };
        case 'owner':
          return { t: 'User', v: repo.owner };
        case 'defaultBranchRef': {
          const ref = store.getRef(repo, `refs/heads/${repo.default_branch}`);
          return ref === undefined ? null : { t: 'Ref', v: { name: repo.default_branch } };
        }
        case 'viewerPermission':
          return { t: null, v: 'ADMIN' };
        case 'hasIssuesEnabled':
          return { t: null, v: true };
        case 'description':
          return { t: null, v: repo.description };
        case 'createdAt':
          return { t: null, v: repo.created_at };
        case 'updatedAt':
          return { t: null, v: repo.updated_at };
        case 'issue': {
          const number = asInt(args.number);
          if (number === undefined) throw new GqlError('issue(number:) needs an integer');
          const issue = repo.issues.get(number);
          return issue === undefined ? null : { t: 'Issue', v: { repo, issue } as IssueRef };
        }
        case 'issues':
          return { t: 'IssueConnection', v: issuesConnection(repo, args) };
        case 'pullRequests':
          return { t: 'PullRequestConnection', v: pullsConnection(repo, args) };
        case 'pullRequest': {
          const number = asInt(args.number);
          if (number === undefined) throw new GqlError('pullRequest(number:) needs an integer');
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : { t: 'PullRequest', v: { repo, pull } as PullRef };
        }
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'Issue': {
      const ref = value as IssueRef;
      switch (field.name) {
        case 'id':
          return { t: null, v: issueGlobalId(ref.repo, ref.issue) };
        case 'number':
          return { t: null, v: ref.issue.number };
        case 'title':
          return { t: null, v: ref.issue.title };
        case 'body':
          return { t: null, v: ref.issue.body };
        case 'state':
          return { t: null, v: ref.issue.state === 'closed' ? 'CLOSED' : 'OPEN' };
        case 'createdAt':
          return { t: null, v: ref.issue.created_at };
        case 'updatedAt':
          return { t: null, v: ref.issue.updated_at };
        case 'author':
          return { t: 'User', v: ref.repo.owner };
        case 'labels':
          return { t: 'Label', v: ref.issue.labels };
        case 'comments': {
          const nodes = ref.issue.comments.map((comment) => ({ repo: ref.repo, issue: ref.issue, comment }) as CommentRef);
          const { page, pageInfo } = paginate(nodes, args.first, args.after);
          return { t: 'IssueCommentConnection', v: { nodes: page, pageInfo, totalCount: nodes.length } as ConnectionValue };
        }
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'PullRequest': {
      const ref = value as PullRef;
      switch (field.name) {
        case 'id':
          return { t: null, v: pullGlobalId(ref.repo, ref.pull) };
        case 'number':
          return { t: null, v: ref.pull.number };
        case 'title':
          return { t: null, v: ref.pull.title };
        case 'body':
          return { t: null, v: ref.pull.body };
        case 'state':
          return { t: null, v: ref.pull.merged ? 'MERGED' : ref.pull.state === 'closed' ? 'CLOSED' : 'OPEN' };
        case 'merged':
          return { t: null, v: ref.pull.merged };
        case 'headRefName':
          return { t: null, v: ref.pull.head.ref };
        case 'baseRefName':
          return { t: null, v: ref.pull.base.ref };
        case 'headRef':
          return { t: 'Ref', v: { name: ref.pull.head.ref } };
        case 'baseRef':
          return { t: 'Ref', v: { name: ref.pull.base.ref } };
        case 'mergeable':
          return { t: null, v: computeMergeable(store, ref.repo, ref.pull) };
        case 'files':
          return { t: 'PullRequestChangedFileConnection', v: pullFilesConnection(store, ref.repo, ref.pull, args) };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': {
      const conn = value as ConnectionValue;
      switch (field.name) {
        case 'nodes':
          return { t: conn.nodes.length > 0 ? nodeTypeOf(typename) : nodeTypeOf(typename), v: conn.nodes };
        case 'pageInfo':
          return { t: 'PageInfo', v: conn.pageInfo };
        case 'totalCount':
          return { t: null, v: conn.totalCount };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'PageInfo': {
      const info = value as ConnectionValue['pageInfo'];
      switch (field.name) {
        case 'hasNextPage':
          return { t: null, v: info.hasNextPage };
        case 'hasPreviousPage':
          return { t: null, v: info.hasPreviousPage };
        case 'startCursor':
          return { t: null, v: info.startCursor };
        case 'endCursor':
          return { t: null, v: info.endCursor };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'PullRequestChangedFile': {
      const file = value as ChangedFileValue;
      switch (field.name) {
        case 'path':
          return { t: null, v: file.path };
        case 'status':
          return { t: null, v: file.status };
        case 'additions':
          return { t: null, v: file.additions };
        case 'deletions':
          return { t: null, v: file.deletions };
        case 'changes':
          return { t: null, v: file.changes };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'Ref': {
      const ref = value as { name: string };
      if (field.name === 'name') return { t: null, v: ref.name };
      return unknownField(typename, field.name);
    }
    case 'Label': {
      const label = value as StoreLabel;
      switch (field.name) {
        case 'id':
          return { t: null, v: b64encode(`Label:${label.id}`) };
        case 'name':
          return { t: null, v: label.name };
        case 'color':
          return { t: null, v: label.color };
        case 'description':
          return { t: null, v: null };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'Comment': {
      const ref = value as CommentRef;
      switch (field.name) {
        case 'id':
          return { t: null, v: commentGlobalId(ref.comment) };
        case 'body':
          return { t: null, v: ref.comment.body };
        case 'createdAt':
          return { t: null, v: ref.comment.created_at };
        case 'author':
          return { t: 'User', v: ref.repo.owner };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'CommentEdge': {
      const edge = value as { node: CommentRef; cursor: string };
      switch (field.name) {
        case 'node':
          return { t: 'Comment', v: edge.node };
        case 'cursor':
          return { t: null, v: edge.cursor };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = value as { issue: IssueRef };
      if (field.name === 'issue') return { t: 'Issue', v: payload.issue };
      if (field.name === 'clientMutationId') return { t: null, v: null };
      return unknownField(typename, field.name);
    }
    case 'AddCommentPayload': {
      const payload = value as { commentEdge: { node: CommentRef; cursor: string }; subject?: IssueRef };
      switch (field.name) {
        case 'commentEdge':
          return { t: 'CommentEdge', v: payload.commentEdge };
        case 'subject':
          return payload.subject === undefined ? null : { t: 'Issue', v: payload.subject };
        case 'clientMutationId':
          return { t: null, v: null };
        default:
          return unknownField(typename, field.name);
      }
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = value as { pullRequest: PullRef };
      if (field.name === 'pullRequest') return { t: 'PullRequest', v: payload.pullRequest };
      if (field.name === 'clientMutationId') return { t: null, v: null };
      return unknownField(typename, field.name);
    }
    case '__Type': {
      const info = value as TypeInfoValue;
      switch (field.name) {
        case 'name':
          return { t: null, v: info.name };
        case 'kind':
          return { t: null, v: info.kind };
        case 'description':
          return { t: null, v: null };
        case 'fields':
          return { t: '__Field', v: info.fields.map((name) => ({ name })) };
        case 'enumValues':
          return { t: '__EnumValue', v: info.enumValues.map((name) => ({ name })) };
        default:
          return unknownField(typename, field.name);
      }
    }
    case '__Field':
    case '__EnumValue': {
      const entry = value as { name: string };
      switch (field.name) {
        case 'name':
          return { t: null, v: entry.name };
        case 'description':
          return { t: null, v: null };
        default:
          return unknownField(typename, field.name);
      }
    }
    case '__Schema': {
      switch (field.name) {
        case 'types':
          return {
            t: '__Type',
            v: [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => typeInfo(name) as TypeInfoValue),
          };
        case 'queryType':
          return { t: '__Type', v: typeInfo('Query') };
        case 'mutationType':
          return { t: '__Type', v: typeInfo('Mutation') };
        case 'description':
          return { t: null, v: null };
        default:
          return unknownField(typename, field.name);
      }
    }
    default:
      return unknownField(typename, field.name);
  }
}

/** Element type of a connection's nodes, by connection type name. */
function nodeTypeOf(connection: string): string {
  switch (connection) {
    case 'IssueConnection':
      return 'Issue';
    case 'PullRequestConnection':
      return 'PullRequest';
    case 'PullRequestChangedFileConnection':
      return 'PullRequestChangedFile';
    case 'IssueCommentConnection':
      return 'Comment';
    default:
      return 'Issue';
  }
}

// ---------------------------------------------------------------------------
// Executor + HTTP handler.
// ---------------------------------------------------------------------------

function execSelection(typename: string, value: unknown, selections: SelectionNode[], state: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== undefined && sel.typeCondition !== typename) continue;
      Object.assign(out, execSelection(typename, value, sel.selection, state));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typename;
      continue;
    }
    const resolved = resolveField(typename, value, sel, state);
    if (resolved === null || resolved.v === null || resolved.v === undefined) {
      out[key] = null;
      continue;
    }
    if (sel.selection !== undefined) {
      if (Array.isArray(resolved.v)) {
        out[key] = resolved.v.map((item) =>
          item === null ? null : execSelection(resolved.t ?? typename, item, sel.selection as SelectionNode[], state),
        );
      } else if (typeof resolved.v === 'object') {
        out[key] = execSelection(resolved.t ?? typename, resolved.v, sel.selection, state);
      } else {
        out[key] = resolved.v;
      }
    } else {
      out[key] = resolved.v;
    }
  }
  return out;
}

export interface GraphQLOperationInput {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GraphQLResult {
  data: unknown;
  errors?: { message: string }[];
}

/** Run one operation document against the store. Never throws for GraphQL-level failures. */
export function executeGraphQL(store: StoreLike, op: GraphQLOperationInput): GraphQLResult {
  let doc: DocumentNode;
  try {
    doc = new Parser(op.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = op.operationName !== undefined
    ? (doc.operations.find((entry) => entry.name === op.operationName) ?? doc.operations[0])
    : doc.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation found in document' }] };
  const state: ExecState = { store, vars: op.variables ?? {} };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  try {
    return { data: execSelection(rootType, null, operation.selection, state) };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

function operationInput(entry: unknown): GraphQLOperationInput | null {
  if (!isRecord(entry) || typeof entry.query !== 'string') return null;
  return {
    query: entry.query,
    variables: isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {},
    operationName: typeof entry.operationName === 'string' ? entry.operationName : undefined,
  };
}

/**
 * POST /api/graphql. Single object body or a JSON array of operations (batched).
 * Auth first (401), malformed JSON (400); GraphQL-level failures are HTTP 200.
 */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, ctx: ForgeContext): Promise<void> {
  if (req.method !== 'POST') {
    sendMessage(res, 405, 'Method Not Allowed');
    return;
  }
  if (!authed(req, ctx.token)) {
    sendMessage(res, 401, 'Requires authentication');
    return;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendMessage(res, 400, 'request body too large');
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    sendMessage(res, 400, 'request body is not valid JSON');
    return;
  }
  try {
    if (Array.isArray(body)) {
      const results = body.map((entry) => {
        const op = operationInput(entry);
        return op === null
          ? { data: null, errors: [{ message: 'each batched operation needs a query string' }] }
          : executeGraphQL(ctx.store, op);
      });
      sendJson(res, 200, results);
      return;
    }
    const op = operationInput(body);
    if (op === null) {
      sendMessage(res, 400, 'a query string is required');
      return;
    }
    sendJson(res, 200, executeGraphQL(ctx.store, op));
  } catch (err) {
    sendMessage(res, 500, err instanceof Error ? err.message : 'internal error');
  }
}
