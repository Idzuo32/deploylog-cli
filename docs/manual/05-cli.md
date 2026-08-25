---
number: "05"
title: "The CLI"
---

# The CLI

## Install

```bash
npm i -g deploylog
```

Node 18+ required. The package installs two equivalent commands: `deploylog` and the short alias `dpl`.

## Log in

An API key is the credential the CLI sends with every request; you create it in the dashboard, and it starts with `dk_`. Chapter 11 covers keys, permissions and rotation.

```bash
deploylog login --key dk_xxx
```

`--key <key>` takes the key on the command line; omit it and the CLI asks for one at the prompt. `--api-url <url>` sets the API base URL, default `https://deploylog.dev`. A key that does not start with `dk_` is refused with `Invalid API key. Keys start with dk_` and exit 1. A URL that does not parse is refused with `Invalid API URL. Provide a valid absolute URL.` and exit 1; one that parses but is not http(s) or carries no host is refused with `Invalid API URL. Must use http(s) and include a host.` and exit 1. On success, the CLI prints the config path it wrote. `deploylog logout` removes the stored credentials.

## init and .deploylog.yml

```yaml
project: my-app
default_type: feature   # optional
```

`deploylog init` scaffolds that file in the current directory. Flags: `-p, --project <slug>`, `-T, --type <type>`, `--force`, `--json`. With no `-p` and exactly one project in the organization, the CLI uses it; with several it offers a numbered pick, and a bad answer is treated as a bail with `Cancelled. No config written.` and exit 0.

Guard rails, each with its refusal:

- The file already exists and `--force` was not passed: the CLI prints that it exists and to pass `--force` to overwrite it, and exits 1.
- `-T` names something other than feature, fix, improvement, breaking or announcement: the CLI names the allowed set and exits 1.
- The organization has no projects yet: the CLI tells you to create one first with `deploylog projects create <name>` and exits 1.
- Several projects and no terminal to prompt on, which is what `--json` forces: `Multiple projects found. Pass --project <slug> in non-interactive mode.` and exit 1.

**Project resolution** is the order the CLI picks a project: `-p, --project <slug>` first, then the `project` key in `.deploylog.yml`. With neither, the command prints `No project specified.` with the two-line fix and exits 1.

## push

```bash
deploylog push --from-git --ai-summarize
```

`-g, --from-git` derives the title and body from the commits since the last tag; `--git` is the alias. The version comes from the tag at HEAD unless `--version <version>` overrides it. `-a, --ai-summarize` rewrites the entry with Claude Haiku, and `--ai` is the alias; the rewrite replaces the body and the type but never an explicit `-t, --title`. Other flags: `-b, --body <markdown>`, `-p, --project <slug>`, `-T, --type <type>`, `-P, --publish`, `-D, --draft`, `-y, --yes`, `--json`.

An entry is a draft by default. Pass both `-P, --publish` and `-D, --draft` and the CLI saves a draft and says so, exit 0.

What stops a push:

- `--from-git` outside a repository: `Not in a git repository. Remove --from-git or cd to a repo.` and exit 1.
- No commits since the last tag, with no `--body` and no AI: the CLI names the tag it found nothing since and exits 1, with error code `NO_COMMITS` under `--json`.
- `--ai-summarize` with nothing to read: `--ai-summarize needs source material. Pass --from-git or provide --body as raw notes.` and exit 1.
- No title or no body after all derivation: `Entry requires --title and --body (or --from-git / --ai-summarize to derive them).` and exit 1.

On a terminal, an AI-written entry is previewed and confirmed before it is created; decline and nothing is created, exit 0. `-y, --yes` skips that prompt. In a shell with no terminal and no `-y`, the CLI proceeds without confirmation and prints a notice that it did.

## The entry commands

Every one of these takes a slug or an id, and `-p, --project <slug>`. Slugs are matched against the 50 most recent entries; older entries need the id.

