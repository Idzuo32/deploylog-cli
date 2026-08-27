# 06 — `deploylog mcp`: a stdio MCP server inside the CLI

**Status:** queued (v1.2, ~Oct 20 to Nov 3 2026)
**Type:** HUMAN (foreground; Marko's call 2026-08-27 — not for `afk-implement.sh`)
**Lane:** deploylog-cli
**Parent:** deploylog/docs/roadmap.md v1.2 (decision 2026-08-25 item 9, shaped 2026-08-27)
**Blocked by:** None for the build. The three listings wait for the post-launch map's Oct 31 read (`deploylog/issues/map-post-launch-marketing/map.md:339` rules integration marketplaces out through then).
**Red-teamed:** 2026-08-27, `plan-review-redteamer`, verdict ship-with-fixes; five blocking findings folded in (section at the end), every file:line re-read against the source before folding.
**Verification:** on a clean box, `claude mcp add deploylog -- npx -y deploylog mcp`; an agent session lists projects, creates a draft, reads it back with `get_entry`, publishes it after the permission prompt, and the entry is on the hosted page; `manual_verify` returns the same verdicts as `deploylog manual verify` on the same commit; with a `read`-only key, `create_entry` returns a tool error carrying the API's 403 (the known negative — a server that cannot fail is not verified). Run the 403 probe on a fresh key as the org's FIRST call of the minute: rate limiting runs before the permission check (`route-shell.ts:92` before `:100`), so a busy org returns 429 instead and the negative flakes.

## Why
The ICP ships from a terminal with an agent in it. `push --git --ai` reconstructs the entry after the fact from commits and spends DeployLog's metered Haiku doing it (`ai_usage` in `whoami`). An MCP tool lets the agent that made the change draft the entry from what it already has in context, at zero AI cost to DeployLog: Decision 9's BYO-AI path without the provider interface. It is also the "plugin that fits the ICP" (Decision 9 skipped browser/desktop/mobile). Discussion record: monolith `decisions/log.md` 2026-08-27.

## What to build
A `deploylog mcp` subcommand (stdio transport, `@modelcontextprotocol/sdk` 1.30.0, peer `zod ^3.25 || ^4.0`, so this package's `zod ^4.4` is fine) in this package. No new package, no new server, no new auth. It reuses `api.ts` for the HTTP calls, the `conf`-stored key from `deploylog login`, and the `.deploylog.yml` walk in `project-config.ts`.

"Reuse" is not "no CLI work". Four changes to the existing code are part of this issue, each small, each also improving the CLI:
1. **`DEPLOYLOG_API_KEY` env fallback** in `config.ts`, env first, so an `mcp.json` `env` block works without `deploylog login`. This overrides a logged-in user's stored key for `push`/`list` too: `whoami` reports the key source (`env` / `store`), and `login` warns when the env var is set. Documented as a CLI change in the release notes.
2. **A process-level User-Agent setter** (`setUserAgent()` beside `setApiUrl()`), sent by `request()` only when set. The `mcp` entrypoint sets `deploylog-mcp/<version>`; the CLI leaves it unset and keeps sending none, which is the distinguisher. Sessions are then countable from Vercel request logs by UA with no server-side code; the earlier "counter as its own S task" is dropped.
3. **`retry-after` threaded onto `ApiError`**: `rate-limit.ts:112-121` sets the header, `api.ts:48-54` discards every header today. One field, read in `request()`.
4. **Version from `package.json`**: `index.ts:38` hardcodes `.version('0.5.0')` while the package is `0.6.0`. The UA needs a true version; fix the drift in the same release.

And one new seam: an `McpDeps` interface over the api functions the tools call (`listProjects`, `listEntries`, `getEntry`, `createEntry`, `setEntryPublished`, `whoami`, `runManualVerify`), injected into the tool handlers the way `PushDeps` is injected into `runPush`. Today only `push.ts` and `manual-verify.ts` have a seam; the other calls are imported directly in `index.ts:6-14`, so "no network in unit tests" is new work, not reuse.

The SDK is **dynamically imported inside the `mcp` action**: its dependency tree (express, hono, jose, ajv, cors, eventsource, and more) must not tax `push`/`list` start-up for users who never run MCP.

Install lines, documented verbatim on the docs page, with the cold-start caveat:
- Claude Code: `claude mcp add deploylog -- npx -y deploylog mcp`
- Cursor / anything reading `mcp.json`: `{"mcpServers":{"deploylog":{"command":"npx","args":["-y","deploylog","mcp"],"env":{"DEPLOYLOG_API_KEY":"dk_..."}}}}`
- The global-install alternative (`npm i -g deploylog`, then `command: "deploylog", args: ["mcp"]`) for hosts whose start-up timeout is shorter than a cold `npx` install of the SDK tree. Measure the cold start once and put the number on the page.

### Tools (v1)
| Tool | Calls | Key permission | Behaviour |
|---|---|---|---|
| `list_projects` | `GET /api/cli/projects` | read | as `deploylog projects` |
| `list_entries` | `GET /api/cli/projects/{slug}/entries` (`status`, `type`, `limit`) | read | as `deploylog list`; `project` optional (see resolution below) |
| `get_entry` | `GET /api/cli/entries/{id}` (`getEntry`, `api.ts:151`) | read | the read-back the draft → review → publish loop needs; `list_entries` returns titles only |
| `create_entry` | `POST /api/cli/projects/{slug}/entries` | write | `title`, `body` (markdown), `type`, `version` optional; **`publish` defaults to `false`**: the tool creates a draft |
| `publish_entry` | `POST /api/cli/entries/{id}/publish` with `{published: true}` (`setEntryPublished`, `api.ts:202`) | write | its own tool on purpose: the host's permission prompt is the human gate, so a publish is never a side effect of a create. Its description says what the host prompt must show: publishing sends the email digest to the project's subscribers when the digest is due (`publish/route.ts` → `queueEntryDigest`), which no unpublish recalls |
| `whoami` | `GET /api/cli/whoami` | read | org, plan, key permissions and source, AI usage; the diagnostic when something 401s |
| `manual_verify` | `POST /api/cli/manual/verify` | read | the Manual's differentiator inside an agent's own loop; same request shape as `manual-verify.ts`; `repository` and `ref` optional. Its description says it is slow (the route's `maxDuration` is 60 s, one GitHub fetch per anchor) |

**Project resolution, every project-scoped tool the same way:** an explicit `project` input wins; otherwise the `.deploylog.yml` walk from the server's cwd (`project-config.ts`). `manual_verify` additionally needs the cwd to be a git repo whose `origin` matches the manual's commit map (`manual-verify.ts:105-140`), so it takes `repository`/`ref` explicitly when the host's cwd is not the repo. Every project-scoped result echoes the resolved slug, so the host's permission prompt for `publish_entry` names the project it is about to publish to. The blast radius this closes: spawned from a parent directory in a monorepo, the upward walk can resolve the wrong project; drafts contain that, a publish does not.

One prompt, `draft_release_notes`: takes `since` (tag or ref, default last tag) and returns the instruction to draft an entry from the diff in the agent's context, in the entry-type vocabulary, as a draft via `create_entry`, then read it back with `get_entry` before offering `publish_entry`. In Claude Code an MCP prompt surfaces as a slash command, so this is the cheapest distribution the server has.

### Rules the server follows
- **Rate limit is per ORG, shared across every CLI surface** (`route-shell.ts:92` keys `org:${orgId}`; 60/min sliding window, `rate-limit.ts:46`): `push`, `list`, the GitHub Action and every MCP tool call draw on one bucket (the dashboard has its own buckets; the red-team's "dashboard's CLI calls" was wrong, `rate-limit.ts:46-49`). So: at most one request per tool call, never a poll, no tool that fans out over entries. A 429 is returned as a tool error carrying the retry-after; the server never retries in a loop.
- **Input schemas mirror the server's bounds**, or agents get opaque `VALIDATION_ERROR`s: `type` is the `ENTRY_TYPES` enum (`feature | fix | improvement | breaking | announcement`, `schemas.ts:4`), `version` matches `^\d+\.\d+\.\d+$` (`schemas.ts:84`), `limit` is 1..50 (`schemas.ts:119`). Each bound is stated in the tool description, not only the schema.
- **Errors:** `ApiError` maps to `isError: true` with the API's code, message and retry-after; never a thrown exception across the transport. The manual route's 503 `NOT_CONFIGURED` arrives this way too (only 404 is typed in `manual-verify.ts:186-192`); acceptable.
- **Identity:** `User-Agent: deploylog-mcp/<version>` from the setter above; the CLI sends none.
- **Tool descriptions are the leading words** (monolith `writing-great-skills`): each says when to use it, what it will not do (`create_entry`: "creates a draft; call `publish_entry` to publish"), and its cost (`manual_verify`: slow; `publish_entry`: emails subscribers).

### Distribution: all three surfaces at once (Marko's call 2026-08-27, c)
1. **Official MCP registry** (registry.modelcontextprotocol.io): `server.json` in this repo, `mcpName` in `package.json`, published with the npm release. Namespace: `dev.deploylog/deploylog` (DNS TXT verification, Marko-only) or `io.github.marko-builds/deploylog` (GitHub auth). Prefer the brand namespace; fall back to GitHub if DNS verification is friction on release day.
2. **Claude Code plugin:** `plugin/` in this repo with `.claude-plugin/plugin.json`, `.mcp.json` pointing at `npx -y deploylog mcp`, and `skills/changelog/SKILL.md` (the entry-type vocabulary, draft → read back → publish, `manual_verify` before a release). A `.claude-plugin/marketplace.json` at the repo root makes `claude plugin marketplace add marko-builds/deploylog-cli` work immediately; submission to Anthropic's official marketplace is Marko-only and its process is checked at build time (`claude-code-guide` agent).
3. **Docs page:** `deploylog.dev` docs + the manual (a chapter or a section of ch 05): the three install lines, the seven tools, the read-only-key recipe for agents that only summarize, the shared per-org rate limit, the cold-start number.

## Acceptance criteria
- [ ] `deploylog mcp` starts a stdio server; `npx -y deploylog mcp` works from a clean `npx` cache, and the cold start is measured and written on the docs page
- [ ] The SDK is imported only inside the `mcp` action; `deploylog --version` start-up time is unchanged (measure before/after)
- [ ] The seven tools above with zod input schemas mirroring the server bounds, handlers over an injected `McpDeps`, one test per tool with a fake `McpDeps` (no network), including the 403, 429-with-retry-after and wrong-project paths
- [ ] `create_entry` never publishes; `publish_entry` is the only path to `published: true`, and its description names the digest
- [ ] Every project-scoped tool accepts `project` (and `manual_verify` `repository`/`ref`) and echoes the resolved slug in its result
- [ ] `DEPLOYLOG_API_KEY` env fallback in `config.ts`; `whoami` shows the key source; `login` warns when the env var is set; documented in `README.md` and the CLI manual chapter
- [ ] `setUserAgent()`: a test asserts `push` sends no `User-Agent` and the `mcp` entrypoint sends `deploylog-mcp/<version>`
- [ ] `ApiError.retryAfter` populated from the header on 429
- [ ] `index.ts` reads the version from `package.json`; `deploylog --version` prints the published version (0.5.0 drift closed)
- [ ] `draft_release_notes` prompt registered and visible as a slash command in Claude Code
- [ ] `server.json` + `mcpName` present; registry publish succeeds (Marko runs the publish)
- [ ] `plugin/` + `.claude-plugin/marketplace.json`; `claude plugin marketplace add marko-builds/deploylog-cli` then `claude plugin install deploylog` yields the MCP server and the skill
- [ ] Docs page live with the three install lines and the cold-start number
- [ ] CLI manual chapters that cite `src/index.ts` re-verified (`deploylog manual verify` exit 0) after the command surface grows
- [ ] `projects/deploylog-cli/CLAUDE.md` exists before the build session opens (the lane has none; the `PushDeps` injection in `push.ts` and the typed-refusal `PushResult` shape are the conventions to name)

## Boundaries
- Do NOT add a `delete_entry` tool in v1
- Do NOT add a remote transport (Streamable HTTP + OAuth); that is roadmap v1.3
- Do NOT add auth beyond the existing `dk_` key
- Do NOT add server-side routes or a session counter to the deploylog repo; UA in Vercel request logs is the count
- Do NOT add any tool that polls or fans out over entries (one shared per-org bucket)
- Do NOT write "first MCP server in the category" (or any "no competitor has this") in `BRAND.md`, the docs page, the registry listing or a post until each vendor's docs are checked: Beamer, Headway, Canny, LaunchNotes, AnnounceKit, Noticeable. A 2026-08-27 web search of listicles found no MCP mention for any of them, which is a weak probe, not evidence.
- Do NOT queue this to `afk-implement.sh` (Marko's call d)

## Open before build
- ~~`@modelcontextprotocol/sdk` version and its zod peer range~~ resolved 2026-08-27 (`npm view`: 1.30.0, peer `zod ^3.25 || ^4.0`)
- Whether Claude Code passes the project cwd to a stdio server added at user scope (`-s user`) as well as project scope. With `project` explicit on every tool and the slug echoed, either answer works; it decides only what the docs page recommends
- The official Anthropic marketplace submission process (asked of `claude-code-guide` at build time)
- Which namespace the registry publish uses (DNS vs GitHub), Marko's call on release day

## Red-team record (2026-08-27)
Five blocking findings, all verified against the source and folded above: (1) the rate limit is per org, not per key, and shared with push/list/Action (`route-shell.ts:92`); (2) `api.ts` had no header injection point, so the UA needed a scoped setter to keep the CLI-vs-MCP distinction; (3) `api.ts` discarded `retry-after`; (4) four of six tools had no injection seam, so the no-network tests are a new `McpDeps` seam; (5) cwd was asserted as fact in one section and listed open in another, and project resolution was specified for one tool only, with `publish_entry`'s digest as the irreversible surface. Risks folded: dynamic SDK import, cold-start measurement plus the global-install line, schemas mirroring server bounds, the 429-before-403 flake in the known negative, the 0.5.0 version drift, `manual_verify`'s 60 s ceiling. Added from "missing": `get_entry` (tool 7), the `{published: true}` body, the env-overrides-store note. Cheaper-path call: the reviewer proposed dropping UA and the counter entirely; the counter is dropped, the UA stays because a scoped setter is a few lines and Vercel logs make the count free.
