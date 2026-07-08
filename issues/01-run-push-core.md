# 01 — Testable push core: runPush(opts, deps) (B5)

**Status:** done · **Type:** AFK · **Lane:** deploylog-cli
**Parent:** deploylog/docs/prd-satellites-hardening.md
**Blocked by:** None — can start immediately
**Verification:** contract B5.1-4 — table tests through `runPush` alone: precedence chains, publish/draft conflict, no-commits / no-ai-source guards, `--yes`/TTY matrix (BUG-019). Signal: `vitest run` (no process spawn, no network, no real git).

## What to build

Give the ~130-line `push` orchestration (currently inline in a commander `.action()` callback, zero
tests) an interface, so the whole behavioral contract becomes fast unit tests. Copy the
`GitRunner` injection pattern already proven in `git.ts` — do not invent a new one.

- `src/push.ts`: `runPush(opts: PushOptions, deps: { git, api, readProjectConfig, confirm, isTTY, out }): Promise<PushResult>`
  - `PushResult` = the created entry, or a typed refusal
    `{ kind:'no-commits'|'no-ai-source'|'missing-fields'|'cancelled'; message }` — replaces the
    eight `process.exit(1)` sites.
  - `deps` default to the real modules; `index.ts` collapses to a thin adapter (commander opts →
    `runPush` → print/exit).
- Behavior to pin (unchanged, just made testable): title/body/type/version precedence
  (`opts.title ?? gitTitle`, `opts.type ?? projectConfig?.default_type ?? null`,
  `opts.version ?? gitVersion`); AI result overrides body but not an explicit `--title`; git
  gathering precedes the AI-source check; `--publish`+`--draft` conflict; the `--yes`/interactive/
  non-interactive matrix (BUG-019 — the fix exists but has no regression test).

## Acceptance criteria

- [ ] `src/push.ts` exports `runPush(opts, deps)` returning `PushResult`; `index.ts` is a thin adapter with `deps` defaulting to real modules.
- [ ] Table tests cover: precedence chains, alias reconciliation (`-g`/`--git`, `-a`/`--ai`), from-git-no-commits → `no-commits`, ai-without-source → `no-ai-source`, `--publish`+`--draft` conflict, `--yes`/TTY matrix, AI-title-override rule.
- [ ] No `process.exit` inside `runPush`; refusals are returned, not thrown/exited.
- [ ] `vitest run` passes without spawning a process, hitting the network, or running real git.
