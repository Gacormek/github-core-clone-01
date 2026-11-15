# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Gacormek/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Gacormek/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node 22 stdlib only: REST v3 (repos, issues, pull requests, contents, merge), git smart HTTP (upload-pack v2/v0, receive-pack v0), GraphQL v4, and an MCP server — all sharing one deterministic in-memory store. Scores 120/120 conformance with 985/1000 in the sealed trial replay.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry registers with the make.fun env from `MAKEFUN_ENV_URL` and takes its bearer token from `MAKEFUN_SHOP_TOKEN`; locally, point `MAKEFUN_ENV_URL` at a dummy (e.g. `http://127.0.0.1:9999`) and the server stays up on an ephemeral port.

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