**list** (alias `ls`) prints recent entries with their status, type, version, slug, and id. Flags: `--drafts`, `--published`, `-T, --type <type>`, `-n, --limit <n>` capped at 1-50, `--json`. Pass `--drafts` and `--published` together and the CLI refuses with `Use at most one of --drafts / --published.` and exit 1. When the returned count reaches the limit, the CLI says it is showing the most recent and suggests narrowing or referencing by id.

**view** (alias `show`) prints one full entry including its Markdown body, plus id, slug, type, version, and dates. No match is `NOT_FOUND` on stderr and exit 1.

**edit** updates an entry from `-t, --title <title>`, `-T, --type <type>`, `--version <version>` (pass `""` to clear), `-b, --body <markdown>`, or `--body-file <path>` where `-` reads stdin. With no field flags on an interactive terminal, your `$EDITOR` opens prefilled with the current body; `--json` forces the non-interactive path and never opens it. Changing a draft's title can change its slug, and the CLI prints the old and new slug and tells you to switch scripts to the ID. A body the server rejects is reported as `VALIDATION_ERROR` with exit 1, and the text is saved to a recovery file rather than lost (the text you typed, written to a file the error names, so a failed save never loses it). Nothing to change, or a cancelled edit, prints a yellow line and exits 0.

**publish** (alias `pub`) flips a draft live and sends the email digest on Pro, at most once per entry. Re-running on an entry that is already published prints that there is nothing to do and exits 0. `unpublish` (alias `unpub`) sends it back to draft; the public page and the feeds drop it, and republishing sets a new publish date.

**delete** (alias `rm`) removes an entry permanently. It prompts on a terminal; `-y, --yes` skips the prompt and is required when there is no terminal, which `--json` guarantees, so a `--json` delete without `-y` refuses and exits 1. Declining the prompt cancels with exit 0.

## --json

`--json` is a machine contract. Raw JSON on stdout, errors as `{"error":{"code", "message"}}` on stderr, and **no interactive prompts, ever**: no editor, no confirmation, no project pick. Progress lines move to stderr so stdout stays a single parseable payload.

```bash
deploylog list --drafts --json | jq -r '.[0].id'
```

## manual export

A manual is the project's versioned prose, its commit map, and the claims each chapter pins to code.

```bash
deploylog manual export -o - | jq '.versions | length'
```

Flags: `-p, --project <slug>`, `-o, --out <path>`, `--json`. The default output file is `./<slug>-manual.json`, and `-` streams the payload to stdout. The payload is validated against the server's published schema before anything is written, and the export is available on every plan. Anything that goes wrong, a project that cannot be resolved or a payload that does not parse, prints the reason on stderr and exits 1, as an error code and message under `--json`.

## manual verify

```bash
deploylog manual verify --changed-from origin/main --fail-on any
```

The check runs on DeployLog's side; the same check the GitHub Action runs on a pull request (chapter 06).

| Flag | Default |
| --- | --- |
| `-p, --project <slug>` | project resolution |
| `--repository <owner/repo>` | parsed from `git remote get-url origin` |
| `--ref <sha>` | `git rev-parse HEAD` |
| `--changed-from <base>` | the whole manual |
| `--fail-on <mode>` | `drift` |
| `--json` | human report |

The exit code is the answer. `1` means a cited value moved. `2` means the run could not vouch for the manual, and you asked for that with `--fail-on any`. `0` otherwise. Accepted modes are `none`, `drift`, and `any`; anything else is refused before a request is sent, with `INVALID_FAIL_ON` under `--json`, and exit 1.

Each derivation has its own refusal, and each names the flag that bypasses it, printing on stderr with exit 1: no `origin` remote, an `origin` that is not a github.com repository, no HEAD commit to verify at, and a `--changed-from` base that cannot be diffed against HEAD. A project with no manual under this key is reported the same way.

Two guards stop a false clean. An empty diff is not a scope: when nothing changed since the base, the CLI says so on stderr and verifies the whole manual instead. And when no claim in the manual cites the repository you sent, the CLI prints `verified nothing at <ref>: no claim cites <repository>` on stderr, whatever `--fail-on` is, because a fork or a mirror is a GitHub remote with the wrong slug.

```bash
# In a pre-push hook: block the push on drift
deploylog manual verify || exit 1
```
