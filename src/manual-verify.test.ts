import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { ApiError } from './api.js'
import { runManualVerify, type ManualVerifyDeps } from './manual-verify.js'
import { ManualVerifyResponseSchema } from './manual-verify-schema.js'
import type { GitRunner } from './git.js'

const REPO = 'marko-builds/deploylog'
const HEAD = 'b'.repeat(40)

/** The same argv-keyed stub `git.test.ts` uses; anything unmatched is a git failure. */
function stubRunner(replies: Record<string, string | null>): GitRunner {
  return (args: string[]) => {
    const key = args.join(' ')
    return key in replies ? replies[key]! : null
  }
}

const ORIGIN = 'remote get-url origin'
const REV_PARSE = 'rev-parse HEAD'
const DIFF = (base: string) =>
  `-c core.quotePath=false diff --name-only --no-renames ${base}...HEAD`

function healthyGit(overrides: Record<string, string | null> = {}): GitRunner {
  return stubRunner({
    [ORIGIN]: `https://github.com/${REPO}.git`,
    [REV_PARSE]: HEAD,
    ...overrides,
  })
}

function coverage() {
  return { sentences: 2, measurable: 2, claimed: 2, ratio: 1, unclaimed: [] }
}

function chapter(overrides: Record<string, unknown> = {}) {
  return {
    number: '01',
    title: 'Limits',
    state: 'CLEAR',
    confirmed: [],
    errors: [],
    touched: ['src/lib/limits.ts'],
    coverage: coverage(),
    untriggered: [],
    ...overrides,
  }
}

/** A clean sweep as the route test ships it; every count present and zero. */
function cleanReport(overrides: Record<string, unknown> = {}) {
  return {
    chapters: [chapter()],
    confirmedCount: 0,
    errorCount: 0,
    unanchoredCount: 0,
    evaluatedCount: 1,
    skippedCount: 0,
    lowCoverageChapters: [],
    untriggeredCount: 0,
    unverifiable: false,
    ...overrides,
  }
}

function driftReport() {
  return cleanReport({
    chapters: [
      chapter({
        state: 'CONFIRMED',
        confirmed: [
          {
            claimId: 'claim-1',
            text: 'A free organisation may create three projects.',
            repository: REPO,
            source: 'src/lib/limits.ts',
            line: 12,
            detail: 'FREE_PROJECT_LIMIT is now 5',
          },
        ],
      }),
    ],
    confirmedCount: 1,
  })
}

function makeDeps(overrides: Partial<ManualVerifyDeps> = {}): ManualVerifyDeps {
  return {
    api: { verifyManual: vi.fn().mockResolvedValue(cleanReport()) },
    readProjectConfig: () => ({ project: 'from-config' }),
    git: healthyGit(),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  }
}

