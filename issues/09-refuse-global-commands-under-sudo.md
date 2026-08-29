# 09 — Refuse credential/global commands under sudo

**Status:** queued · **Type:** AFK · **Lane:** deploylog-cli
**Parent:** none — mined from the pnpm 12.0 release notes (`references/transcripts/145.txt`)
**Blocked by:** None
**Verification:** unit tests over an injected `isSudo`/env seam (no real sudo in the harness, and none is available from the agent sandbox anyway). Signal: `vitest run`.

## What to build

`config.ts` stores the API key with `conf`, which writes to the invoking user's OS config dir.
There is no sudo check anywhere in `src/` (`grep -rn "SUDO_USER\|getuid\|sudo" src/` → nothing).

The failure it allows: a user who installs globally with `sudo npm i -g deploylog` carries the
habit to `sudo deploylog login`. The key lands in **root's** config dir. Every later non-sudo
`deploylog push` then reports no credentials, and `deploylog config path` (run without sudo) points
at a file that does not contain the key. Nothing in that sequence says "you saved this as root."

pnpm 12 fails these with a named error, `ERR_PNPM_SUDO_NOT_SUPPORTED`, and the reasoning transfers
exactly: pnpm keeps global packages and config in the invoking user's home, so these commands never
need root. **Read-only** global commands (`pnpm bin --global`) keep working.

- Detect sudo as `process.env['SUDO_USER'] !== undefined` (present under `sudo`, absent under a
  real root login and under `su`). Prefer it over `process.getuid() === 0`, which would also refuse
  a container running legitimately as root — a false refusal costs what a false pass costs.
- Refuse only the commands that **write** credentials or global state: `login`, `logout`, and any
  future config-writing subcommand.
- Leave read-only commands working: `config path`, `--version`, `--help`, `whoami`, and anything
  that only reads the store. A user debugging the mess this prevents needs `config path` to answer.
- Message must name the fix, not just the refusal: run it without `sudo`, and if the install itself
  needed root that is an npm-prefix problem, not a deploylog one.
- Typed refusal per convention 2 — a `kind` on the domain result, the adapter picks the exit code.
  Do not `process.exit` inside the domain function.

## Acceptance criteria

- [ ] `SUDO_USER` set → `login` / `logout` refuse with a typed, named refusal and a non-zero exit.
- [ ] `SUDO_USER` set → read-only commands (`config path`, `whoami`, `--version`) still work.
- [ ] `SUDO_USER` unset → every command behaves exactly as today (the calibration arm: assert the
      guard is silent when it should be, or it is a check that always fires).
- [ ] Root **without** `SUDO_USER` (a container running as root) is NOT refused, with a test.
- [ ] `--json` mode emits the refusal as `{"error":{"code","message"}}` on stderr, per convention 3.
- [ ] `npm test` and `npm run build` pass.

## Boundaries

- Does not attempt to migrate a key already written to root's store. Detecting that would mean
  reading a path this process cannot read without root. Out of scope; the message is the remedy.
- Does not touch `.deploylog.yml` handling (issue 08) — different file, different failure.
- Ships with issue 06's `DEPLOYLOG_API_KEY` env fallback or before it; they do not conflict, but
  the env fallback changes what "no credentials" means, so land whichever first and re-read the
  other's acceptance list.
