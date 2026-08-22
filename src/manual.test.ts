import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { ApiError } from './api.js'
import { runManualExport, type ManualExportDeps } from './manual.js'
import { ManualExportResponseSchema } from './manual-schema.js'

const REPO = 'marko-builds/deploylog'
const SIBLING = 'marko-builds/deploylog-action'
const PINNED = 'a'.repeat(40)

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-1',
    text: 'A free organisation may create three projects.',
    repository: REPO,
    source: 'src/lib/plan.ts',
    symbol: 'FREE_PROJECT_LIMIT',
    kind: 'const' as const,
    expect: '3',
    ...overrides,
  }
}

/**
 * The same two-version manual the server route test exports: an archived
 * version cut with a commit map, and the working one exported with
 * `commitMap: null`. If this fixture ever fails the mirrored schema, the
 * mirror (not the fixture) has drifted from the route.
 */
function payload() {
  return {
    project: 'my-app',
    manual: { id: 'manual-1', title: 'The DeployLog Manual' },
    versions: [
      {
        id: 'version-1',
        label: 'v1.0',
        publishedAt: '2026-08-19T10:00:00.000Z',
        createdAt: '2026-08-19T10:00:00.000Z',
        commitMap: { [REPO]: PINNED, [SIBLING]: PINNED },
        chapters: [
          {
            number: '01',
            title: 'Plans and limits',
            status: 'published',
            body: 'A free organisation may create three projects. That is the free limit.',
            claims: [claim()],
          },
          {
            number: '02',
            title: 'Billing',
            status: 'published',
            body: 'Pro costs 19 dollars a month. Billing is monthly.',
            claims: [
              claim({
                id: 'claim-2',
                text: 'Pro costs 19 dollars a month.',
                source: 'src/lib/billing.ts',
                symbol: 'PRO_PRICE',
                expect: '19',
              }),
              claim({
                id: 'claim-3',
                text: 'Billing is monthly.',
                repository: SIBLING,
                source: 'src/verdict.ts',
                symbol: 'FAIL_ON_DEFAULT',
                expect: 'none',
              }),
            ],
          },
        ],
      },
      {
        id: 'version-2',
        label: 'draft',
        publishedAt: null,
        createdAt: '2026-08-20T10:00:00.000Z',
        commitMap: null,
        chapters: [
          {
            number: '01',
            title: 'Plans and limits',
            status: 'draft',
            body: 'A free organisation may create three projects.',
            claims: [claim()],
          },
        ],
      },
    ],
  }
}

function makeDeps(overrides: Partial<ManualExportDeps> = {}): ManualExportDeps {
  return {
    api: { exportManual: vi.fn().mockResolvedValue(payload()) },
    readProjectConfig: () => ({ project: 'from-config' }),
    writeFile: vi.fn(),
    stdout: vi.fn(),
    ...overrides,
  }
}

