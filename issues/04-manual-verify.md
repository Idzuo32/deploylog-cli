# 04 — `deploylog manual verify`: the drift check from a terminal or any CI

**Status:** open 2026-08-25 · **Type:** AFK · **Lane:** deploylog-cli
**Parent:** deploylog/issues/56-manual-verify-endpoint.md (server half, done) → deploylog/issues/prd-manual.md
**Blocked by:** None in this repo. The observable arm needs `POST /api/cli/manual/verify` live on deploylog.dev (it is; `deploylog-action` verify mode calls it).
**Verification:** `vitest run` — command tests with a mocked `api.ts` response: exit code follows `--fail-on` for each of the three outcomes (drift found / could not check / clean), `--json` emits only the validated payload, a response that fails the mirrored schema exits non-zero. Signal: `vitest run`.

## Why

The server has had the verify route since 08-18 and the GitHub Action calls it, but nothing lets a
developer run the check from a terminal, a pre-push hook, or a non-GitHub CI. The CLI wraps one of
nine manual routes (`manual export`). This is the second, and the one the launch demo needs: "push,
run `deploylog manual verify`, watch it catch the planted drift" reads on a terminal in a way an
Action annotation does not. It is also the seam a later `manual generate --provider <local>` (BYO
AI, v1.1) will sit next to.

## What to build

`deploylog manual verify [--project <slug>] [--repository <owner/repo>] [--ref <sha>]
[--changed-from <base>] [--fail-on none|drift|any] [--json]`

- `POST /api/cli/manual/verify` with the body `{ project, repository, ref, changedFiles }` via the
  existing `src/api.ts` `request` helper (Bearer `dk_` key, same as `whoami` and `manual export`).
- Defaults: `project` resolves the way `push` does (`src/resolve.ts` / `.deploylog.yml`, explicit
  flag wins); `repository` parses `owner/repo` out of `git remote get-url origin` (HTTPS and SSH
  forms); `ref` = `git rev-parse HEAD`; `changedFiles` = `null` (whole manual) unless
  `--changed-from <base>`, which sends `git diff --name-only <base>...HEAD`. A non-GitHub remote or
  a non-repo cwd is an error naming the flag to pass, never a guess.
- Mirror `ManualVerifyRequestSchema`, `ManualVerifyResponseSchema` and what they embed
  (`VerifyChapterResultSchema`, the confirmed/error finding schemas, `VERIFY_VERDICTS`,
  `VERIFY_ERROR_REASONS`) verbatim from `deploylog/src/lib/schemas.ts` with a
  `// mirrored from deploylog src/lib/schemas.ts @ 4c115c0` line, the way `manual export` mirrors
  its contract. The request schema is `.strict()`; send nothing it does not list.
- Human output: one line per chapter with its verdict counts, then one line per confirmed finding
  (`source:line`, the claim text, the detail) and one per error finding with its reason. Summary
  line with `confirmedCount / errorCount / unanchoredCount / evaluatedCount / skippedCount`,
  `lowCoverageChapters` listed by name, and `unverifiable` stated in words when true.
- Exit code mirrors the Action's `fail-on` input (`deploylog-action/action.yml:19-22`; the Action
  defaults to `none`, the CLI defaults to `drift` because a terminal run is a person asking):
  `none` → 0 always; `drift` → non-zero when `confirmedCount > 0`; `any` → also non-zero when
  `unverifiable` is true or `errorCount > 0`. **"Found drift" and "could not check" never share an
  exit code** (prd-manual: the prototype's five verdicts exist to keep those apart).
- `--json` prints the validated response verbatim and nothing else on stdout; errors and the exit
  code on stderr, like `manual export --out -`.
- Errors follow issue 02's honest-error mode: 404 → "no manual for project X under this key";
  401 → the login nudge; an `unmapped_repository` error reason → a message naming the repository
  and that the project's commit map does not include it; schema failure → names the first failing
  path.
- Register under the existing `manual` group in `src/index.ts`; add the row to the README command
  table.

## Acceptance criteria

- [ ] Control, seen RED first (paste the red run in the PR body): a mocked response with
      `confirmedCount: 1` exits non-zero under `--fail-on drift` and 0 under `--fail-on none`.
- [ ] A mocked response with `unverifiable: true` and `confirmedCount: 0` exits 0 under `drift` and
      non-zero under `any`.
- [ ] `--json` emits only the validated payload on stdout (test asserts stdout parses as the
      response schema and stderr is empty on success).
- [ ] `repository` and `ref` derive from git when unset; explicit flags win; a non-GitHub remote
      exits non-zero naming `--repository`.
- [ ] A payload that fails the mirrored schema exits non-zero with the first failing path.
- [ ] No plan gating anywhere in the command (grep: no `plan` / `can(` reference).
- [ ] `vitest run`, `tsc --noEmit`, build pass.

## Boundaries

- Do NOT re-implement any checking client-side; the verdict comes from the route only.
- Do NOT add `generate` / `review` / `approve` / `versions` / `voice` subcommands here; each is its
  own v1.1 issue.
- Do NOT bump the npm version or publish; that is Marko's (`npm publish` is a send).
- Do NOT add dependencies beyond what 0.5.0 has (`zod` is already in).
- **If the live route's request or response shape differs from the mirrored schema, STOP and report — do not loosen the schema.**