function sent(deps: ManualVerifyDeps) {
  return (deps.api.verifyManual as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
}

function stdoutText(deps: ManualVerifyDeps) {
  return (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('')
}

function stderrText(deps: ManualVerifyDeps) {
  return (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('')
}

describe('manual verify — exit code follows --fail-on', () => {
  it('control: confirmedCount 1 exits non-zero under drift and 0 under none', async () => {
    const drift = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(driftReport()) } })
    const underDrift = await runManualVerify({ project: 'x', failOn: 'drift' }, drift)
    expect(underDrift.kind).toBe('verified')
    expect((underDrift as { exitCode: number }).exitCode).not.toBe(0)

    const none = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(driftReport()) } })
    const underNone = await runManualVerify({ project: 'x', failOn: 'none' }, none)
    expect(underNone.kind).toBe('verified')
    expect((underNone as { exitCode: number }).exitCode).toBe(0)
  })

  it('unverifiable with errorCount pinned to 0 exits 0 under drift and non-zero under any', async () => {
    // errorCount is 0 on purpose: a mapping of `any` that only looks at
    // errorCount passes drift and fails this test.
    const report = () =>
      cleanReport({
        chapters: [
          chapter({
            untriggered: [
              { claimId: 'c1', text: 'one', repository: 'other/repo' },
              { claimId: 'c2', text: 'two', repository: 'other/repo' },
              { claimId: 'c3', text: 'three', repository: 'other/repo' },
            ],
          }),
        ],
        confirmedCount: 0,
        errorCount: 0,
        untriggeredCount: 3,
        unverifiable: true,
      })

    const drift = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(report()) } })
    const underDrift = await runManualVerify({ project: 'x', failOn: 'drift' }, drift)
    expect((underDrift as { exitCode: number }).exitCode).toBe(0)

    const any = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(report()) } })
    const underAny = await runManualVerify({ project: 'x', failOn: 'any' }, any)
    expect(underAny.kind).toBe('verified')
    expect((underAny as { exitCode: number }).exitCode).not.toBe(0)
  })

  it('"found drift" and "could not check" never share an exit code', async () => {
    const drift = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(driftReport()) } })
    const driftRes = await runManualVerify({ project: 'x', failOn: 'any' }, drift)

    const broken = makeDeps({
      api: {
        verifyManual: vi
          .fn()
          .mockResolvedValue(cleanReport({ errorCount: 1, unverifiable: true })),
      },
    })
    const brokenRes = await runManualVerify({ project: 'x', failOn: 'any' }, broken)

    const a = (driftRes as { exitCode: number }).exitCode
    const b = (brokenRes as { exitCode: number }).exitCode
    expect(a).not.toBe(0)
    expect(b).not.toBe(0)
    expect(a).not.toBe(b)
  })
})

describe('manual verify — --changed-from scope', () => {
  it('sends the diffed paths when the diff is non-empty', async () => {
    const deps = makeDeps({
      git: healthyGit({ [DIFF('main')]: 'src/lib/limits.ts\ndocs/naïve path.md' }),
    })
    const res = await runManualVerify({ project: 'x', changedFrom: 'main' }, deps)
    expect(res.kind).toBe('verified')
    expect(sent(deps)[0].changedFiles).toEqual(['src/lib/limits.ts', 'docs/naïve path.md'])
    expect(stderrText(deps)).toBe('')
  })

  it('control: an empty diff sends changedFiles: null and says so, never []', async () => {
    const deps = makeDeps({ git: healthyGit({ [DIFF('main')]: '' }) })
    const res = await runManualVerify({ project: 'x', changedFrom: 'main' }, deps)

    expect(res.kind).toBe('verified')
    expect(sent(deps)).toHaveLength(1)
    // The captured body, not the option: a version that forwards `[]` fails here.
    expect(sent(deps)[0].changedFiles).toBeNull()
    expect(stderrText(deps)).toMatch(/whole manual/i)
  })

  it('an invalid --changed-from base is a named error and nothing is sent', async () => {
    const deps = makeDeps({ git: healthyGit() })
    const res = await runManualVerify({ project: 'x', changedFrom: 'nope' }, deps)
    expect(res.kind).toBe('bad-base')
    expect((res as { message: string }).message).toContain('nope')
    expect((res as { message: string }).message).toContain('--changed-from')
    expect(sent(deps)).toHaveLength(0)
  })
})

