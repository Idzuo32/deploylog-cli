# 08 — Report an unrecognized key in `.deploylog.yml`

**Status:** done (uncommitted 2026-08-29 — sha pending Marko's commit) · **Type:** AFK · **Lane:** deploylog-cli
**Parent:** none — mined from the pnpm 12.0 release notes (`references/transcripts/145.txt`)
**Blocked by:** None
**Verification:** `vitest run src/project-config.test.ts` — 17 tests. Calibrated by mutation: gutting the report fails 7, making it always fire fails 1, removing the known-key type check fails 1.

## What to build

Close the remaining half of the A3 guard (issue 02). That issue made a *malformed*
`.deploylog.yml` stop the upward walk instead of silently adopting a parent's config. It left the
unchecked cast in place: `return parsed as ProjectConfig` accepted any key at all, so a
**well-formed file with a misspelled key** was dropped in silence.

Only two keys are recognized, both snake_case, and the README (`README.md:61`) is where people copy
them from. `default-type: fix` (hyphen) parses fine, means nothing, and the user gets the wrong
default type. `projects: my-app` (plural) produces "No project specified." Neither says why.

pnpm 12 fixed the same class in `pnpm-workspace.yaml` and its escalation rule is the part worth
copying: **warn by default, hard-error only where ambiguity is excluded.** pnpm errors when the
project pins a pnpm version the running binary satisfies — with the pin honoured, the setting
cannot have been meant for a different version, so it is a mistake rather than a key to ignore.
`.deploylog.yml` carries no version pin, so every unrecognized key here stays a warning: it may
belong to a newer CLI than the one installed, and failing would break a repo whose config outruns
its CLI.

## What was built

- `KNOWN_KEYS` is now the single list; adding a field to `ProjectConfig` means adding it there.
- Unrecognized keys produce ONE report naming the file, each key, a `did you mean X?` when it is
  within edit distance 2 of a real key, and the recognized set. The recognized keys still come
  back — it warns, never fails.
- A **recognized** key holding a non-string is a `ProjectConfigError`. That one was meant for us,
  so letting YAML's coercion through would push to a project literally named `123`.
- The return value is now built from the known keys explicitly rather than cast, so an unknown key
  cannot ride along on the returned object.
- `readProjectConfig(startDir?, warn?)` — the warn sink is injected (the `PushOutput` pattern) and
  defaults to `console.error(chalk.yellow(...))` on **stderr**, so stdout stays a clean JSON
  stream and convention 3 (`--json`) is unaffected. Verified against `dist/`, not just `src/`.

## Acceptance criteria

- [x] An unrecognized key is reported, not dropped, and the recognized keys still load.
- [x] A close typo (`default-type`, `defaultType`, `projects`) gets the right suggestion; a key
      resembling nothing (`banana`) gets none — a wrong guess is worse than no guess.
- [x] A correct config warns **nothing** (the calibration arm: a warning that fires on a valid file
      is noise, and a check that always fires is no better than one that never can).
- [x] A recognized key with the wrong type throws `ProjectConfigError`.
- [x] The default sink is exercised by a test, not only the injected spy.
- [x] `npm test` (184) and `npm run build` pass.

## Boundaries

- Not a schema library. Two keys and one list; zod here would be weight for nothing.
- Does not touch `config.ts` (the `conf` credential store) — see issue 09.
- Chapter 05 of the Manual does not document `.deploylog.yml` keys beyond the README snippet, so
  no chapter regeneration is implied. Confirm the `manual-check` annotations on the PR anyway,
  since `project-config.ts` is adjacent to cited files.
