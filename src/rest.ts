// GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments, pull requests and squash merges, exactly as BUILD-SPEC fixes them.
// Auth is Bearer <MAKEFUN_SHOP_TOKEN> on every /api/v3 route; a repository under any
// owner but the token's login is a 404, never a 403. All state lives in the Store;
// the store starts empty and everything is created through this API.
//
// Ownership note (BUILD-SPEC module map): Agent A owns this file. Agents B and C read
// state through the Store, never through these handlers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EMPTY_TREE_OID,
  buildTreeBytes,
  makeCommitBytes,
  parseCommit,
  parseTree,
  sortTreeEntries,
  toGlobalId,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  absoluteUrl,
  asRecord,
  asString,
  asStringArray,
  isAuthenticated,
  paginate,
  pageParams,
  pathOf,
  queryOf,
  readJsonBody,
  sendError,
  sendJson,
  sendNoContent,
  type ApiContext,
} from './http.ts';

export type RestContext = ApiContext;

// ---------------------------------------------------------------------------
// JSON shapes (GitHub-close; only the fields the suite reads are load-bearing,
// the rest are present so a real client sees a familiar repository).

function userJson(store: Store): Record<string, unknown> {
  const viewer = store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: toGlobalId('User', viewer.id),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${viewer.login}`,
    html_url: `/users/${viewer.login}`,
    type: viewer.type,
    site_admin: false,
  };
}

function repoJson(req: IncomingMessage, store: Store, repo: Repo): Record<string, unknown> {
  const origin = absoluteUrl(req, '/', {});
  const host = origin.replace(/\/$/, '');
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: toGlobalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.full_name,
    owner: userJson(store),
    private: repo.private,
    html_url: `${host}/${repo.full_name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.full_name}`,
    archive_url: `/api/v3/repos/${repo.full_name}/{archive_format}{/ref}`,
    assignees_url: `/api/v3/repos/${repo.full_name}/assignees{/user}`,
    blobs_url: `/api/v3/repos/${repo.full_name}/git/blobs{/sha}`,
    branches_url: `/api/v3/repos/${repo.full_name}/branches{/branch}`,
    clone_url: `${host}/${repo.full_name}.git`,
    collaborators_url: `/api/v3/repos/${repo.full_name}/collaborators{/collaborator}`,
    comments_url: `/api/v3/repos/${repo.full_name}/comments{/number}`,
    commits_url: `/api/v3/repos/${repo.full_name}/commits{/sha}`,
    compare_url: `/api/v3/repos/${repo.full_name}/compare/{base}...{head}`,
    contents_url: `/api/v3/repos/${repo.full_name}/contents/{+path}`,
    contributors_url: `/api/v3/repos/${repo.full_name}/contributors`,
    deployments_url: `/api/v3/repos/${repo.full_name}/deployments`,
    downloads_url: `/api/v3/repos/${repo.full_name}/downloads`,
    events_url: `/api/v3/repos/${repo.full_name}/events`,
    forks_url: `/api/v3/repos/${repo.full_name}/forks`,
    git_commits_url: `/api/v3/repos/${repo.full_name}/git/commits{/sha}`,
    git_refs_url: `/api/v3/repos/${repo.full_name}/git/refs{/sha}`,
    git_tags_url: `/api/v3/repos/${repo.full_name}/git/tags{/sha}`,
    git_url: `${host}/${repo.full_name}.git`,
    issue_comment_url: `/api/v3/repos/${repo.full_name}/issues/comments{/number}`,
    issue_events_url: `/api/v3/repos/${repo.full_name}/issues/events{/number}`,
    issues_url: `/api/v3/repos/${repo.full_name}/issues{/number}`,
    keys_url: `/api/v3/repos/${repo.full_name}/keys{/key_id}`,
    labels_url: `/api/v3/repos/${repo.full_name}/labels{/name}`,
    languages_url: `/api/v3/repos/${repo.full_name}/languages`,
    merges_url: `/api/v3/repos/${repo.full_name}/merges`,
    milestones_url: `/api/v3/repos/${repo.full_name}/milestones{/number}`,
    notifications_url: `/api/v3/repos/${repo.full_name}/notifications{?since,all,participating}`,
    pulls_url: `/api/v3/repos/${repo.full_name}/pulls{/number}`,
    releases_url: `/api/v3/repos/${repo.full_name}/releases{/id}`,
    ssh_url: `git@${new URL(host).host}:${repo.full_name}.git`,
    stargazers_url: `/api/v3/repos/${repo.full_name}/stargazers`,
    statuses_url: `/api/v3/repos/${repo.full_name}/statuses/{sha}`,
    subscribers_url: `/api/v3/repos/${repo.full_name}/subscribers`,
    subscription_url: `/api/v3/repos/${repo.full_name}/subscription`,
    tags_url: `/api/v3/repos/${repo.full_name}/tags`,
    teams_url: `/api/v3/repos/${repo.full_name}/teams`,
    trees_url: `/api/v3/repos/${repo.full_name}/git/trees{/sha}`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    default_branch: repo.default_branch,
    open_issues_count: openIssues,
    is_template: false,
    topics: [],
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    pushed_at: repo.updated_at,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_rebase_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_update_branch: false,
    delete_branch_on_merge: false,
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: toGlobalId('Label', label.id),
    url: `/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: null,
  };
}