describe('manual verify — the "verified nothing" guard', () => {
  for (const failOn of ['none', 'drift', 'any'] as const) {
    it(`evaluatedCount 0 prints the stderr line under --fail-on ${failOn}`, async () => {
      const deps = makeDeps({
        api: {
          verifyManual: vi.fn().mockResolvedValue(
            cleanReport({ chapters: [chapter({ touched: [] })], evaluatedCount: 0 }),
          ),
        },
      })
      const res = await runManualVerify({ project: 'x', failOn }, deps)
      expect(res.kind).toBe('verified')
      const err = stderrText(deps)
      expect(err).toContain(`verified nothing at ${HEAD}`)
      expect(err).toContain(REPO)
    })
  }

  it('every claim untriggered (a fork slug) prints the line even with evaluatedCount > 0', async () => {
    const deps = makeDeps({
      api: {
        verifyManual: vi.fn().mockResolvedValue(
          cleanReport({
            chapters: [
              chapter({
                untriggered: [{ claimId: 'c1', text: 'one', repository: 'upstream/repo' }],
              }),
            ],
            evaluatedCount: 1,
            skippedCount: 0,
            untriggeredCount: 1,
            unverifiable: true,
          }),
        ),
      },
    })
    await runManualVerify({ project: 'x', repository: 'fork/repo' }, deps)
    expect(stderrText(deps)).toContain('verified nothing')
    expect(stderrText(deps)).toContain('fork/repo')
  })

  it('a healthy sweep prints nothing on stderr', async () => {
    const deps = makeDeps()
    await runManualVerify({ project: 'x' }, deps)
    expect(stderrText(deps)).toBe('')
  })
})

describe('manual verify — the outgoing body is validated before the send', () => {
  it('a 7-char short sha from git exits non-zero naming `ref`, and nothing is sent', async () => {
    const deps = makeDeps({ git: healthyGit({ [REV_PARSE]: 'abc1234' }) })
    const res = await runManualVerify({ project: 'x' }, deps)
    expect(res.kind).toBe('invalid-request')
    expect((res as { message: string }).message).toContain('ref')
    expect((res as { message: string }).message).toContain('--ref')
    expect(sent(deps)).toHaveLength(0)
  })

  it('a traversal path in the diff never reaches the wire', async () => {
    const deps = makeDeps({ git: healthyGit({ [DIFF('main')]: '../outside.ts' }) })
    const res = await runManualVerify({ project: 'x', changedFrom: 'main' }, deps)
    expect(res.kind).toBe('invalid-request')
    expect((res as { message: string }).message).toContain('changedFiles.0')
    expect(sent(deps)).toHaveLength(0)
  })
})

