# 07 — Ship an agent skill with the CLI: `deploylog init` writes `.agents/skills/deploylog/`

**Status:** queued (v1.2, ~Oct 20 to Nov 3 2026 — the same window as 06, deliberately)
**Type:** HUMAN (foreground; pairs with 06, which is also Marko-gated)
**Lane:** deploylog-cli
**Parent:** `deploylog/docs/roadmap.md` v1.2 "dev distribution". Sourced from a 2026-08-29 mine of `remix-run/remix` (monolith `knowledge/pages/concept-skill-shipped-with-package.md`).
**Blocked by:** Issue 06. Not for sequencing — for *ownership*: 06 already ships a `plugin/skills/changelog/SKILL.md`, and this issue must not create a second, divergent copy of the same body. Whichever lands first writes the canonical body; the other consumes it.
**Verification:** in a scratch git repo with no DeployLog state, `npx deploylog init --project demo` writes both `.deploylog.yml` and `.agents/skills/deploylog/SKILL.md`; a second run without `--force` leaves BOTH untouched and says so; a second run with `--force` rewrites both. The known negative — a check that cannot fail is not a check: `deploylog init --no-skill` must write `.deploylog.yml` and **no** `.agents/` directory, asserted by `existsSync` on the path, not by reading stdout.

## Why
Remix 3 ships `template/.agents/skills/remix/SKILL.md` inside `@remix-run/cli@0.5.0`'s published tarball (verified against the tarball, not the README), so `remix new` scaffolds a project that already teaches any agent how to use the framework. DeployLog's ICP is the same person: shipping from a terminal with an agent in it.

The gap this closes is specific. Today an agent in a user's repo learns `deploylog` from its training data, which predates every command in this CLI. It guesses flags, invents subcommands, and reaches for `push` when `manual verify` is the point. A skill on disk in the user's repo is the cheapest context that agent will ever have and needs no network, no MCP host, and no plugin marketplace.

**The delivery hook is `deploylog init`, not the tarball.** This is the one place the Remix analogy has to be adapted rather than copied: `remix new` scaffolds a *directory*, so dropping files in it is free. `deploylog` runs inside a repo the user already has, and a file sitting in `node_modules/deploylog/` is not on any agent's search path. `init` (`src/index.ts:587`) already scaffolds `.deploylog.yml` into the user's cwd with `--force` and `--json` semantics — it is DeployLog's `remix new`, and extending it is the whole delivery mechanism.

## What to build
1. **A skill body**, authored once, at `skills/deploylog/SKILL.md` in this repo (the canonical copy; `plugin/skills/changelog/` from 06 becomes a build-time copy of it, or a pointer — pick one in the 06 build session and record it in the ticket that lands second). Contents: the entry-type vocabulary (`feature | fix | improvement | breaking | announcement`, `schemas.ts:4`), the `version` format (`^\d+\.\d+\.\d+$`), the draft → read back → publish loop with the explicit statement that publishing emails subscribers, when to use `manual verify`, and the `.deploylog.yml` resolution rule. Written to `writing-great-skills` conventions: a `description:` as a folded block scalar (`>-`), leading words that say when to use it and what it will *not* do.
2. **`files: ["skills"]`** in `package.json` so the body is in the tarball, and a `--no-skill` flag plus a `skill:` key in `.deploylog.yml` for opt-out.
3. **`init` writes it**: create `.agents/skills/deploylog/SKILL.md` relative to the same directory it writes `.deploylog.yml` to. Never overwrite without `--force`. Report both paths in the human output and in `--json` (`{path, skill_path, project, default_type}`).
4. **A `deploylog skill` subcommand** (`--print` to stdout, `--write [dir]`) so an existing project that ran `init` months ago can pick the skill up without re-running init, and so a user on a different agent can pipe it wherever their tool reads.
5. **Vendor-neutral path, per the fourth fan-out specimen**: write `.agents/skills/`, not `.claude/skills/`. Do not fan out copies into per-tool directories — that is a drift generator with no linter behind it. Document the one-line copy for users whose tool only reads `.claude/`.

## Acceptance criteria
- [ ] `skills/deploylog/SKILL.md` exists, and its frontmatter parses under a real YAML parser (the `": "`-in-a-plain-scalar trap; use `description: >-`)
- [ ] `npm pack` contains `skills/deploylog/SKILL.md` — asserted by a test that reads the packed tarball's file list, not by eyeballing `files`
- [ ] `deploylog init` writes `.deploylog.yml` **and** `.agents/skills/deploylog/SKILL.md`; both paths reported in human and `--json` output
- [ ] Re-running `init` without `--force` overwrites neither and says which already existed; with `--force` rewrites both
- [ ] `deploylog init --no-skill` writes no `.agents/` directory (the known negative, asserted on the filesystem)
- [ ] `deploylog skill --print` emits the body; `deploylog skill --write .` places it; both work in a repo with no `.deploylog.yml`
- [ ] One body only: a test asserts `plugin/skills/changelog/SKILL.md` (once 06 lands) is byte-identical to, or generated from, `skills/deploylog/SKILL.md`
- [ ] Every command and flag the skill names is verified against `src/index.ts` in the same change — a skill that documents a flag the CLI does not have is worse than no skill
- [ ] Docs page + README section covering `init`'s new output, `deploylog skill`, and the `.claude/` copy line
- [ ] CLI manual chapters re-verified (`deploylog manual verify` exit 0) after the command surface grows

## Boundaries
- Do NOT write into `.claude/skills/`, or fan out per-tool copies
- Do NOT write anything outside the directory `init` already targets, and never above the git root
- Do NOT ship a second skill body; 06's plugin skill and this one are one file
- Do NOT make the skill a network fetch — the entire value is that it works offline, in-repo
- Do NOT let this slip into the launch. `deploylog` versions independently of the app, and Tue Sep 15 is protected
- Do NOT claim "the only changelog tool with an agent skill" anywhere until each competitor's docs are checked by name (the same rule 06 carries)

## Open before build
- Whether `plugin/skills/changelog/` (06) is a generated copy or a pointer — decided in whichever build session runs first
- Whether `init` should also write an `AGENTS.md` stanza, or only the skill. Leaning skill-only: appending to a file the user owns is a different risk class from creating one in a namespaced directory
- Whether the skill body should inline the entry-type vocabulary or read it from the API at write time. Leaning inline — offline is the point — with the `manual verify` loop as the drift check
