# SUBMIT-NOTES — github-core-clone-01

Entry: `Gacormek/github-core-clone-01` — a GitHub-compatible git forge (Node 22 stdlib
only, no dependencies). Deadline: **2026-11-21T06:30:00Z**. Prize: $500 USDC total,
top 20 places paid (1st $100).

## Final verification (all from this repo, fresh server per run)

- `sdk/run.ts --json` (kit runner, no perf): **120/120** — git 30/30, repos 15/15,
  issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15. Columns:
  feature 600 + agent 200 + perf 0 = **800**. Zero failed checks.
- `sdk/run.ts --perf --json`: **120/120**, perf **184** — push p50 718.86 ms / 40 pts,
  clone p50 92.06 ms / 44 pts, read p50 594.18 ms / 50 pts, write p50 78.51 ms / 50 pts.
  Score **984** (target was ≥950; house reference ≈ 900).
- Sealed trial replay (`program/env/server.mjs` + `program/scorer/score.mjs`, no Docker):
  replay 1 **985/1000** (feature 600 + agent 200 + perf 185), replay 2 **974/1000**
  (perf 174 — perf varies run to run, timing noise only). Both 120/120 conformance.
- Determinism: `export/state.json` from the two sealed replays is **byte-identical**
  (sha256 `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`).
- `tsc --noEmit --strict` (include `src/**/*.ts`, `@types/node` from /tmp/tscheck): clean.
- `node --experimental-strip-types main.ts` runs; entry registers with the env and
  exits 0 on `/done`. Local test token was `test-token-123` (test-only, never a real
  credential). Full logs: `/tmp/forge-int/run1.json`, `run2.json`,
  `state-replay1/export/`, `state-replay2/export/`.

## Repo About (set after creating the GitHub repo)

- Description: `A GitHub-compatible git forge: REST v3, git smart HTTP, GraphQL v4 and MCP on one deterministic in-memory store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.`
- Homepage: `https://make.fun/bounty/github-core-clone-01`
- Topics: `makefun,ai-agents,bounties,code`
- Command (after `gh repo create`): `gh repo edit Gacormek/github-core-clone-01 --description 'A GitHub-compatible git forge: REST v3, git smart HTTP, GraphQL v4 and MCP on one deterministic in-memory store. Built by an AI agent for make.fun'"'"'s "Build a GitHub-compatible git forge" bounty, $500 in USDC.' --homepage 'https://make.fun/bounty/github-core-clone-01' --add-topic 'makefun,ai-agents,bounties,code'`

## README referral placeholder

`README.md` still contains `?ref={referral_code}` literally. Before/after submit, either
replace `{referral_code}` with the account's real referral code or delete the `?ref=…`
query from that link. (The referral code is the account holder's; the integration agent
did not fill it in.)

## Submit commands (parent — DO NOT run from this subagent)

From inside the unpacked kit (`~/workspace/makefun/kits/github-core-clone-01/unpacked/github-core-clone-01-kit/`):

```sh
# 1. Create the public repo and push (GitHub OAuth for Gacormek is connected;
#    repo selection/creation still needs the user's go-ahead)
git -C ~/workspace/makefun/github-core-clone-01 push <remote> main   # after remote is set

# 2. Transcript bundle — AFTER all subagents finish, so their usage rows exist.
#    First copy usage rows out of muse.db (see `bundle --help` for the SELECT;
#    agent_ids: the top-level session + every subagent, incl. 40b61a50-4097-4a9a-b515-3cb3f53c6ef4
#    and parent b02c871a-661a-401c-960b-bce0013cb89d), write them to a file, then:
node cli/makefun.mjs bundle --repo ~/workspace/makefun/github-core-clone-01 \
  --out /tmp/github-core-clone-01-bundle.tar.gz --muse-usage <usage-file>
node cli/makefun.mjs check --bundle /tmp/github-core-clone-01-bundle.tar.gz   # verify it passes

# 3. Submit
node cli/makefun.mjs submit --competition github-core-clone-01 \
  --repo-url https://github.com/Gacormek/github-core-clone-01 \
  --commit <full 40-char sha of the submitted commit> \
  --title github-core-clone-01 \
  --bundle /tmp/github-core-clone-01-bundle.tar.gz
```

## Still needed before submit

1. **GitHub repo**: create public repo `Gacormek/github-core-clone-01` (user's go-ahead
   was still pending at build time) and push `main`.
2. **Transcript bundle (final, not dry-run)**: see step 2 above — the `--muse-usage`
   file is mandatory; without it the entry is rejected where transcripts are required.
3. **Referral code** in README (`{referral_code}`) — fill in or strip `?ref=`.
4. **Repo About** (description/homepage/topics) — command above.
5. Submit via the CLI (step 3) before 2026-11-21T06:30:00Z.

## Bundle --dry-run status (2026-11-15)

`node cli/makefun.mjs bundle --repo ~/workspace/makefun/github-core-clone-01 --out /tmp/x.tar.gz --dry-run`
(exit 0, nothing written): **9 session files** found — 6 Muse app sessions naming the
repo in their tool calls + 3 earlier sessions that wrote files this build read from
outside the repo; 1 instruction file (`context/repo/_parent-3/AGENTS.md` from
`/home/hatch/AGENTS.md`); auto-redaction stripped 39 email addresses, 662 home paths,
677 usernames, 28 credentials. Warnings: (a) **0 usage rows attached** — final bundle
must pass `--muse-usage` (see above); (b) repo had uncommitted changes at dry-run time
(`repo.dirty`) — cleared by the final commit; (c) several sessions are cut to the
repo's work (expected: earlier records before the repo was first named are left out).

## Notes

- `BUILD-NOTES.md` (coordination scratchpad) was deleted from the repo in the final
  commit, per the build spec; its content survives in git history.
- No credentials were used or stored by this integration: only the test-only token
  `test-token-123` for local verification. No bundle was created, nothing was pushed
  or submitted.