function issueJson(req: IncomingMessage, store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: toGlobalId('Issue', repo.id, issue.number),
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.full_name}`,
    labels_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/events`,
    html_url: `/repos/${repo.full_name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body ?? '',
    user: userJson(store),
    labels: issue.labels.map((label) => labelJson(repo, label)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    closed_at: null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: toGlobalId('IssueComment', repo.id, issue.number, comment.id),
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `/repos/${repo.full_name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(store),
    created_at: comment.created_at,
    updated_at: comment.created_at,
    author_association: 'OWNER',
  };
}

function pullJson(req: IncomingMessage, store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: toGlobalId('PullRequest', repo.id, pull.number),
    url: `/api/v3/repos/${repo.full_name}/pulls/${pull.number}`,
    html_url: `/repos/${repo.full_name}/pull/${pull.number}`,
    diff_url: `/repos/${repo.full_name}/pull/${pull.number}.diff`,
    patch_url: `/repos/${repo.full_name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.full_name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body ?? '',
    user: userJson(store),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? (pull.merged_at ?? pull.updated_at) : null,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.full_name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.full_name}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.full_name}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.full_name}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.full_name}/statuses/${pull.head.sha}`,
    head: {
      label: `${store.viewer.login}:${pull.head.ref}`,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: userJson(store),
      repo: repoJson(req, store, repo),
    },
    base: {
      label: `${store.viewer.login}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: userJson(store),
      repo: repoJson(req, store, repo),
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: null,
    rebaseable: null,
    mergeable_state: 'unknown',
    merged_by: null,
  };
}

// ---------------------------------------------------------------------------
// Git state helpers: everything the contents and pull endpoints do to trees.
// A tree is flattened to path -> blob oid only when a diff or a lookup needs it;
// writes rebuild only the trees on the changed path, reusing every other oid.

/** Resolve a branch name (or a raw 40-hex oid) to a commit oid, or undefined. */
function resolveTip(store: Store, repo: Repo, ref: string): string | undefined {
  const fromBranch = store.getRef(repo, `refs/heads/${ref}`);
  if (fromBranch !== undefined) return fromBranch;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const object = store.getObject(repo, ref);
    if (object !== undefined && object.type === 'commit') return ref.toLowerCase();
  }
  return undefined;
}

/** The tree oid of a commit, or undefined when the commit is unknown. */
function treeOfCommit(store: Store, repo: Repo, commitOid: string): string | undefined {
  const object = store.getObject(repo, commitOid);
  if (object === undefined || object.type !== 'commit') return undefined;
  return parseCommit(object.bytes).tree;
}

interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) to `path -> {oid, mode}` for files only. */
function flattenTree(store: Store, repo: Repo, treeOid: string, prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const object = store.getObject(repo, treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.bytes)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(store, repo, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** The blob oid at `path` in the tree, or undefined. */
function blobAtPath(store: Store, repo: Repo, treeOid: string, path: string): string | undefined {
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = store.getObject(repo, current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.bytes).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return entry.mode === '40000' ? undefined : entry.oid;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** The direct entries of the tree at `path` ('' is the root), or undefined. */
function treeAtPath(
  store: Store,
  repo: Repo,
  treeOid: string,
  path: string,
): { oid: string; entries: { mode: string; name: string; oid: string }[] } | undefined {
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = store.getObject(repo, current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.bytes).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  const object = store.getObject(repo, current);
  if (object === undefined || object.type !== 'tree') return undefined;
  return { oid: current, entries: parseTree(object.bytes) };
}

function storeTree(store: Store, repo: Repo, entries: { mode: string; name: string; oid: string }[]): string {
  return store.putObject(repo, 'tree', buildTreeBytes(sortTreeEntries(entries)));
}

/**
 * A new tree with `path` holding `blobOid` (creating intermediate trees as needed).
 * `baseTreeOid` may be null (unborn branch): the file lands in a fresh tree.
 */
function writePathToTree(
  store: Store,
  repo: Repo,
  baseTreeOid: string | null,
  segments: readonly string[],
  blobOid: string,
): string {
  if (segments.length === 0) return baseTreeOid ?? EMPTY_TREE_OID;
  const [head, ...rest] = segments as [string, ...string[]];
  const baseEntries: { mode: string; name: string; oid: string }[] = [];
  if (baseTreeOid !== null) {
    const object = store.getObject(repo, baseTreeOid);
    if (object !== undefined && object.type === 'tree') baseEntries.push(...parseTree(object.bytes));
  }
  const existing = baseEntries.find((entry) => entry.name === head);
  if (rest.length === 0) {
    const next = baseEntries.filter((entry) => entry.name !== head);
    next.push({ mode: '100644', name: head, oid: blobOid });
    return storeTree(store, repo, next);
  }
  const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
  const nextChild = writePathToTree(store, repo, childTree, rest, blobOid);
  const next = baseEntries.filter((entry) => entry.name !== head);
  next.push({ mode: '40000', name: head, oid: nextChild });
  return storeTree(store, repo, next);
}

/** A new tree with `path` removed (empty intermediate trees are pruned). */
function removePathFromTree(
  store: Store,
  repo: Repo,
  baseTreeOid: string,
  segments: readonly string[],
): string {
  if (segments.length === 0) return baseTreeOid;
  const [head, ...rest] = segments as [string, ...string[]];
  const object = store.getObject(repo, baseTreeOid);
  if (object === undefined || object.type !== 'tree') return baseTreeOid;
  const baseEntries = parseTree(object.bytes);
  const existing = baseEntries.find((entry) => entry.name === head);
  if (existing === undefined) return baseTreeOid;
  if (rest.length === 0) {
    return storeTree(store, repo, baseEntries.filter((entry) => entry.name !== head));
  }
  if (existing.mode !== '40000') return baseTreeOid;
  const nextChild = removePathFromTree(store, repo, existing.oid, rest);
  const next = baseEntries.filter((entry) => entry.name !== head);
  const childObject = store.getObject(repo, nextChild);
  const childEmpty =
    childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.bytes).length === 0;
  if (!childEmpty) next.push({ mode: '40000', name: head, oid: nextChild });
  return storeTree(store, repo, next);
}

/** Create a commit on the store (viewer author/committer, deterministic epoch). */
function makeStoreCommit(
  store: Store,
  repo: Repo,
  treeOid: string,
  parents: readonly string[],
  message: string,
): string {
  const epoch = store.nowEpochSec();
  const bytes = makeCommitBytes({
    tree: treeOid,
    parents,
    authorName: store.viewer.login,
    authorEmail: `${store.viewer.login}@example.invalid`,
    committerName: store.viewer.login,
    committerEmail: `${store.viewer.login}@example.invalid`,
    epoch,
    message,
  });
  return store.putObject(repo, 'commit', bytes);
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = store.getObject(repo, sha);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.bytes);
  const ident = (who: { name: string; email: string; epoch: number }): Record<string, unknown> => ({
    name: who.name,
    email: who.email,
    date: new Date(who.epoch * 1000).toISOString(),
  });
  return {
    sha,
    node_id: toGlobalId('Commit', sha),
    commit: {
      author: ident(parsed.author),
      committer: ident(parsed.committer),
      message: parsed.message,
      tree: { sha: parsed.tree },
      url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.full_name}/commits/${sha}`,
    html_url: `/repos/${repo.full_name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.full_name}/commits/${sha}/comments`,
    author: null,
    committer: null,
    parents: parsed.parents.map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.full_name}/commits/${parent}`,
      html_url: `/repos/${repo.full_name}/commit/${parent}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Line diffs (LCS over lines) and the pull-files / merge-conflict decisions.

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** {additions, deletions} between two texts, by longest common subsequence of lines. */
function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    // Very large files: fall back to a multiset difference (exact enough for counts).
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        counts.set(line, left - 1);
        common += 1;
      }
    }
    return { additions: b.length - common, deletions: a.length - common };
  }
  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + (j + 1)] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const lcs = dp[0] ?? 0;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

