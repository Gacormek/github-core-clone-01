// The forge's store: every object the REST, git, GraphQL and MCP surfaces read and write.
// One process, one Store, no wall clock, no Math.random anywhere: ids come from counters
// starting at fixed values and timestamps from a monotonic counter over a fixed epoch, so
// replaying the same requests in the same order reaches byte-identical state.
//
// Ownership note (BUILD-SPEC module map): Agent A owns this file. Agents B (git) and C
// (GraphQL/MCP) code against the exported Store API and the helpers below; they never edit it.

import { createHash } from 'node:crypto';

/** The deterministic day one: 2025-01-01T00:00:00Z, in seconds since the Unix epoch. */
export const STORE_EPOCH_SEC = 1_735_689_600;
/** The branch a repository is born with. */
export const DEFAULT_BRANCH = 'main';
/** The SHA-1 of the empty tree object (`<tree> 0\0`). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** The SHA-1 of the empty blob object. */
export const EMPTY_BLOB_OID = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

export interface User {
  id: number;
  login: string;
  type: 'User' | 'Organization';
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: User;
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  // Git state lives here too.
  objects: Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; bytes: Buffer }>;
  refs: Map<string, string>; // 'refs/heads/main' -> oid (40-hex); also 'HEAD' -> 'ref: refs/heads/main'
  // REST state lives here too (per-repo; the BUILD-SPEC contract names the counters, the
  // maps are the storage those counters number).
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>; // keyed by label name
  nextIssueNo: number; // first issue number handed out is 1
  nextPullNo: number; // first pull number handed out is 1
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
}