function writes(deps: ManualExportDeps) {
  return (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls
}

function stdoutChunks(deps: ManualExportDeps) {
  return (deps.stdout as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
}

describe('manual export — writes the validated payload', () => {
  it('writes the payload to --out as pretty JSON', async () => {
    const deps = makeDeps()
    const res = await runManualExport({ project: 'x', out: 'f.json' }, deps)

    expect(res).toEqual({ kind: 'written', path: 'f.json', versions: 2 })
    expect(deps.api.exportManual).toHaveBeenCalledWith('x')
    expect(writes(deps)).toHaveLength(1)
    const [path, text] = writes(deps)[0]
    expect(path).toBe('f.json')
    expect(JSON.parse(text)).toEqual(payload())
    expect(text.endsWith('\n')).toBe(true)
    expect(stdoutChunks(deps)).toEqual([])
  })

  it('control: a claim with its `expect` removed exits non-zero and writes nothing', async () => {
    const bad = payload()
    delete (bad.versions[0]!.chapters[0]!.claims[0] as { expect?: string }).expect
    const deps = makeDeps({ api: { exportManual: vi.fn().mockResolvedValue(bad) } })

    const res = await runManualExport({ project: 'x', out: 'f.json' }, deps)

    expect(res.kind).toBe('invalid-payload')
    // Names the first failing path, so the user can see what drifted.
    expect((res as { message: string }).message).toContain('versions.0.chapters.0.claims.0.expect')
    expect(writes(deps)).toHaveLength(0)
    expect(stdoutChunks(deps)).toEqual([])
  })

  it('control: a payload with an extra top-level key is refused (the mirror is strict)', async () => {
    const bad = { ...payload(), plan: 'free' }
    const deps = makeDeps({ api: { exportManual: vi.fn().mockResolvedValue(bad) } })

    const res = await runManualExport({ project: 'x', out: '-' }, deps)

    expect(res.kind).toBe('invalid-payload')
    expect(stdoutChunks(deps)).toEqual([])
  })

  it('defaults --out to ./<slug>-manual.json and resolves the slug from .deploylog.yml', async () => {
    const deps = makeDeps()
    const res = await runManualExport({}, deps)

    expect(res).toEqual({ kind: 'written', path: 'from-config-manual.json', versions: 2 })
    expect(deps.api.exportManual).toHaveBeenCalledWith('from-config')
  })

  it('an explicit --project wins over .deploylog.yml', async () => {
    const deps = makeDeps()
    await runManualExport({ project: 'flag' }, deps)
    expect(deps.api.exportManual).toHaveBeenCalledWith('flag')
    expect(writes(deps)[0][0]).toBe('flag-manual.json')
  })

  it('refuses with no project from either source, before any request', async () => {
    const deps = makeDeps({ readProjectConfig: () => null })
    const res = await runManualExport({}, deps)

    expect(res.kind).toBe('missing-fields')
    expect(deps.api.exportManual).not.toHaveBeenCalled()
    expect(writes(deps)).toHaveLength(0)
  })
})

describe('manual export — --out - streams to stdout', () => {
  it('puts the JSON and nothing else on stdout, and writes no file', async () => {
    const deps = makeDeps()
    const res = await runManualExport({ project: 'x', out: '-' }, deps)

    expect(res).toEqual({ kind: 'streamed', versions: 2 })
    expect(writes(deps)).toHaveLength(0)
    const chunks = stdoutChunks(deps)
    expect(chunks).toHaveLength(1)
    expect(JSON.parse(chunks[0])).toEqual(payload())
  })
})

describe('manual export — honest errors', () => {
  it('404 from the route exits non-zero with the project slug in the message', async () => {
    const deps = makeDeps({
      api: {
        exportManual: vi
          .fn()
          .mockRejectedValue(new ApiError(404, 'NOT_FOUND', "Project 'ghost' not found")),
      },
    })

    const res = await runManualExport({ project: 'ghost', out: 'f.json' }, deps)

    expect(res.kind).toBe('not-found')
    expect((res as { message: string }).message).toContain('ghost')
    expect(writes(deps)).toHaveLength(0)
  })

  it('lets a 401 through untouched, so the adapter prints the existing login nudge', async () => {
    const err = new ApiError(401, 'UNAUTHORIZED', 'Invalid API key')
    const deps = makeDeps({ api: { exportManual: vi.fn().mockRejectedValue(err) } })

    await expect(runManualExport({ project: 'x' }, deps)).rejects.toBe(err)
    expect(writes(deps)).toHaveLength(0)
  })
})

describe('manual export — no plan gate', () => {
  it('neither the command nor its schema mirror references plan or can()', () => {
    for (const file of ['./manual.ts', './manual-schema.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/plan/i)
      expect(source, file).not.toMatch(/\bcan\s*\(/)
    }
  })
})

describe('mirrored ManualExportResponseSchema', () => {
  it('accepts the shape the server route test ships', () => {
    expect(ManualExportResponseSchema.safeParse(payload()).success).toBe(true)
  })

  it('rejects an empty commit map (the route sends null, never {})', () => {
    const bad = payload()
    ;(bad.versions[0] as { commitMap: unknown }).commitMap = {}
    expect(ManualExportResponseSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a hand-authored anchors key on a claim (ClaimSchema is strict)', () => {
    const bad = payload()
    ;(bad.versions[0]!.chapters[0]!.claims[0] as Record<string, unknown>).anchors = []
    expect(ManualExportResponseSchema.safeParse(bad).success).toBe(false)
  })
})
