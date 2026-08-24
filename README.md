<p align="center">
  <img src="https://raw.githubusercontent.com/marko-builds/deploylog-cli/main/.github/assets/logo.png" width="120" alt="DeployLog" />
</p>

<h1 align="center">deploylog</h1>

<p align="center">
  Push changelog entries from the terminal. Generate release notes from git with one flag. Rewrite them with Claude Haiku with another.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deploylog"><img src="https://img.shields.io/npm/v/deploylog.svg" alt="npm"></a>
  <a href="https://www.npmjs.com/package/deploylog"><img src="https://img.shields.io/npm/dm/deploylog.svg" alt="downloads"></a>
  <img src="https://img.shields.io/node/v/deploylog.svg" alt="node">
  <img src="https://img.shields.io/npm/l/deploylog.svg" alt="license">
</p>

---

## Install

```bash
npm i -g deploylog
```

Node 18+ required. Installs two equivalent commands: `deploylog` and the short alias `dpl`.

## Authenticate

Create an API key in your dashboard at [deploylog.dev/dashboard/api-keys](https://deploylog.dev/dashboard/api-keys), then:

```bash
deploylog login --key dk_xxx
```

Credentials are stored with [`conf`](https://github.com/sindresorhus/conf) in your OS's standard config directory.

## Quick start

```bash
# Wire this repo to a project (writes .deploylog.yml)
deploylog init

# Draft an entry from your commits, rewritten by AI
deploylog push --from-git --ai-summarize

# Review it, then ship it
deploylog list --drafts
deploylog view dark-mode
deploylog publish dark-mode
```

The full lifecycle lives in the terminal: create, list, view, edit, publish, unpublish, delete. No dashboard detour.

## Project config

`deploylog init` writes a `.deploylog.yml` at your repo root so you don't have to pass `--project` every time:

```yaml
project: my-app
default_type: feature   # optional
```

## Referencing entries

Entry commands accept a **slug or an id** (`deploylog publish dark-mode`, `deploylog publish 3f2b8a1c-...`). Slugs are matched against the 50 most recent entries; older entries need the id (`deploylog list` shows both). Note that editing a draft's title can change its slug, so scripts should prefer ids.

## Machine-readable output

Every data command takes `--json`: raw JSON on stdout, errors as `{"error":{"code","message"}}` on stderr, and no interactive prompts, ever. Built for CI and AI agents.

```bash
deploylog list --drafts --json | jq -r '.[0].id'
```

## Commands

### `deploylog login` / `deploylog logout`

Authenticate with an API key (create one at [deploylog.dev/dashboard/api-keys](https://deploylog.dev/dashboard/api-keys)).

```
--key <key>       API key (starts with dk_)
--api-url <url>   API base URL (default: https://deploylog.dev)
```

### `deploylog init`

Scaffold `.deploylog.yml` in the current directory. Picks the project interactively, or takes `--project`.

```
-p, --project <slug>   Project slug
-T, --type <type>      Default entry type for pushes from this repo
--force                Overwrite an existing .deploylog.yml
```

### `deploylog projects` (alias: `proj`)

List projects in your organization.

### `deploylog projects create <name>`

Create a project. The slug is generated from the name.

```
--url <url>   Project website URL
```

### `deploylog whoami`

Show the authenticated org, plan, API key (name, prefix, permissions), and AI usage this month.

### `deploylog manual export`

Export a project's whole manual as JSON: every version with its commit map, and every chapter with its claims. The payload is validated against the server's published schema before anything is written, and the export is available on every plan.

```
-p, --project <slug>   Project slug (or set in .deploylog.yml)
-o, --out <path>       Output file (default: ./<slug>-manual.json; - for stdout)
```

### `deploylog list` (alias: `ls`)

List recent entries for a project. Prints each entry's slug and id.

```
-p, --project <slug>   Project slug (or set in .deploylog.yml)
--drafts               Only drafts
--published            Only published entries
-T, --type <type>      Filter by entry type
-n, --limit <n>        Max entries (1-50)
```

### `deploylog view <entry>` (alias: `show`)

Show a full entry, including its Markdown body.

### `deploylog push`

Create a new changelog entry.

```
-t, --title <title>       Entry title
-b, --body <markdown>     Entry body (Markdown)
-p, --project <slug>      Project slug (or set in .deploylog.yml)
-T, --type <type>         feature | fix | improvement | breaking | announcement
--version <version>       Semver (e.g. 1.2.3)
-P, --publish             Publish immediately
-D, --draft               Save as draft (default)
-g, --from-git            Derive title/body from commits since the last tag (alias: --git)
-a, --ai-summarize        Rewrite the entry with Claude Haiku (alias: --ai)
-y, --yes                 Skip interactive confirmation for AI-generated content
```

### `deploylog edit <entry>`

Update an entry. With no field flags on an interactive terminal, your `$EDITOR` opens prefilled with the current body. If the server rejects an edited body, it is saved to a recovery file, never lost.

```
-t, --title <title>     New title (may change a draft's slug; the CLI tells you)
-T, --type <type>       Entry type
--version <version>     Semver version (pass "" to clear)
-b, --body <markdown>   New body
--body-file <path>      Read the new body from a file (- for stdin)
```

### `deploylog publish <entry>` (alias: `pub`) / `deploylog unpublish <entry>` (alias: `unpub`)

Publish a draft, or revert a published entry to draft. Publishing is idempotent: re-running is a no-op, and the email digest (Pro) is sent at most once per entry, ever. Unpublishing resets the publish date; republishing gets a new one.

### `deploylog delete <entry>` (alias: `rm`)

Delete an entry permanently. Prompts for confirmation on a terminal; requires `--yes` in CI or `--json` mode.

### `deploylog import github <repo>`

Backfill your existing GitHub releases as draft entries. Takes `owner/repo` or a github.com URL. Skips versions you already imported.

```
-p, --project <slug>   Project slug (or set in .deploylog.yml)
--token <token>        GitHub PAT for private repos / rate limits (or DEPLOYLOG_GITHUB_TOKEN); never stored
```

### `deploylog open [entry]` (alias: `o`)

Open the project's public changelog (or one entry's page) in your browser. Prints the URL when headless.

## Recipes

**Onboard a repo in one minute:**

```bash
deploylog login --key dk_xxx
deploylog projects create "My App" --url https://myapp.dev
deploylog init
deploylog import github me/my-app     # backfill old releases as drafts
deploylog list --drafts               # review
deploylog publish v1-4-0
```

**Draft from recent commits, ship after review:**

```bash
deploylog push --from-git --ai-summarize
deploylog view <slug>        # read what the AI wrote
deploylog edit <slug>        # tweak in $EDITOR
deploylog publish <slug>
```

**CI: publish on release, no prompts:**

```bash
deploylog push --from-git --ai-summarize --yes --publish --json
```

For GitHub Actions specifically, prefer the official Action: [`deploylogdev/action`](https://github.com/marketplace/actions/publish-to-deploylog).

**Agent-driven usage:** every command's `--json` output is stable and prompt-free; destructive operations refuse without an explicit `--yes`.

## Related

- **Dashboard** — [deploylog.dev](https://deploylog.dev)
- **Widget** — embeddable changelog widget at `cdn.deploylog.dev`
- **GitHub Action** — [`deploylogdev/action@v1`](https://github.com/marketplace/actions/publish-to-deploylog)

## License

MIT © DeployLog
