// git.ts — smart-HTTP git surface: info/refs, upload-pack (v2 + v0 fallback),
// receive-pack (v0 only).
//
// Routes (no auth on git routes; the peer always sends a Bearer token anyway):
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//
// Protocol, exactly as sdk/conformance/git-client.ts (the suite's peer) speaks it:
//   - upload-pack v2 only when the request carries `Git-Protocol: version=2`:
//     advertisement `version 2` + capabilities fetch / ls-refs / object-format=sha1.
//     Commands: ls-refs (ref-prefix server-side, symrefs, peel, unborn) and fetch
//     (want/have/done, shallow/deepen, sideband band 1 pack + band 2 progress,
//     no band 3; only objects the client lacks).
//   - upload-pack v0 fallback when no version=2 header: `# service=` preamble,
//     ref list with capabilities on the first line, side-band-64k fetch.
//   - receive-pack v0 only: preamble + capabilities report-status, side-band-64k,
//     delete-refs. Push is fast-forward only; a non-FF ref reports exactly
//     `ng <ref> non-fast-forward`, the ref does not move, unpack stays ok, and
//     other FF refs in the same push still apply.
//   - Malformed input never crashes the handler: it answers 400 JSON and the
//     server keeps serving.
//
// No import of src/store.ts: the store is typed structurally (GitStore/GitRepo)
// against the BUILD-SPEC contract, so the real Store class satisfies it.
// Local sendJson/readBody helpers are temporary until src/http.ts lands;
// integration should unify them (see BUILD-NOTES.md).
//
// Node 22 stdlib only. Never process.exit, never binds a port, never reads env.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  encodePktLine,
  encodePktLines,
  encodeSideband,
  hashObject,
  isObjectId,
  parseTag,
  parseTree,
  pktLineFlush,
  readPack,
  verifyPackChecksum,
  writePack,
} from './pack.ts';
import type { GitObject, GitObjectType } from './pack.ts';

// ---------------------------------------------------------------------------
// Store contract (structural; mirrors BUILD-SPEC src/store.ts)
// ---------------------------------------------------------------------------

export interface GitUser {
  id: number;
  login: string;
  type: 'User' | 'Organization';
}

export interface GitRepo {
  id: number;
  name: string;
  full_name: string;
  owner: GitUser;
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  objects: Map<string, { type: string; bytes: Buffer }>;
  refs: Map<string, string>;
}

export interface GitStore {
  getRepo(owner: string, name: string): GitRepo | undefined;
  getObject(repo: GitRepo, oid: string): { type: string; bytes: Buffer } | undefined;
  putObject(repo: GitRepo, type: string, bytes: Buffer): string;
  getRef(repo: GitRepo, ref: string): string | undefined;
  setRef(repo: GitRepo, ref: string, oid: string): void;
  deleteRef(repo: GitRepo, ref: string): boolean;
  isAncestor(repo: GitRepo, ancestorOid: string, tipOid: string): boolean;
}

// ---------------------------------------------------------------------------
// Local HTTP helpers (temporary; src/http.ts owns these at integration)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

const AGENT = 'muse-git-forge/1.0';