describe('manual verify — git derivations and their named errors', () => {
  it('derives repository and ref from git when unset', async () => {
    const deps = makeDeps()
    await runManualVerify({ project: 'x' }, deps)
    expect(sent(deps)[0]).toEqual({
      project: 'x',
      repository: REPO,
      ref: HEAD,
      changedFiles: null,
    })
  })

  it('explicit --repository and --ref win over git', async () => {
    const other = 'c'.repeat(40)
    const deps = makeDeps()
    await runManualVerify({ project: 'x', repository: 'someone/else', ref: other }, deps)
    expect(sent(deps)[0]).toMatchObject({ repository: 'someone/else', ref: other })
  })

  it('parses the SSH remote form', async () => {
    const deps = makeDeps({ git: healthyGit({ [ORIGIN]: `git@github.com:${REPO}.git` }) })
    await runManualVerify({ project: 'x' }, deps)
    expect(sent(deps)[0].repository).toBe(REPO)
  })

  it('no `origin` remote exits non-zero with its own kind, naming --repository', async () => {
    const deps = makeDeps({ git: stubRunner({ [REV_PARSE]: HEAD }) })
    const res = await runManualVerify({ project: 'x' }, deps)
    expect(res.kind).toBe('no-remote')
    expect((res as { message: string }).message).toContain('--repository')
    expect(sent(deps)).toHaveLength(0)
  })

  it('a non-GitHub remote exits non-zero naming --repository', async () => {
    const deps = makeDeps({
      git: healthyGit({ [ORIGIN]: 'https://gitlab.com/someone/repo.git' }),
    })
    const res = await runManualVerify({ project: 'x' }, deps)
    expect(res.kind).toBe('non-github-remote')
    expect((res as { message: string }).message).toContain('--repository')
    expect((res as { message: string }).message).toContain('gitlab.com')
    expect(sent(deps)).toHaveLength(0)
  })

  it('an empty repository (no HEAD) exits non-zero with its own kind', async () => {
    const deps = makeDeps({ git: stubRunner({ [ORIGIN]: `https://github.com/${REPO}` }) })
    const res = await runManualVerify({ project: 'x' }, deps)
    expect(res.kind).toBe('no-head')
    expect((res as { message: string }).message).toContain('--ref')
    expect(sent(deps)).toHaveLength(0)
  })

  it('the three git failures are three distinct kinds', async () => {
    const kinds = await Promise.all([
      runManualVerify({ project: 'x' }, makeDeps({ git: stubRunner({ [REV_PARSE]: HEAD }) })),
      runManualVerify(
        { project: 'x' },
        makeDeps({ git: stubRunner({ [ORIGIN]: `https://github.com/${REPO}` }) }),
      ),
      runManualVerify({ project: 'x', changedFrom: 'nope' }, makeDeps()),
    ])
    expect(new Set(kinds.map((k) => k.kind)).size).toBe(3)
  })

  it('needs no git at all when every derived field is passed as a flag', async () => {
    const deps = makeDeps({ git: stubRunner({}) })
    const res = await runManualVerify({ project: 'x', repository: REPO, ref: HEAD }, deps)
    expect(res.kind).toBe('verified')
  })

  it('resolves the project from .deploylog.yml, explicit flag wins', async () => {
    const fromConfig = makeDeps()
    await runManualVerify({}, fromConfig)
    expect(sent(fromConfig)[0].project).toBe('from-config')

    const flag = makeDeps()
    await runManualVerify({ project: 'flag' }, flag)
    expect(sent(flag)[0].project).toBe('flag')
  })

  it('refuses with no project from either source, before any git or request', async () => {
    const deps = makeDeps({ readProjectConfig: () => null, git: stubRunner({}) })
    const res = await runManualVerify({}, deps)
    expect(res.kind).toBe('missing-fields')
    expect(sent(deps)).toHaveLength(0)
  })
})

describe('manual verify — --json', () => {
  it('emits only the validated payload on stdout, stderr empty on success', async () => {
    const deps = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(driftReport()) } })
    const res = await runManualVerify({ project: 'x', json: true, failOn: 'none' }, deps)
    expect(res.kind).toBe('verified')
    const out = stdoutText(deps)
    const parsed = ManualVerifyResponseSchema.safeParse(JSON.parse(out))
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(driftReport())
    expect(stderrText(deps)).toBe('')
  })

  it('still exits by --fail-on under --json', async () => {
    const deps = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(driftReport()) } })
    const res = await runManualVerify({ project: 'x', json: true }, deps)
    expect((res as { exitCode: number }).exitCode).toBe(1)
  })
})

describe('manual verify — human output', () => {
  it('one line per chapter, per confirmed finding (source:line or source alone), per error', async () => {
    const report = cleanReport({
      chapters: [
        chapter({
          state: 'CONFIRMED',
          confirmed: [
            {
              claimId: 'c1',
              text: 'Three projects.',
              repository: REPO,
              source: 'src/lib/limits.ts',
              line: 12,
              detail: 'now 5',
            },
            {
              claimId: 'c2',
              text: 'It cannot be changed later.',
              repository: REPO,
              source: 'src/lib/lock.ts',
              line: null,
              detail: 'the symbol is gone',
            },
          ],
          errors: [
            {
              claimId: 'c3',
              text: 'Billing is monthly.',
              repository: 'marko-builds/other',
              source: 'src/billing.ts',
              reason: 'unmapped_repository',
              detail: 'no pin for marko-builds/other',
            },
          ],
        }),
      ],
      confirmedCount: 2,
      errorCount: 1,
      evaluatedCount: 3,
      lowCoverageChapters: ['02 Billing'],
      unverifiable: true,
    })
    const deps = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(report) } })
    await runManualVerify({ project: 'x', failOn: 'any' }, deps)
    const out = stdoutText(deps)

    expect(out).toContain('01 Limits  CONFIRMED')
    expect(out).toContain('src/lib/limits.ts:12')
    expect(out).toMatch(/src\/lib\/lock\.ts {2}"It cannot be changed later\."/)
    expect(out).not.toContain('src/lib/lock.ts:null')
    expect(out).toContain('unmapped_repository')
    expect(out).toContain("marko-builds/other is not in this project's commit map")
    expect(out).toContain('Summary: confirmed 2 / errors 1 / unanchored 0 / evaluated 3 / skipped 0')
    expect(out).toContain('Low coverage: 02 Billing')
    expect(out).toContain('could not vouch')
    expect(stderrText(deps)).toBe('')
  })

  it('a clean sweep says so', async () => {
    const deps = makeDeps()
    await runManualVerify({ project: 'x' }, deps)
    expect(stdoutText(deps)).toContain('Manual check passed: no drift found.')
  })
})

