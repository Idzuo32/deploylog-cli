# 05 — The manual check runs on this repository's pull requests

**Status:** done (merged 323b283 2026-08-25; the Manual check ran green on its own pull request, zero claims evaluated as expected)
**Type:** AFK
**Lane:** deploylog-cli
**Parent:** deploylog/issues/93-chapter-00-cross-refs-set-publish-v1.md
**Blocked by:** None — can start immediately
**Commit:** da74af4
**Verification:** the `Manual check` workflow runs on this pull request and finishes once the secret exists; on a later pull request that changes `src/index.ts`, the claims chapter 05 pins to it are evaluated (touched > 0) instead of counting as unmapped

## What to build
Chapter 05 of the DeployLog manual cites `README.md`, `src/index.ts`, `src/push.ts`, `src/init.ts` and `src/manual-verify.ts` in this repository (51 claims). A run of the Action's verify mode checks only the claims that cite the repository it runs in, so from the deploylog repo those 51 report `unmapped_repository`, and no push anywhere verifies them (`deploylog manual verify`, 2026-08-25). Add `.github/workflows/manual-check.yml`, the same file the deploylog repo runs (`deploylogdev/action@v1`, `mode: verify`, `project: deploylog`, `fail-on` left at its default `none`). This repository has no `DEPLOYLOG_API_KEY` secret: the first run fails until Marko adds one (`gh secret set DEPLOYLOG_API_KEY --repo marko-builds/deploylog-cli`, a read key from the dashboard's API Keys page), which is the known negative for the check.

## Acceptance criteria
- [x] `.github/workflows/manual-check.yml` on main, byte-identical to the deploylog repo's apart from the comment
- [x] Marko-only: the `DEPLOYLOG_API_KEY` secret exists in this repository (added 2026-08-25)
- [x] The `Manual check` run completes on a pull request after the secret exists
- [ ] The first later pull request touching `src/index.ts` shows the chapter 05 claims evaluated

## Boundaries
- Do NOT add secrets by hand; report the missing one
- Do NOT change CI
