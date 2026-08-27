# deploylog-cli

**The `deploylog` npm CLI** (`deploylog` and the alias `dpl`): push changelog entries from the
terminal, generate release notes from git, work with a project's Manual. One of DeployLog's four
repos; the API it calls lives in `projects/deploylog` under `src/app/api/cli/*`.

- **Package:** `deploylog` on npm, `0.6.0` (2026-08-25). MIT. Node 18+ per the README (no `engines`
  field in `package.json`).
- **Shape:** ESM (`"type": "module"`, tsconfig `module: Node16`, target ES2022, `strict`),
  Commander 13, `conf` for credentials, `yaml`, `zod` 4, `chalk`. Five runtime deps; keep it that
  way (a heavy dependency loads lazily inside its own subcommand, see issue 06).
- **Build / test:** `npm run build` (tsc → `dist/`, the only thing published), `npm test`
  (`vitest run`, no config file; `src/*.test.ts` sit beside their modules and are excluded from
  tsc). 11 files, 174 tests on 2026-08-27; run the suite for the real number.
- **Siblings:** `projects/deploylog` (API + dashboard), `projects/deploylog-widget`,
  `projects/deploylog-action` (`deploylogdev/action`, its own package: it does not import this one).

Read this file, then the module you are touching and its `.test.ts`. The main repo's `CLAUDE.md`
and `.claude/rules/typescript.md` + `testing.md` are the shared standards; this file wins on a
CLI-specific conflict.

## Layout

```
src/
  index.ts             commander adapters ONLY: parse flags, call runX, print, set the exit code
  push.ts              runPush(opts, deps): entry from flags / git / AI summary → draft or publish
  entry-commands.ts    runSetPublished / runView / runEdit / runDelete (EntryCommandDeps)
  init.ts, open.ts     runInit (.deploylog.yml), runOpen (browser)
  manual.ts            runManualExport: the manual payload as JSON (`./<slug>-manual.json`, or `-`)
  manual-verify.ts     runManualVerify: claims vs the pushed commit; decideVerdict, renderReport
  manual-schema.ts, manual-verify-schema.ts   zod: the manual contract shared with the server
  api.ts               ONE request(): Bearer dk_ key, defensive body parsing, ApiError(status, code, message)
  config.ts            conf store: apiKey, apiUrl (normalized)
  project-config.ts    .deploylog.yml upward walk: missing → keep walking, malformed → stop and throw
  resolve.ts           entry ref: uuid passes through, slug matched against recent entries
  git.ts               GitRunner-injectable git helpers (last tag, commits since, origin slug, head sha)
  editor.ts            $EDITOR round-trip + recovery file
  version.ts           getCliVersion(): read from package.json, never a literal
docs/manual/05-cli.md  chapter 05 (The CLI) as the Manual pushes it here on a `deploylog/chapter-<id>` PR; never hand-edited
issues/NN-slug.md      one file per work item (header fields, What to build, Acceptance, Boundaries)
.github/workflows/manual-check.yml   the Action in verify mode on every pull request
```

## Conventions (the ones that are load-bearing)

1. **Adapter / domain split.** `index.ts` never contains logic. Every command is
   `runX(opts, deps = defaultXDeps)` in its own module with an `XDeps` interface over every
   boundary (git, api, fs, editor, `confirm`, `isTTY`, an output sink). The point is the tests:
   every branch of `runX` is reachable from a unit test through a fake `deps` (`makeDeps(over)` in
   `push.test.ts` is the pattern), with no network, git or fs. `api.test.ts` is the one place that
   mocks at the transport (`./config.js` + global `fetch`).
2. **Typed refusals, not `process.exit`.** A domain function returns a `kind`-tagged union
   (`created | no-commits | missing-fields | cancelled | not-found | ...`); the adapter decides the
   message and the exit code. Adding a failure mode means adding a `kind`, and a test for it.
3. **`--json` on every data command.** Raw JSON on stdout, `{"error":{"code","message"}}` on
   stderr, no interactive prompt, ever, when `--json` is set (README "Machine-readable output":
   built for CI and agents). A new command ships with it.