interface ListedRef {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** HEAD's target ref, from the repo's HEAD entry or the default branch. */
function headTarget(repo: GitRepo): string {
  const head = repo.refs.get('HEAD');
  if (head && head.startsWith('ref: ')) return head.slice(5);
  return `refs/heads/${repo.default_branch}`;
}

/** The oid HEAD points at, or undefined when the branch is unborn. */
function headOid(store: GitStore, repo: GitRepo): string | undefined {
  const oid = store.getRef(repo, headTarget(repo));
  return oid && oid !== ZERO_OID ? oid : undefined;
}

/** Peel an annotated tag (recursively) to its commit, or undefined. */
function peelToCommit(store: GitStore, repo: GitRepo, oid: string): string | undefined {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = store.getObject(repo, current);
    if (!obj) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      try {
        current = parseTag(obj.bytes).object;
      } catch {
        return undefined;
      }
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** All refs/heads/* and refs/tags/*, sorted by name. */
function sortedRefs(repo: GitRepo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/') && oid !== ZERO_OID) out.push({ name, oid });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The ls-refs view: HEAD line plus every ref, with peel/symref attributes. */
function listRefs(store: GitStore, repo: GitRepo, opts: { peel: boolean; symrefs: boolean }): ListedRef[] {
  const refs = sortedRefs(repo);
  const out: ListedRef[] = [];
  const tip = headOid(store, repo);
  const target = headTarget(repo);
  if (tip) {
    out.push({ name: 'HEAD', oid: tip, symrefTarget: opts.symrefs ? target : undefined });
  } else {
    out.push({ name: 'HEAD', oid: ZERO_OID, unborn: true, symrefTarget: opts.symrefs ? target : undefined });
  }
  for (const ref of refs) {
    const entry: ListedRef = { name: ref.name, oid: ref.oid };
    if (opts.symrefs && ref.name === target) entry.symrefTarget = undefined;
    if (opts.peel) {
      const obj = store.getObject(repo, ref.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(store, repo, ref.oid);
        if (peeled) entry.peeled = peeled;
      }
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'fetch=shallow wait-for-done filter\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

function v0Advertisement(store: GitStore, repo: GitRepo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const target = headTarget(repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed object-format=sha1 symref=HEAD:${target} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta object-format=sha1 symref=HEAD:${target} agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktLineFlush()];
  if (service === 'git-receive-pack') {
    parts[0] = encodePktLine('# service=git-receive-pack\n');
  }
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = headOid(store, repo);
    let first = true;
    if (tip) {
      parts.push(encodePktLine(first ? `${tip} HEAD\0${caps}\n` : `${tip} HEAD\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(encodePktLine(first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
      first = false;
      const obj = store.getObject(repo, ref.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(store, repo, ref.oid);
        if (peeled) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: GitStore,
  repo: GitRepo,
  service: 'git-upload-pack' | 'git-receive-pack',
): void {
  const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantV2) {
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    return;
  }
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  sendBuffer(res, 200, contentType, v0Advertisement(store, repo, service));
}

// ---------------------------------------------------------------------------
// Request pkt-line parsing
// ---------------------------------------------------------------------------

interface ParsedPackets {
  /** Data-packet texts in order; control packets split sections. */
  sections: string[][];
}

/**
 * Split a request body into sections separated by flush packets (delim
 * packets split the command line from its arguments inside section 0).
 * Throws on malformed pkt-lines. Trailing bytes after the last flush are
 * returned as `rest` (the raw pack in a receive-pack request).
 */
function parseRequestPackets(body: Buffer): { sections: string[][]; rest: Buffer } {
  const sections: string[][] = [[]];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in request');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      // A flush ends the framed part when the next bytes are not a pkt-line
      // (receive-pack pack data) — the caller decides by looking at `rest`.
      // Here: if more bytes follow and they do not parse as a pkt-line, they
      // are raw data; otherwise start a new section.
      if (offset < body.length) {
        const next = body.subarray(offset, Math.min(body.length, offset + 4)).toString('ascii');
        if (body.length - offset < 4 || !/^[0-9a-fA-F]{4}$/.test(next)) {
          return { sections, rest: body.subarray(offset) };
        }
      }
      sections.push([]);
      continue;
    }
    if (length === 1) {
      offset += 4;
      sections.push([]);
      continue;
    }
    if (length === 2) {
      offset += 4;
      sections.push([]);
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > body.length) throw new Error('truncated pkt-line in request');
    sections[sections.length - 1].push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { sections, rest: Buffer.alloc(0) };
}

/** All data lines of all sections, in order. */
function allLines(sections: string[][]): string[] {
  return sections.flat();
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

function narrowType(raw: string): GitObjectType | null {
  return raw === 'commit' || raw === 'tree' || raw === 'blob' || raw === 'tag' ? raw : null;
}

function getTypedObject(store: GitStore, repo: GitRepo, oid: string): GitObject | undefined {
  const obj = store.getObject(repo, oid);
  if (!obj) return undefined;
  const type = narrowType(obj.type);
  if (!type) return undefined;
  return { type, data: obj.bytes };
}

/** Commit headers without a full parse: tree + parents. */
function commitLinks(data: Buffer): { tree: string; parents: string[] } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents };
}

/**
 * Every object reachable from `roots`, following commit -> tree + parents,
 * tag -> target, tree -> entries (gitlinks skipped). `stopAt` commits are
 * included but their parents are NOT followed (a shallow boundary: the
 * client holds the commit but none of its history). Missing objects are
 * skipped when `allowMissing` is set, otherwise they throw.
 */
function collectReachable(
  store: GitStore,
  repo: GitRepo,
  roots: Iterable<string>,
  opts: { stopAt?: ReadonlySet<string>; allowMissing?: boolean } = {},
): Map<string, GitObject> {
  const seen = new Map<string, GitObject>();
  const stack: string[] = [];
  for (const root of roots) if (isObjectId(root)) stack.push(root);
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = getTypedObject(store, repo, oid);
    if (!object) {
      if (opts.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.set(oid, object);
    if (object.type === 'commit') {
      const { tree, parents } = commitLinks(object.data);
      if (tree) stack.push(tree);
      if (!opts.stopAt?.has(oid)) for (const parent of parents) stack.push(parent);
    } else if (object.type === 'tag') {
      try {
        stack.push(parseTag(object.data).object);
      } catch {
        // A corrupt tag still counts as an object; its target is unreachable.
      }
    } else if (object.type === 'tree') {
      try {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          stack.push(entry.oid);
        }
      } catch {
        // Corrupt tree: no children to follow.
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to put in the pack, in walk order. */
  send: Map<string, GitObject>;
  /** New shallow boundary commits (depth cutoff). */
  shallow: string[];
  /** Old client boundaries that are no longer shallow. */
  unshallow: string[];
  /** Haves the server acknowledges as common. */
  acks: string[];
}

/**
 * Plan a fetch. `depth` null means full history. With a depth, generations
 * are counted from the wants: generation 0 is the wanted commits, generation
 * d holds their parents at distance d; generations 0..depth-1 are included.
 * The client's `shallow` boundaries truncate the have-closure: the client
 * holds those commits but not their parents.
 */
function planFetch(
  store: GitStore,
  repo: GitRepo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  const stopAt = new Set(clientShallow);
  const haveReachable = collectReachable(store, repo, haves, { stopAt, allowMissing: true });

  // Peel tag wants to their commit; the tag object itself is still sent.
  const wantCommits: string[] = [];
  const extraRoots: string[] = [];
  for (const want of wants) {
    const obj = getTypedObject(store, repo, want);
    if (!obj) throw new Error(`want ${want} not found`);
    if (obj.type === 'tag') {
      const peeled = peelToCommit(store, repo, want);
      if (peeled) wantCommits.push(peeled);
      extraRoots.push(want);
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    } else {
      extraRoots.push(want);
    }
  }

  const included = new Map<string, GitObject>();
  const boundary = new Set<string>();
  if (depth === null) {
    for (const [oid, obj] of collectReachable(store, repo, [...wantCommits, ...extraRoots], { allowMissing: false })) {
      included.set(oid, obj);
    }
  } else {
    // BFS by generation over commits; trees/blobs of included commits join too.
    let frontier = [...new Set(wantCommits)];
    const includedCommits = new Set<string>();
    for (let gen = 0; gen < depth && frontier.length; gen += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (includedCommits.has(oid)) continue;
        includedCommits.add(oid);
        const obj = getTypedObject(store, repo, oid);
        if (!obj || obj.type !== 'commit') continue;
        const { tree, parents } = commitLinks(obj.data);
        if (tree) {
          for (const [childOid, child] of collectReachable(store, repo, [tree], { allowMissing: true })) {
            included.set(childOid, child);
          }
        }
        included.set(oid, obj);
        if (gen === depth - 1) boundary.add(oid);
        else for (const parent of parents) next.push(parent);
      }
      frontier = [...new Set(next)];
    }
    // Root commits reached before the cutoff are boundaries too: nothing
    // lies beyond them, and recording them keeps deepen a no-op past them.
    for (const oid of includedCommits) {
      if (boundary.has(oid)) continue;
      const obj = included.get(oid);
      if (obj && obj.type === 'commit' && commitLinks(obj.data).parents.length === 0) boundary.add(oid);
    }
    for (const root of extraRoots) {
      for (const [oid, obj] of collectReachable(store, repo, [root], { allowMissing: false })) {
        included.set(oid, obj);
      }
    }
  }

  const send = new Map<string, GitObject>();
  for (const [oid, obj] of included) {
    if (!haveReachable.has(oid)) send.set(oid, obj);
  }

  const unshallow: string[] = [];
  for (const old of clientShallow) {
    if (included.has(old) && !boundary.has(old)) unshallow.push(old);
  }

  const acks: string[] = [];
  for (const have of haves) {
    if (!getTypedObject(store, repo, have)) continue;
    if (haveReachable.has(have) && wants.some((w) => w === have || safeIsAncestor(store, repo, have, w))) {
      acks.push(have);
    }
  }

  return { send, shallow: [...boundary], unshallow, acks };
}

function safeIsAncestor(store: GitStore, repo: GitRepo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  try {
    return store.isAncestor(repo, ancestor, tip);
  } catch {
    return false;
  }
}

/** Pack bytes for a plan (empty pack when nothing is new). */
function packForPlan(plan: FetchPlan): Buffer {
  return writePack([...plan.send.values()].map((obj) => ({ type: obj.type, data: obj.data })));
}

// ---------------------------------------------------------------------------
// upload-pack: ls-refs (v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

function handleLsRefs(
  res: ServerResponse,
  store: GitStore,
  repo: GitRepo,
  lines: string[],
): void {
  const args = parseLsRefsArgs(lines);
  const refs = listRefs(store, repo, { peel: args.peel, symrefs: args.symrefs });
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      if (!args.unborn) continue;
      const attrs = ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      out.push(`unborn ${ref.name}${attrs}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([encodePktLines(out), pktLineFlush()]));
}

// ---------------------------------------------------------------------------
// upload-pack: fetch (v2 + v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const oid = text.slice(5, 45);
      if (isObjectId(oid)) args.wants.push(oid);
    } else if (text.startsWith('have ')) {
      const oid = text.slice(5, 45);
      if (isObjectId(oid)) args.haves.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8, 48);
      if (isObjectId(oid)) args.shallow.push(oid);
    } else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(n) && n >= 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not,
    // agent, object-format, done: accepted and (for filter/deepen-since/
    // deepen-not) treated as no-ops — the full depth window is sent.
  }
  return args;
}

/** Deduplicate, preserving order. */
function uniq(oids: string[]): string[] {
  return [...new Set(oids)];
}

function handleFetchV2(
  res: ServerResponse,
  store: GitStore,
  repo: GitRepo,
  lines: string[],
): void {
  const args = parseFetchArgs(lines);
  args.wants = uniq(args.wants);
  args.haves = uniq(args.haves);
  args.shallow = uniq(args.shallow);
  if (args.wants.length === 0) {
    // No wants: an empty, well-formed response (the client never sends this,
    // but a bare POST must not hang).
    sendBuffer(
      res,
      200,
      'application/x-git-upload-pack-result',
      Buffer.concat([encodePktLines(['acknowledgments\n', 'NAK\n']), pktLineFlush()]),
    );
    return;
  }
  let plan: FetchPlan;
  try {
    plan = planFetch(store, repo, args.wants, args.haves, args.shallow, args.depth);
  } catch (err) {
    // Unknown want: report it on the error band inside the packfile section.
    const parts: Buffer[] = [encodePktLines(['acknowledgments\n', 'NAK\n']), pktLineFlush()];
    parts.push(encodePktLine('packfile\n'));
    parts.push(encodeSideband(3, Buffer.from(`ERR ${(err as Error).message}\n`, 'utf8')));
    parts.push(pktLineFlush());
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const pack = packForPlan(plan);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktLineFlush());
  if (args.depth !== null) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineFlush());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(encodeSideband(1, pack));
  parts.push(pktLineFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV0(
  res: ServerResponse,
  store: GitStore,
  repo: GitRepo,
  lines: string[],
): void {
  const args = parseFetchArgs(lines);
  args.wants = uniq(args.wants);
  args.haves = uniq(args.haves);
  args.shallow = uniq(args.shallow);
  if (args.wants.length === 0) {
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([encodePktLine('NAK\n'), pktLineFlush()]));
    return;
  }
  let plan: FetchPlan;
  try {
    plan = planFetch(store, repo, args.wants, args.haves, args.shallow, args.depth);
  } catch (err) {
    const parts: Buffer[] = [encodePktLine('NAK\n')];
    parts.push(encodeSideband(3, Buffer.from(`ERR ${(err as Error).message}\n`, 'utf8')));
    parts.push(pktLineFlush());
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const pack = packForPlan(plan);
  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(encodeSideband(1, pack));
  parts.push(pktLineFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: GitStore,
  repo: GitRepo,
  body: Buffer,
): void {
  const wantV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  let sections: string[][];
  try {
    sections = parseRequestPackets(body).sections;
  } catch (err) {
    sendJson(res, 400, { message: `malformed pkt-line request: ${(err as Error).message}` });
    return;
  }
  if (wantV2) {
    // The command line is the first data line; everything after it (on
    // either side of the delim packet) is arguments.
    const lines = allLines(sections);
    const first = lines[0] ?? '';
    const command = first.replace(/\n$/, '').split(' ')[0];
    const argLines = lines.slice(1);
    if (command === 'command=ls-refs') {
      handleLsRefs(res, store, repo, argLines);
      return;
    }
    if (command === 'command=fetch') {
      handleFetchV2(res, store, repo, argLines);
      return;
    }
    sendJson(res, 400, { message: `unknown upload-pack v2 command ${JSON.stringify(command)}` });
    return;
  }
  // v0: want/have lines across sections; the first want may carry capabilities.
  handleFetchV0(res, store, repo, allLines(sections));
}

// ---------------------------------------------------------------------------
// receive-pack (v0 only)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Parse a receive-pack body: pkt-lined commands up to the first flush, then
 * raw pack bytes. Returns the commands, the requested capabilities, and the
 * pack (empty when the push is delete-only).
 */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; capabilities: Set<string>; pack: Buffer } {
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  let first = true;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > body.length) throw new Error('truncated pkt-line in receive-pack');
    let line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const token of line.slice(nul + 1).replace(/\n$/, '').split(' ')) {
          if (token) capabilities.add(token);
        }
        line = line.slice(0, nul);
      }
      first = false;
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 80))}`);
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('receive-pack command has a bad object id');
    if (!ref.startsWith('refs/')) throw new Error(`receive-pack command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, capabilities, pack: body.subarray(offset) };
}

