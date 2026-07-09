import { describe, expect, it, vi } from 'vitest'
import { runOpen, type OpenDeps } from './open.js'
import type { EntryDetail } from './api.js'

const UUID = '3f2b8a1c-9d4e-4f6a-b2c3-1a2b3c4d5e6f'

const DETAIL: EntryDetail = {
  id: UUID,
  title: 'Ship it',
  slug: 'ship-it',
  entry_type: null,
  version: null,
  published: true,
  published_at: '2026-07-09T00:00:00.000Z',
  created_at: '2026-07-09T00:00:00.000Z',
  body_markdown: '# Body',
  updated_at: null,
}

function makeDeps(overrides: Partial<OpenDeps> = {}): OpenDeps {
  return {
    api: { getEntry: vi.fn().mockResolvedValue(DETAIL) },
    readProjectConfig: () => ({ project: 'my-app' }),
    launch: vi.fn().mockReturnValue(true),
    baseUrl: () => 'https://deploylog.dev',
    ...overrides,
  }
}

describe('runOpen', () => {
  it('opens the changelog page when no entry is given', async () => {
    const deps = makeDeps()
    const res = await runOpen({}, deps)

    expect(res).toEqual({ kind: 'opened', url: 'https://deploylog.dev/p/my-app/changelog' })
    expect(deps.api.getEntry).not.toHaveBeenCalled()
  })

  it('builds the entry URL from a slug without any API call', async () => {
    const deps = makeDeps()
    const res = await runOpen({ ref: 'ship-it' }, deps)

    expect(res).toEqual({ kind: 'opened', url: 'https://deploylog.dev/p/my-app/c/ship-it' })
    expect(deps.api.getEntry).not.toHaveBeenCalled()
  })

  it('resolves a uuid ref to its slug via the API', async () => {
    const deps = makeDeps()
    const res = await runOpen({ ref: UUID }, deps)

    expect(deps.api.getEntry).toHaveBeenCalledWith(UUID)
    expect(res).toEqual({ kind: 'opened', url: 'https://deploylog.dev/p/my-app/c/ship-it' })
  })

  it('prints the URL instead of opening when there is no browser to launch', async () => {
    const deps = makeDeps({ launch: vi.fn().mockReturnValue(false) })
    const res = await runOpen({}, deps)

    expect(res.kind).toBe('printed')
  })

  it('refuses without a project', async () => {
    const deps = makeDeps({ readProjectConfig: () => null })
    const res = await runOpen({}, deps)

    expect(res.kind).toBe('missing-fields')
    expect(deps.launch).not.toHaveBeenCalled()
  })
})