4. **Entry references:** the id is canonical; a slug is matched against the most recent entries
   and can change when a draft's title changes (`resolve.ts`). Scripts and agents use ids.
5. **Program options precede subcommands** (`enablePositionalOptions()`): without it the global
   `--version` swallows `push --version 1.4.0`. Do not remove it.
6. **The version comes from `package.json`** through `version.ts`. The literal in `index.ts`
   shipped stale once (`0.5.0` on the `0.6.0` package, found 2026-08-27); `version.test.ts` fails
   if the two diverge again.
7. **Comments cite their ledger.** `BUG-nnn` refers to `projects/deploylog/docs/bug-audit-findings.md`
   (BUG-011 is `request()`'s defensive parsing, BUG-012 the `apiUrl` normalization); `A3` and
   friends refer to this repo's `issues/` (A3 = issue 02, the honest project-config error).
8. **The command surface is a contract.** The roadmap's 💥 rule (`projects/deploylog/docs/roadmap.md`,
   "version, never break") names the CLI command surface as one of three stable contracts. Rename
   or remove a flag only with a deprecation path and a major bump.

## The API this CLI talks to

- `GET/POST /api/cli/*` on `https://deploylog.dev` (override with `deploylog login --api-url`).
  `Authorization: Bearer dk_...`; keys carry `read` and/or `write` permissions and the server
  answers `403` when a permission is missing.
- **The `cli` rate limit is per ORG, 60/min sliding window, shared by everything that sends a
  `dk_` key** (this CLI, the GitHub Action, and the MCP server once it exists; the dashboard has
  its own buckets). A 429 carries `Retry-After`. Never loop or poll against the API from a command.
- Server-side bounds the CLI mirrors: entry `type` ∈ `feature | fix | improvement | breaking |
  announcement`; `version` matches `^\d+\.\d+\.\d+$`; list `limit` is 1..50.

## The Manual loop (why a doc change can fail a PR)

Chapter 05 of the DeployLog Manual cites this repository: `README.md`, `src/index.ts`,
`src/push.ts`, `src/init.ts`, `src/manual-verify.ts` (51 claims on 2026-08-25). On every pull
request `manual-check.yml` runs `deploylogdev/action@v1` in verify mode against the pushed commit
(`fail-on: none`, so it annotates and stays green; flip to `drift` to block). Read the annotations
on any PR that touches a cited file. `deploylog manual verify` checks the commit **on GitHub**, so
run it after a push, not on a dirty tree. When the command surface changes, chapter 05 is
regenerated on the deploylog side and arrives here as a `deploylog/chapter-<id>` PR; the README
`## Commands` section changes in the surface PR itself.

## Releasing (Marko runs the publish)

1. Bump `version` in `package.json` (the only place). 2. `npm run build && npm test`.
3. `npm publish` (`prepublishOnly` builds). 4. Regenerate chapter 05 if the surface changed.
5. Flip the issue's `Status:` with the commit sha. Branch names so far: `feat/`, `ci/`,
`deploylog/chapter-<id>` (chapter re-exports). Stale local `feat/*` branches are merged history;
do not build on them. Marko merges PRs fast: re-check `gh pr view` before pushing to a branch that
has one.

## Gotchas

- `import.meta.url` relative paths must resolve from BOTH `dist/` and `src/` (each is one level
  below the package root); `version.ts` relies on that.
- `npx -y deploylog` cold-installs on first use; an MCP host with a short start-up timeout may
  need the global install (issue 06).
- The `.deploylog.yml` walk goes upward: from a parent directory in a monorepo it resolves the
  parent's project. Drafts contain that; a publish emails subscribers.
- `conf` stores the key in the OS config dir (`deploylog logout` clears it; the path is in
  `getConfigPath()`); a `DEPLOYLOG_API_KEY` env fallback is planned in issue 06, not present today.

## Queued

- `issues/06-mcp-server.md`: `deploylog mcp`, a stdio MCP server inside this package (v1.2,
  foreground, red-teamed 2026-08-27). Its `McpDeps` seam and the `api.ts` changes it lists
  (env key fallback, scoped User-Agent, `retryAfter` on `ApiError`) are the next changes here.