/** One ref's verdict in the report-status stream. */
interface RefVerdict {
  ref: string;
  ok: boolean;
  reason: string;
}

function reportStatusBody(unpackOk: boolean, unpackDetail: string, verdicts: RefVerdict[]): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const verdict of verdicts) {
    lines.push(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`);
  }
  // The report stream is itself pkt-lined and ends with a flush.
  return Buffer.concat([encodePktLines(lines), pktLineFlush()]);
}

function sendReceiveReport(
  res: ServerResponse,
  sideband: boolean,
  unpackOk: boolean,
  unpackDetail: string,
  verdicts: RefVerdict[],
): void {
  const report = reportStatusBody(unpackOk, unpackDetail, verdicts);
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([encodeSideband(1, report), pktLineFlush()]);
  } else {
    // Without sideband the report stream goes out as one pkt-line payload.
    body = Buffer.concat([encodePktLine(report), pktLineFlush()]);
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', body);
}

function handleReceivePack(
  res: ServerResponse,
  store: GitStore,
  repo: GitRepo,
  body: Buffer,
): void {
  let parsed: { commands: PushCommand[]; capabilities: Set<string>; pack: Buffer };
  try {
    parsed = parseReceivePack(body);
  } catch (err) {
    sendJson(res, 400, { message: `malformed receive-pack request: ${(err as Error).message}` });
    return;
  }
  const { commands, capabilities, pack } = parsed;
  const sideband = capabilities.has('side-band-64k');
  const wantReport = capabilities.has('report-status') || capabilities.has('report-status-v2');

  if (commands.length === 0) {
    if (wantReport) sendReceiveReport(res, sideband, true, 'ok', []);
    else sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([encodePktLine('unpack ok\n'), pktLineFlush()]));
    return;
  }

  const hasUpdates = commands.some((cmd) => cmd.newOid !== ZERO_OID);
  let unpacked: Map<string, GitObject> | null = null;
  if (hasUpdates || pack.length > 0) {
    if (pack.length === 0) {
      sendReceiveReport(res, sideband, false, 'no pack received', []);
      return;
    }
    try {
      const read = readPack(pack, {
        resolveBase: (oid) => getTypedObject(store, repo, oid),
      });
      if (!read.checksumOk) throw new Error('pack trailer checksum mismatch');
      unpacked = read.objects;
    } catch (err) {
      sendReceiveReport(res, sideband, false, `unpack error: ${(err as Error).message}`, []);
      return;
    }
  }

  // Store every unpacked object first (unpack happens before ref checks).
  if (unpacked) {
    for (const [oid, obj] of unpacked) {
      const stored = store.putObject(repo, obj.type, obj.data);
      if (stored !== oid) {
        sendReceiveReport(res, sideband, false, `object ${oid} stored as ${stored}`, []);
        return;
      }
    }
  }

  // Connectivity: every new tip's reachable graph must be present, so a
  // ref never points at history the server does not hold.
  for (const cmd of commands) {
    if (cmd.newOid === ZERO_OID) continue;
    try {
      collectReachable(store, repo, [cmd.newOid], { allowMissing: false });
    } catch (err) {
      sendReceiveReport(res, sideband, false, `unresolved objects for ${cmd.ref}: ${(err as Error).message}`, []);
      return;
    }
  }

  const verdicts: RefVerdict[] = [];
  for (const cmd of commands) {
    const current = store.getRef(repo, cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        verdicts.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        verdicts.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      store.deleteRef(repo, cmd.ref);
      verdicts.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // Create / update.
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        verdicts.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      if (current === undefined) {
        verdicts.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (cmd.oldOid !== current) {
        verdicts.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (cmd.oldOid === cmd.newOid) {
        verdicts.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (!canFastForward(store, repo, cmd.oldOid, cmd.newOid)) {
        verdicts.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    store.setRef(repo, cmd.ref, cmd.newOid);
    verdicts.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  if (wantReport) {
    sendReceiveReport(res, sideband, true, 'ok', verdicts);
    return;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([encodePktLine('unpack ok\n'), pktLineFlush()]));
}

/** Fast-forward: new tip descends from old tip (commit-to-commit only). */
function canFastForward(store: GitStore, repo: GitRepo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const oldObj = getTypedObject(store, repo, oldOid);
  const newObj = getTypedObject(store, repo, newOid);
  if (!oldObj || !newObj) return false;
  if (oldObj.type !== 'commit' || newObj.type !== 'commit') return false;
  return safeIsAncestor(store, repo, oldOid, newOid);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Handle one request. Returns true when the path is a git route (the
 * response is sent, possibly asynchronously); false when app.ts should
 * keep routing (not a git path, or a wrong method on one).
 *
 * `store` is the forge store (BUILD-SPEC contract). Unknown repo -> 404 JSON;
 * malformed git input -> 400 JSON; the server never throws out of this call.
 */
export function createGitHandler(store: GitStore): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return false;
    }
    const match = GIT_PATH.exec(path);
    if (!match) return false;
    const method = req.method ?? 'GET';
    const owner = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    const route = match[3];

    if (route === 'info/refs' && method !== 'GET') return false;
    if (route !== 'info/refs' && method !== 'POST') return false;

    const repo = store.getRepo(owner, name);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    if (route === 'info/refs') {
      let service: string;
      try {
        service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
      } catch {
        service = '';
      }
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      try {
        handleInfoRefs(req, res, store, repo, service);
      } catch (err) {
        sendJson(res, 500, { message: (err as Error).message });
      }
      return true;
    }

    readBody(req).then(
      (body) => {
        try {
          if (route === 'git-upload-pack') handleUploadPack(req, res, store, repo, body);
          else handleReceivePack(res, store, repo, body);
        } catch (err) {
          if (!res.writableEnded) sendJson(res, 500, { message: (err as Error).message });
        }
      },
      (err) => {
        if (!res.writableEnded) sendJson(res, 400, { message: `could not read request body: ${(err as Error).message}` });
      },
    );
    return true;
  };
}

/** Re-exported for tests and for other modules that build packs. */
export { hashObject, readPack, writePack, verifyPackChecksum };
export type { GitObjectType, GitObject };
