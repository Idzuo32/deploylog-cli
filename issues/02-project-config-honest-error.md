# 02 — Honest project-config error mode (A3)

**Status:** ready-for-agent · **Type:** AFK · **Lane:** deploylog-cli
**Parent:** deploylog/docs/prd-satellites-hardening.md
**Blocked by:** None — can start immediately
**Verification:** contract A3.1-3 — tmp-dir tests: malformed YAML → explicit error + stop (no walk-up), not-found → keep walking → null, non-object YAML → typed error. Signal: `vitest run`.

## What to build

Fix the silent wrong-project failure in `src/project-config.ts`. Today the `catch` around
`readFileSync` *and* `parse` conflates "file not found" with "file malformed": a broken
`.deploylog.yml` at the repo root silently walks up and can pick a **parent directory's** config
(wrong-project push) or return null → misleading "No project specified." The user never learns
their YAML is invalid.

- `readProjectConfig(startDir = process.cwd())` — inject `startDir` (no ambient `process.cwd()`, so
  it's testable without `chdir`).
- Separate the cases: not-found → continue walking up; parse-failure → throw / return a typed error
  and **stop** (do not walk past a malformed file into a parent's config).
- Validate the parsed value is an object; reject a bare-string YAML that today flows in as
  `config?.project === undefined`.

## Acceptance criteria

- [ ] `readProjectConfig(startDir)` takes an injectable start directory.
- [ ] A malformed `.deploylog.yml` produces an explicit "invalid YAML" error and stops (does not adopt a parent directory's config).
- [ ] A not-found config keeps walking up and returns null (behavior unchanged).
- [ ] A non-object YAML is rejected with a typed error, not flowed in as undefined `project`.
- [ ] Tmp-dir tests cover found-in-parent, not-found → null, malformed → error, non-object → error (~6 tests).
- [ ] `vitest run` passes.
