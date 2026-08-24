# 03 — `deploylog manual export`: the CLI half of the portability answer

**Status:** done 2026-08-24 — PR #8 merged (f2366b6), zod runtime dep accepted (tsc-only build, no bundler; server's own major), 0.5.0 bumped, `npm publish` is Marko's · **Type:** AFK · **Lane:** deploylog-cli
**Parent:** deploylog/issues/57-manual-export.md (server half, done) → deploylog/issues/prd-manual.md
**Blocked by:** None in this repo. Observable arm needs `GET /api/cli/manual/export` live on deploylog.dev.
**Verification:** `vitest run` — a command test with a mocked `api.ts` response: writes the file, refuses on a payload that fails the response schema, exits non-zero on 404. Signal: `vitest run`.

## What to build

A `manual` command group with one subcommand, `manual export`, that calls
`GET /api/cli/manual/export?project=<slug>` via the existing `src/api.ts` request helper (Bearer
`dk_` key, same as `whoami`) and writes the JSON payload to a file a human can open.

- `deploylog manual export [--project <slug>] [--out <path>]`. Project resolves the way `push` does
  (`src/resolve.ts` / `.deploylog.yml`), explicit flag wins. Default `--out` is
  `./<slug>-manual.json`; `-` writes to stdout.
- Validate the payload against the **server's published schema** before writing: copy
  `ManualExportResponseSchema` (and the `ClaimSchema` it embeds) from `deploylog/src/lib/schemas.ts`
  verbatim with a `// mirrored from deploylog src/lib/schemas.ts @ e4c4637` line, the way this repo
  already mirrors other contracts. A payload that fails validation is an error, not a file.
- Errors follow the honest-error mode of issue 02: 404 → "no manual for project X under this key",
  401 → the existing login nudge, schema failure → names the first failing path.
- Register in `src/index.ts` next to `whoami`; add it to the README command table.

## Acceptance criteria

- [ ] `deploylog manual export --project x --out f.json` writes the validated payload; the test's control is a fixture with a claim whose `expect` is removed, which must make the command exit non-zero and write nothing.
- [ ] `--out -` streams to stdout, nothing else on stdout (exit code and errors on stderr).
- [ ] 404 from the route exits non-zero with the project slug in the message.
- [ ] No plan gating anywhere in the command (grep: no `plan`/`can(` reference).
- [ ] `vitest run`, `tsc --noEmit`, build pass.

## Boundaries

- Do NOT build a reader, checker, diff or import for the exported file (deploylog issue 57 Boundaries).
- Do NOT bump the npm version or publish — that is Marko's (`npm publish` is a send).
- **If the live route's shape differs from the mirrored schema, STOP and report — do not loosen the schema.**