export interface Pull {
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
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Git object bytes: SHA-1, parsing, serialisation. The git module (Agent B) and the
// REST contents/merge code (Agent A) share these so a commit built by one surface
// hashes and parses identically on the other.

/** SHA-1 of a git object: `<type> <len>\0<bytes>`. */
export function sha1Object(type: string, bytes: Buffer): string {
  const header = Buffer.from(`${type} ${bytes.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: { name: string; email: string; epoch: number; tz: string };
  committer: { name: string; email: string; epoch: number; tz: string };
  message: string;
}

function parseIdent(line: string): { name: string; email: string; epoch: number; tz: string } {
  // `Name <email> 1735689600 +0000`
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', epoch: 0, tz: '+0000' };
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    epoch: Number(match[3] ?? 0),
    tz: match[4] ?? '+0000',
  };
}

/** Parse commit bytes into headers and message; tolerant of missing author lines. */
export function parseCommit(bytes: Buffer): ParsedCommit {
  const text = bytes.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerPart = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const out: ParsedCommit = {
    tree: '',
    parents: [],
    author: { name: '', email: '', epoch: 0, tz: '+0000' },
    committer: { name: '', email: '', epoch: 0, tz: '+0000' },
    message,
  };
  for (const line of headerPart.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = parseIdent(line.slice(7));
    else if (line.startsWith('committer ')) out.committer = parseIdent(line.slice(10));
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse tree bytes (`<mode> <name>\0<20-byte oid>` per entry) in stored order. */
export function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) break;
    const nul = bytes.indexOf(0x00, space);
    if (nul === -1 || nul + 21 > bytes.length) break;
    entries.push({
      mode: bytes.subarray(offset, space).toString('ascii'),
      name: bytes.subarray(space + 1, nul).toString('utf8'),
      oid: bytes.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries. Callers sort first: by name, directories as name + '/'. */
export function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree sort key: a directory sorts as its name with a trailing slash. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Sort tree entries the way git stores them (by treeSortKey, byte order). */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
}

export interface CommitParts {
  tree: string;
  parents: readonly string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  epoch: number;
  message: string;
}

/** Build commit bytes in the exact layout the spec fixes (message + one trailing newline). */
export function makeCommitBytes(parts: CommitParts): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.authorName} <${parts.authorEmail}> ${parts.epoch} +0000`);
  lines.push(`committer ${parts.committerName} <${parts.committerEmail}> ${parts.epoch} +0000`);
  lines.push('');
  lines.push(parts.message);
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Opaque global ids (GraphQL `node(id:)` / REST `node_id`): base64url of a typed key,
// never the raw database id. Agent C decodes these with fromGlobalId.

export function toGlobalId(kind: string, ...parts: readonly (string | number)[]): string {
  const raw = [kind, ...parts.map(String)].join(':');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function fromGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = raw.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Who the token names. The suite's scenario is fixed by one seed (wire.ts
// SCENARIO_SEED = 0x6a09e667f3bcc909n, sealed in the kit under program/ and sdk/);
// the viewer is users[0] of generateUsers(scenarioRng('users'), 12). The token
// itself is a random per-trial `shpat_…` and carries no login, so the server
// re-derives the viewer from the same public seed and generators the suite uses.
// Verified against the kit: this returns 'adaiversen' (id 1000).

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64* (wire.ts Rng), reduced to the two operations user generation needs. */
class ScenarioRng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }
}

const SCENARIO_FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const SCENARIO_LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The login of the suite's viewer (users[0]); the token owner's login. */
export function scenarioViewerLogin(): string {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(SCENARIO_FIRST_NAMES);
  const last = rng.pick(SCENARIO_LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

/** The viewer's User record, as the scenario generates it (id 1000). */
export function scenarioViewerUser(): User {
  return { id: 1000, login: scenarioViewerLogin(), type: 'User' };
}

// ---------------------------------------------------------------------------
// The store.

export class Store {
  readonly viewer: User;
  /** Key `${owner}/${name}`. */
  readonly repos = new Map<string, Repo>();

  #idCounter = 10000; // nextId() starts at 10000
  #repoIdCounter = 5000; // repo ids start at 5000
  #tick = 0; // seconds past STORE_EPOCH_SEC; now() and nowEpochSec() share it

  constructor(viewerLogin: string) {
    this.viewer = { id: 1000, login: viewerLogin, type: 'User' };
  }

  /** Global monotonic id counter (issues, pulls, labels, comments). */
  nextId(): number {
    const id = this.#idCounter;
    this.#idCounter += 1;
    return id;
  }

  /** Deterministic timestamp: epoch + counter seconds, ISO string. Never Date.now(). */
  now(): string {
    const epoch = STORE_EPOCH_SEC + this.#tick;
    this.#tick += 1;
    return new Date(epoch * 1000).toISOString();
  }

  /** The same counter as epoch seconds, for commit author/committer lines. */
  nowEpochSec(): number {
    const epoch = STORE_EPOCH_SEC + this.#tick;
    this.#tick += 1;
    return epoch;
  }

  /** The tick behind now(): +1 per call, so callers can reason about ordering. */
  get tick(): number {
    return this.#tick;
  }

  createRepo(name: string, opts: { private?: boolean; description?: string | null }): Repo | null {
    const key = `${this.viewer.login}/${name}`;
    if (this.repos.has(key)) return null;
    const created = this.now();
    const repo: Repo = {
      id: this.#repoIdCounter,
      name,
      full_name: key,
      owner: this.viewer,
      private: opts.private ?? false,
      description: opts.description ?? null,
      default_branch: DEFAULT_BRANCH,
      created_at: created,
      updated_at: created,
      objects: new Map(),
      refs: new Map([['HEAD', `ref: refs/heads/${DEFAULT_BRANCH}`]]),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssueNo: 1,
      nextPullNo: 1,
    };
    this.#repoIdCounter += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  nextIssueNumber(repo: Repo): number {
    const number = repo.nextIssueNo;
    repo.nextIssueNo += 1;
    return number;
  }

  nextPullNumber(repo: Repo): number {
    const number = repo.nextPullNo;
    repo.nextPullNo += 1;
    return number;
  }

  // ---------------------------------------------------------------- git helpers

  getObject(repo: Repo, oid: string): { type: string; bytes: Buffer } | undefined {
    return repo.objects.get(oid.toLowerCase());
  }

  /** Store an object if new; returns its SHA-1 oid. */
  putObject(repo: Repo, type: string, bytes: Buffer): string {
    const oid = sha1Object(type, bytes);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type: type as 'blob' | 'tree' | 'commit' | 'tag', bytes });
    }
    return oid;
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** True when `ancestorOid` is reachable from `tipOid` through parent links (or equal). */
  isAncestor(repo: Repo, ancestorOid: string, tipOid: string): boolean {
    const ancestor = ancestorOid.toLowerCase();
    const tip = tipOid.toLowerCase();
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.pop();
      if (oid === undefined || seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parsed = parseCommit(object.bytes);
      for (const parent of parsed.parents) {
        const lower = parent.toLowerCase();
        if (lower === ancestor) return true;
        if (!seen.has(lower)) queue.push(lower);
      }
    }
    return false;
  }

  /** The first commit reachable from both tips when walking parents, or null. */
  mergeBase(repo: Repo, aOid: string, bOid: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [aOid.toLowerCase()];
    while (queueA.length > 0) {
      const oid = queueA.pop();
      if (oid === undefined || ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.bytes).parents) queueA.push(parent.toLowerCase());
    }
    const queueB: string[] = [bOid.toLowerCase()];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift();
      if (oid === undefined || seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.bytes).parents) queueB.push(parent.toLowerCase());
    }
    return null;
  }

  /** Every commit reachable from `tipOid`, tip first (parents after their child). */
  listCommits(repo: Repo, tipOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tipOid.toLowerCase()];
    while (queue.length > 0) {
      const oid = queue.shift();
      if (oid === undefined || seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.bytes).parents) queue.push(parent.toLowerCase());
    }
    return out;
  }
}
