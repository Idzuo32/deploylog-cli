# 04 — `deploylog manual verify`: the drift check from a terminal or any CI

**Status:** done 2026-08-25 — PR #9 merged (`097dfff`), 171 tests, tsc + build green; version left at 0.5.0, `npm publish` is Marko's · **Type:** AFK · **Lane:** deploylog-cli
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
  `--changed-from <base>`, which sends
  `git -c core.quotePath=false diff --name-only --no-renames <base>...HEAD` (quotePath off so a
  non-ASCII path is not octal-escaped into a string that matches no anchor; `--no-renames` so a
  claim citing the OLD path of a renamed file still lands in scope, the way the Action keeps
  `previous_filename`, `deploylog-action/src/verify-context.ts:31-35`).
  **An empty diff is not a scope.** If `--changed-from` yields zero paths, send `changedFiles: null`
  (full sweep) and say so on stderr; never send `[]`. The route passes the array straight through
  (`route.ts:182-183`) and the service skips every claim outside it (`manual-verification.ts:289`),
  so `[]` verifies nothing and reports a clean sweep, byte-identical to a real one. The Action
  refuses the same case (`verify-context.ts:97-99`, "Zero is not a scope").
  A non-GitHub remote, no `origin` remote, an empty repo (`rev-parse HEAD` fails), or an invalid
  `--changed-from <base>` is each a **named** error telling the user which flag to pass; never a
  crash and never an empty send.
- Reuse `src/git.ts` (`runGit`, `GitRunner`, `isGitRepo`) and add thin helpers there
  (`originSlug`, `headSha`, `changedPathsSince`); thread a `GitRunner` through the command the way
  `manual.ts` threads `ManualExportDeps`, so every derivation rule is testable against the existing
  `stubRunner` harness (`git.test.ts:9-16`) with no real repo.
- **A fork or mirror is a GitHub remote with the wrong slug.** The route re-pins only the slug you
  send (`route.ts:48-56,187`); claims citing another repository keep their stored pin and go
  `untriggered`, so under `drift` a run can report green having verified nothing at your ref. Two
  guards: the README states `--repository` must be a repository the manual's commit map covers; and
  when `evaluatedCount === 0` (or `untriggeredCount` equals the claim total) print a loud stderr
  line "verified nothing at <ref>: no claim cites <repository>" regardless of `--fail-on`.
- Validate the **outgoing** body with `safeParse` against the mirrored request schema before the
  POST and name the first failing path locally; the route's 400 carries `details` only and
  `api.ts:52` would surface it as "Request failed (400)".
- Mirror `ManualVerifyRequestSchema`, `ManualVerifyResponseSchema` and what they embed
  (`VerifyChapterResultSchema`, `VerifyCoverageSchema`, the confirmed / error / untriggered finding
  schemas at `schemas.ts:759-797`, `VERIFY_VERDICTS`, `VERIFY_ERROR_REASONS`) verbatim; reuse
  `REPOSITORY_SLUG`, `CommitShaSchema` and `RepoFilePathSchema` already mirrored in
  `src/manual-schema.ts:12-45` rather than cutting a third copy from `deploylog/src/lib/schemas.ts` with a
  `// mirrored from deploylog src/lib/schemas.ts @ 4c115c0` line, the way `manual export` mirrors
  its contract. The request schema is `.strict()`; send nothing it does not list.
- Human output: one line per chapter with its verdict counts, then one line per confirmed finding
  (`source:line`, or `source` alone when `line` is null: a disappearance, `schemas.ts:766`; the
  claim text; the detail) and one per error finding with its reason. Summary
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
- [ ] A mocked response with `unverifiable: true`, `untriggeredCount: 3`, `errorCount: 0` and
      `confirmedCount: 0` exits 0 under `drift` and non-zero under `any` (errorCount pinned to 0 so
      an errorCount-only mapping of `any` fails this test).
- [ ] Control for the empty-diff guard: a stubbed runner whose diff returns no paths makes the
      command send `changedFiles: null` (assert on the captured request body) and print the
      full-sweep note; a version that sends `[]` must fail this test.
- [ ] A stubbed response with `evaluatedCount: 0` prints the "verified nothing" line on stderr under
      every `--fail-on` value.
- [ ] A locally-derived body that fails the mirrored request schema (stub `headSha` to return a
      7-char short sha) exits non-zero naming `ref`, without any request being sent.
- [ ] No `origin` remote, an empty repo, and an invalid `--changed-from` base each exit non-zero
      with a distinct named error (three stubbed runners).
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

## Red-team fold-in (2026-08-25)

`plan-review-redteamer` verdict: ship-with-fixes. Blocking: the empty `--changed-from` diff sending
`[]` (a false clean on the demo command). Folded above: the empty-diff guard, rename + quotePath
flags, named git errors, fork/mirror "verified nothing" warning, outgoing-body validation, the
complete mirror list, nullable `line`, the pinned `any` fixture, and `src/git.ts` reuse. Confirmed
OK, do not re-litigate: the exit mapping (`any = unverifiable || errorCount > 0` equals the Action's
`drift > 0 || notCleanReasons`, `manual-verification.ts:214-218` vs `deploylog-action/src/verdict.ts:74-107`),
the strict request body, the `read` permission scope, and the `4c115c0` mirror sha. Note only:
503 `NOT_CONFIGURED` is reachable via `--api-url` and the generic `ApiError` path prints it honestly.