function blobText(store: Store, repo: Repo, oid: string): string {
  const object = store.getObject(repo, oid);
  if (object === undefined) return '';
  return object.bytes.toString('utf8');
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff base-tip tree vs head-tip tree, one entry per path that differs. */
function diffTrees(store: Store, repo: Repo, baseTreeOid: string, headTreeOid: string): PullFile[] {
  const base = flattenTree(store, repo, baseTreeOid);
  const head = flattenTree(store, repo, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const from = base.get(path);
    const to = head.get(path);
    if (from !== undefined && to === undefined) {
      const deletions = splitLines(blobText(store, repo, from.oid)).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (from === undefined && to !== undefined) {
      const additions = splitLines(blobText(store, repo, to.oid)).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
      const counts = lineDiffCounts(blobText(store, repo, from.oid), blobText(store, repo, to.oid));
      out.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return out;
}

/**
 * A merge conflicts when the same file changed differently on both sides since the
 * merge base: base-tip and head-tip both differ from the merge base, and from each other.
 */
function mergeConflicts(store: Store, repo: Repo, baseTip: string, headTip: string): boolean {
  const base = store.mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseTree = treeOfCommit(store, repo, base);
  const baseTipTree = treeOfCommit(store, repo, baseTip);
  const headTipTree = treeOfCommit(store, repo, headTip);
  if (baseTree === undefined || baseTipTree === undefined || headTipTree === undefined) return false;
  const ancestor = flattenTree(store, repo, baseTree);
  const baseSide = flattenTree(store, repo, baseTipTree);
  const headSide = flattenTree(store, repo, headTipTree);
  const paths = new Set([...ancestor.keys(), ...baseSide.keys(), ...headSide.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path)?.oid;
    const b = baseSide.get(path)?.oid;
    const h = headSide.get(path)?.oid;
    if (b !== a && h !== a && b !== h) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Routing. handleRest answers every /api/v3 request and returns true; it
// returns false for anything outside /api/v3 so app.ts can try the next surface.

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) ? value : null;
}

function isValidRepoName(name: string): boolean {
  return name !== '' && name.length <= 100 && !name.includes('/') && !name.includes('..');
}

function isBase64(value: string): boolean {
  const compact = value.replace(/[\r\n\t ]+/g, '');
  if (compact === '') return true;
  if (compact.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(compact);
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const store = ctx.store;

  // Auth first: every /api/v3 route needs the exact bearer token.
  if (!isAuthenticated(req, ctx.token)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const segments = path
    .split('/')
    .filter((part) => part !== '')
    .map(decodeSegment);
  // segments[0] === 'api', segments[1] === 'v3'; the rest is the resource path.
  const rest = segments.slice(2);
  const query = queryOf(req);

  // A body is read for every method that may carry one; malformed JSON is a 400.
  let body: unknown;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendError(res, 400, parsed.error);
      return true;
    }
    body = parsed.value;
  }

  const needRepo = (owner: string, name: string): Repo | null => {
    const repo = store.getRepo(owner, name);
    return repo ?? null;
  };
  const repo404 = (): void => {
    sendError(res, 404, 'Not Found');
  };

  // -- API root and meta ------------------------------------------------------
  if (rest.length === 0) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, userJson(store));
    return true;
  }

  // -- /user/repos ------------------------------------------------------------
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const owned = [...store.repos.values()].filter((repo) => repo.owner.login === store.viewer.login);
      const { items, link } = paginate(req, owned, pageParams(query));
      sendJson(res, 200, items.map((repo) => repoJson(req, store, repo)), link === null ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const input = asRecord(body);
      if (input === null) {
        sendError(res, 422, 'Repository name is required');
        return true;
      }
      const name = asString(input.name);
      if (name === null || !isValidRepoName(name)) {
        sendError(res, 422, 'Repository name is required');
        return true;
      }
      const created = store.createRepo(name, {
        private: input.private === true,
        description: input.description === undefined ? null : asString(input.description),
      });
      if (created === null) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      sendJson(res, 201, repoJson(req, store, created));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // -- /repos/{owner}/{name}[/...] --------------------------------------------
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);
    const repo = needRepo(owner, name);
    if (repo === null) {
      repo404();
      return true;
    }

    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(req, store, repo));
        return true;
      }
      if (method === 'PATCH') {
        const input = asRecord(body);
        if (input !== null && input.description !== undefined) {
          repo.description = asString(input.description);
        }
        repo.updated_at = store.now();
        sendJson(res, 200, repoJson(req, store, repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        sendNoContent(res, 204);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({
          name: branch,
          commit: { sha: store.getRef(repo, `refs/heads/${branch}`) ?? '' },
          protected: false,
        }));
      sendJson(res, 200, branches);
      return true;
    }

    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const input = asRecord(body);
      const ref = input === null ? null : asString(input.ref);
      const sha = input === null ? null : asString(input.sha);
      if (ref === null || !ref.startsWith('refs/') || ref === 'refs/' || sha === null || !/^[0-9a-f]{40}$/i.test(sha)) {
        sendError(res, 422, 'Invalid ref or sha');
        return true;
      }
      if (store.getRef(repo, ref) !== undefined) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      if (store.getObject(repo, sha) === undefined) {
        sendError(res, 422, 'Invalid SHA');
        return true;
      }
      store.setRef(repo, ref, sha.toLowerCase());
      sendJson(res, 201, { ref, object: { sha: sha.toLowerCase() }, url: `/api/v3/repos/${repo.full_name}/git/refs/${ref}` });
      return true;
    }

    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const ref = query.get('sha') ?? repo.default_branch;
      const tip = resolveTip(store, repo, ref);
      if (tip === undefined) {
        sendError(res, 404, 'No commit found for SHA');
        return true;
      }
      const commits = store
        .listCommits(repo, tip)
        .map((sha) => commitJson(store, repo, sha))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      sendJson(res, 200, commits);
      return true;
    }

    if (tail.length >= 1 && tail[0] === 'contents') {
      const handled = await handleContents(req, res, ctx, repo, tail.slice(1).join('/'), method, query, body);
      if (handled) return true;
    }

    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(repo, label)));
        return true;
      }
      if (method === 'POST') {
        const input = asRecord(body);
        if (input === null) {
          sendError(res, 422, 'Label name is required');
          return true;
        }
        const labelName = asString(input.name);
        if (labelName === null || labelName === '') {
          sendError(res, 422, 'Label name is required');
          return true;
        }
        if (repo.labels.has(labelName)) {
          sendError(res, 422, 'Label already exists');
          return true;
        }
        const color = input.color === undefined ? 'ededed' : asString(input.color) ?? 'ededed';
        const label: Label = { id: store.nextId(), name: labelName, color };
        repo.labels.set(labelName, label);
        sendJson(res, 201, labelJson(repo, label));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (tail.length === 1 && tail[0] === 'issues') {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        if (state !== 'open' && state !== 'closed' && state !== 'all') {
          sendError(res, 422, 'Invalid state');
          return true;
        }
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const issues = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => {
            const keyA = sort === 'updated' ? a.updated_at : a.created_at;
            const keyB = sort === 'updated' ? b.updated_at : b.created_at;
            const byTime = keyA < keyB ? -1 : keyA > keyB ? 1 : a.number - b.number;
            return direction === 'asc' ? byTime : -byTime;
          });
        const { items, link } = paginate(req, issues, pageParams(query));
        sendJson(
          res,
          200,
          items.map((issue) => issueJson(req, store, repo, issue)),
          link === null ? {} : { link },
        );
        return true;
      }
      if (method === 'POST') {
        const input = asRecord(body);
        if (input === null) {
          sendError(res, 422, 'Title is required');
          return true;
        }
        const title = asString(input.title);
        if (title === null || title === '') {
          sendError(res, 422, 'Title is required');
          return true;
        }
        const labelNames = input.labels === undefined ? [] : asStringArray(input.labels);
        if (labelNames === null) {
          sendError(res, 422, 'Labels must be an array of names');
          return true;
        }
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) {
            sendError(res, 422, `Label '${labelName}' does not exist`);
            return true;
          }
          labels.push(label);
        }
        const created = store.now();
        const issue: Issue = {
          id: store.nextId(),
          number: store.nextIssueNumber(repo),
          title,
          body: input.body === undefined ? null : asString(input.body),
          state: 'open',
          labels,
          comments: [],
          created_at: created,
          updated_at: created,
        };
        repo.issues.set(issue.number, issue);
        sendJson(res, 201, issueJson(req, store, repo, issue));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (tail.length === 2 && tail[0] === 'issues') {
      const number = parseNumber(tail[1] as string);
      const issue = number === null ? undefined : repo.issues.get(number);
      if (issue === undefined) {
        repo404();
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(req, store, repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const input = asRecord(body);
        if (input !== null) {
          if (input.state !== undefined) {
            if (input.state !== 'open' && input.state !== 'closed') {
              sendError(res, 422, 'Invalid state');
              return true;
            }
            issue.state = input.state;
          }
          if (input.title !== undefined) {
            const title = asString(input.title);
            if (title === null || title === '') {
              sendError(res, 422, 'Title is required');
              return true;
            }
            issue.title = title;
          }
          if (input.body !== undefined) issue.body = asString(input.body);
        }
        issue.updated_at = store.now();
        sendJson(res, 200, issueJson(req, store, repo, issue));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments') {
      const number = parseNumber(tail[1] as string);
      const issue = number === null ? undefined : repo.issues.get(number);
      if (issue === undefined) {
        repo404();
        return true;
      }
      if (method === 'GET') {
        const { items, link } = paginate(req, issue.comments, pageParams(query));
        sendJson(
          res,
          200,
          items.map((comment) => commentJson(store, repo, issue, comment)),
          link === null ? {} : { link },
        );
        return true;
      }
      if (method === 'POST') {
        const input = asRecord(body);
        const text = input === null ? null : asString(input.body);
        if (text === null || text === '') {
          sendError(res, 422, 'Comment body is required');
          return true;
        }
        const comment: Comment = { id: store.nextId(), body: text, created_at: store.now() };
        issue.comments.push(comment);
        sendJson(res, 201, commentJson(store, repo, issue, comment));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (tail.length === 1 && tail[0] === 'pulls') {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        if (state !== 'open' && state !== 'closed' && state !== 'all') {
          sendError(res, 422, 'Invalid state');
          return true;
        }
        const pulls = [...repo.pulls.values()]
          .filter((pull) => state === 'all' || pull.state === state)
          .sort((a, b) => b.number - a.number);
        const { items, link } = paginate(req, pulls, pageParams(query));
        sendJson(
          res,
          200,
          items.map((pull) => pullJson(req, store, repo, pull)),
          link === null ? {} : { link },
        );
        return true;
      }
      if (method === 'POST') {
        const input = asRecord(body);
        if (input === null) {
          sendError(res, 422, 'Title is required');
          return true;
        }
        const title = asString(input.title);
        const head = asString(input.head);
        const base = asString(input.base);
        if (title === null || title === '') {
          sendError(res, 422, 'Title is required');
          return true;
        }
        if (head === null || head === '' || base === null || base === '') {
          sendError(res, 422, 'Head and base branches are required');
          return true;
        }
        const headTip = resolveTip(store, repo, head);
        const baseTip = resolveTip(store, repo, base);
        if (headTip === undefined) {
          sendError(res, 422, `Head branch '${head}' not found`);
          return true;
        }
        if (baseTip === undefined) {
          sendError(res, 422, `Base branch '${base}' not found`);
          return true;
        }
        const created = store.now();
        const pull: Pull = {
          id: store.nextId(),
          number: store.nextPullNumber(repo),
          title,
          body: input.body === undefined ? null : asString(input.body),
          state: 'open',
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          head: { ref: head, sha: headTip },
          base: { ref: base, sha: baseTip },
          created_at: created,
          updated_at: created,
        };
        repo.pulls.set(pull.number, pull);
        sendJson(res, 201, pullJson(req, store, repo, pull));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (tail.length === 2 && tail[0] === 'pulls') {
      const number = parseNumber(tail[1] as string);
      const pull = number === null ? undefined : repo.pulls.get(number);
      if (pull === undefined) {
        repo404();
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(req, store, repo, pull));
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'files' && method === 'GET') {
      const number = parseNumber(tail[1] as string);
      const pull = number === null ? undefined : repo.pulls.get(number);
      if (pull === undefined) {
        repo404();
        return true;
      }
      const headTip = store.getRef(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
      const baseTip = store.getRef(repo, `refs/heads/${pull.base.ref}`) ?? pull.base.sha;
      const headTree = treeOfCommit(store, repo, headTip);
      const baseTree = treeOfCommit(store, repo, baseTip);
      if (headTree === undefined || baseTree === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, diffTrees(store, repo, baseTree, headTree));
      return true;
    }

    if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'merge' && method === 'PUT') {
      const number = parseNumber(tail[1] as string);
      const pull = number === null ? undefined : repo.pulls.get(number);
      if (pull === undefined) {
        repo404();
        return true;
      }
      const input = asRecord(body);
      const mergeMethod = input === null || input.merge_method === undefined ? 'squash' : asString(input.merge_method);
      if (mergeMethod !== 'squash') {
        sendError(res, 405, 'Only squash merges are supported');
        return true;
      }
      if (pull.merged || pull.state !== 'open') {
        sendError(res, 405, 'Pull request is already merged or closed');
        return true;
      }
      const headTip = store.getRef(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
      const baseTip = store.getRef(repo, `refs/heads/${pull.base.ref}`) ?? pull.base.sha;
      const headTree = treeOfCommit(store, repo, headTip);
      if (headTree === undefined || treeOfCommit(store, repo, baseTip) === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (mergeConflicts(store, repo, baseTip, headTip)) {
        sendError(res, 405, 'Merge conflict');
        return true;
      }
      const message = `${pull.title} (#${pull.number})`;
      const mergeSha = makeStoreCommit(store, repo, headTree, [baseTip], message);
      store.setRef(repo, `refs/heads/${pull.base.ref}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = store.now();
      pull.merge_commit_sha = mergeSha;
      pull.updated_at = pull.merged_at;
      repo.updated_at = store.now();
      sendJson(res, 200, { merged: true, sha: mergeSha, message });
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  // A /api/v3 path that matched no route above.
  sendError(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// Contents: PUT (create/update a file), GET (a file or a directory listing),
// DELETE (remove a file). Every write is a blob + tree + commit on the branch.

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  repo: Repo,
  path: string,
  method: string,
  query: URLSearchParams,
  body: unknown,
): Promise<boolean> {
  const store = ctx.store;
  const input = asRecord(body);
  const segments = path.split('/').filter((part) => part !== '');
  const baseName = segments.length === 0 ? '' : (segments[segments.length - 1] as string);

  const branchOf = (fallback: string): string => {
    const fromBody = input === null ? null : asString(input.branch);
    if (fromBody !== null && fromBody !== '') return fromBody;
    const fromQuery = query.get('ref');
    if (fromQuery !== null && fromQuery !== '') return fromQuery;
    return fallback;
  };

  /** The branch tip, or null when the branch is the unborn default branch. */
  const tipOf = (branch: string): { tip: string | undefined; unborn: boolean } => {
    const tip = store.getRef(repo, `refs/heads/${branch}`);
    if (tip !== undefined) return { tip, unborn: false };
    const hasAnyBranch = [...repo.refs.keys()].some((ref) => ref.startsWith('refs/heads/'));
    if (branch === repo.default_branch && !hasAnyBranch) return { tip: undefined, unborn: true };
    return { tip: undefined, unborn: false };
  };

  const fileJson = (blobOid: string, bytes: Buffer): Record<string, unknown> => ({
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name: baseName,
    path,
    content: bytes.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.full_name}/contents/${path}`,
    html_url: `/repos/${repo.full_name}/blob/${repo.default_branch}/${path}`,
    git_url: `/api/v3/repos/${repo.full_name}/git/blobs/${blobOid}`,
    download_url: `/api/v3/repos/${repo.full_name}/contents/${path}`,
    _links: {
      self: `/api/v3/repos/${repo.full_name}/contents/${path}`,
      git: `/api/v3/repos/${repo.full_name}/git/blobs/${blobOid}`,
      html: `/repos/${repo.full_name}/blob/${repo.default_branch}/${path}`,
    },
  });

  if (method === 'PUT') {
    if (segments.length === 0) {
      sendError(res, 422, 'A file path is required');
      return true;
    }
    const branch = branchOf(repo.default_branch);
    const { tip, unborn } = tipOf(branch);
    if (tip === undefined && !unborn) {
      sendError(res, 404, `Branch '${branch}' not found`);
      return true;
    }
    const content = input === null ? null : asString(input.content);
    if (content === null || !isBase64(content)) {
      sendError(res, 400, 'Content must be base64');
      return true;
    }
    const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const message = input === null || asString(input.message) === null ? `Update ${path}` : (asString(input.message) as string);
    const baseTree = tip === undefined ? null : (treeOfCommit(store, repo, tip) ?? null);
    const existing = baseTree === null ? undefined : blobAtPath(store, repo, baseTree, path);
    if (existing !== undefined) {
      const sha = input === null ? null : asString(input.sha);
      if (sha === null || sha.toLowerCase() !== existing.toLowerCase()) {
        sendError(res, 409, 'The file has changed since the given sha');
        return true;
      }
    }
    const blobOid = store.putObject(repo, 'blob', bytes);
    const nextTree = writePathToTree(store, repo, baseTree, segments, blobOid);
    const commitSha = makeStoreCommit(store, repo, nextTree, tip === undefined ? [] : [tip], message);
    store.setRef(repo, `refs/heads/${branch}`, commitSha);
    repo.updated_at = store.now();
    const commit = commitJson(store, repo, commitSha);
    sendJson(res, existing === undefined ? 201 : 200, {
      content: { ...fileJson(blobOid, bytes), name: baseName, path },
      commit,
    });
    return true;
  }

  if (method === 'GET') {
    const branch = branchOf(repo.default_branch);
    const tip = resolveTip(store, repo, branch);
    if (tip === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const tree = treeOfCommit(store, repo, tip);
    if (tree === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (segments.length === 0) {
      const root = treeAtPath(store, repo, tree, '');
      if (root === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, listingJson(store, repo, '', root.entries));
      return true;
    }
    const blobOid = blobAtPath(store, repo, tree, path);
    if (blobOid !== undefined) {
      const object = store.getObject(repo, blobOid);
      if (object === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, fileJson(blobOid, object.bytes));
      return true;
    }
    const dir = treeAtPath(store, repo, tree, path);
    if (dir !== undefined) {
      sendJson(res, 200, listingJson(store, repo, path, dir.entries));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (method === 'DELETE') {
    if (segments.length === 0) {
      sendError(res, 422, 'A file path is required');
      return true;
    }
    const branch = branchOf(repo.default_branch);
    const tip = store.getRef(repo, `refs/heads/${branch}`);
    if (tip === undefined) {
      sendError(res, 404, `Branch '${branch}' not found`);
      return true;
    }
    const tree = treeOfCommit(store, repo, tip);
    if (tree === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const blobOid = blobAtPath(store, repo, tree, path);
    if (blobOid === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const sha = input === null ? null : asString(input.sha);
    if (sha === null || sha.toLowerCase() !== blobOid.toLowerCase()) {
      sendError(res, 409, 'The file has changed since the given sha');
      return true;
    }
    const message = input === null || asString(input.message) === null ? `Delete ${path}` : (asString(input.message) as string);
    const nextTree = removePathFromTree(store, repo, tree, segments);
    const commitSha = makeStoreCommit(store, repo, nextTree, [tip], message);
    store.setRef(repo, `refs/heads/${branch}`, commitSha);
    repo.updated_at = store.now();
    sendJson(res, 200, { content: null, commit: commitJson(store, repo, commitSha) });
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

/** A directory listing: entries sorted by name, files and directories alike. */
function listingJson(
  store: Store,
  repo: Repo,
  dirPath: string,
  entries: readonly { mode: string; name: string; oid: string }[],
): Record<string, unknown>[] {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => {
      const isDir = entry.mode === '40000';
      const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
      const size = isDir ? undefined : (store.getObject(repo, entry.oid)?.bytes.length ?? 0);
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size,
        url: `/api/v3/repos/${repo.full_name}/contents/${path}`,
        html_url: `/repos/${repo.full_name}/${isDir ? 'tree' : 'blob'}/${repo.default_branch}/${path}`,
        git_url: `/api/v3/repos/${repo.full_name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        download_url: isDir ? null : `/api/v3/repos/${repo.full_name}/contents/${path}`,
        _links: {
          self: `/api/v3/repos/${repo.full_name}/contents/${path}`,
          git: `/api/v3/repos/${repo.full_name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
          html: `/repos/${repo.full_name}/${isDir ? 'tree' : 'blob'}/${repo.default_branch}/${path}`,
        },
      };
    });
}