describe('manual verify — honest errors', () => {
  it('a payload that fails the mirrored schema exits non-zero with the first failing path', async () => {
    const bad = cleanReport() as Record<string, unknown>
    delete bad.errorCount
    const deps = makeDeps({ api: { verifyManual: vi.fn().mockResolvedValue(bad) } })
    const res = await runManualVerify({ project: 'x' }, deps)
    expect(res.kind).toBe('invalid-payload')
    expect((res as { message: string }).message).toContain('errorCount')
    expect(stdoutText(deps)).toBe('')
  })

  it('a payload with an extra top-level key is refused (the mirror is strict)', async () => {
    const deps = makeDeps({
      api: { verifyManual: vi.fn().mockResolvedValue({ ...cleanReport(), extra: 1 }) },
    })
    const res = await runManualVerify({ project: 'x', json: true }, deps)
    expect(res.kind).toBe('invalid-payload')
    expect(stdoutText(deps)).toBe('')
  })

  it('404 from the route exits non-zero with the project slug in the message', async () => {
    const deps = makeDeps({
      api: {
        verifyManual: vi
          .fn()
          .mockRejectedValue(new ApiError(404, 'NOT_FOUND', "Project 'ghost' not found")),
      },
    })
    const res = await runManualVerify({ project: 'ghost' }, deps)
    expect(res.kind).toBe('not-found')
    expect((res as { message: string }).message).toContain('ghost')
  })

  it('lets a 401 through untouched, so the adapter prints the existing login nudge', async () => {
    const err = new ApiError(401, 'UNAUTHORIZED', 'Invalid API key')
    const deps = makeDeps({ api: { verifyManual: vi.fn().mockRejectedValue(err) } })
    await expect(runManualVerify({ project: 'x' }, deps)).rejects.toBe(err)
  })
})

describe('manual verify — no tier gate', () => {
  it('neither the command nor its schema mirror references the tier word or can()', () => {
    for (const file of ['./manual-verify.ts', './manual-verify-schema.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/plan/i)
      expect(source, file).not.toMatch(/\bcan\s*\(/)
    }
  })
})

describe('mirrored ManualVerifyResponseSchema', () => {
  it('accepts the shapes the fixtures ship', () => {
    expect(ManualVerifyResponseSchema.safeParse(cleanReport()).success).toBe(true)
    expect(ManualVerifyResponseSchema.safeParse(driftReport()).success).toBe(true)
  })

  it('requires every count (an optional count would let drift arrive looking like none)', () => {
    for (const key of [
      'confirmedCount',
      'errorCount',
      'unanchoredCount',
      'evaluatedCount',
      'skippedCount',
      'untriggeredCount',
    ]) {
      const bad = cleanReport() as Record<string, unknown>
      delete bad[key]
      expect(ManualVerifyResponseSchema.safeParse(bad).success, key).toBe(false)
    }
  })
})
