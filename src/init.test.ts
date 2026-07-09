import { describe, expect, it, vi } from 'vitest'
import { runInit, type InitDeps } from './init.js'
import type { Project } from './api.js'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    name: 'My App',
    slug: 'my-app',
    website_url: null,
    created_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    api: { listProjects: vi.fn().mockResolvedValue([project()]) },
    exists: vi.fn().mockReturnValue(false),
    write: vi.fn(),
    select: vi.fn().mockResolvedValue('my-app  (My App)'),
    isTTY: true,
    cwd: () => '/repo',
    ...overrides,
  }
}

describe('runInit', () => {
  it('refuses to overwrite an existing config without --force', async () => {
    const deps = makeDeps({ exists: vi.fn().mockReturnValue(true) })
    const res = await runInit({}, deps)

    expect(res.kind).toBe('exists')
    expect(deps.write).not.toHaveBeenCalled()
  })

  it('overwrites with --force', async () => {
    const deps = makeDeps({ exists: vi.fn().mockReturnValue(true) })
    const res = await runInit({ force: true }, deps)

    expect(res.kind).toBe('written')
    expect(deps.write).toHaveBeenCalled()
  })

  it('auto-picks the only project without prompting', async () => {
    const deps = makeDeps()
    const res = await runInit({}, deps)

    expect(deps.select).not.toHaveBeenCalled()
    expect(res).toMatchObject({ kind: 'written', project: 'my-app' })
    expect(deps.write).toHaveBeenCalledWith('/repo/.deploylog.yml', 'project: my-app\n')
  })

  it('writes default_type with the readProjectConfig key name', async () => {
    const deps = makeDeps()
    await runInit({ type: 'fix' }, deps)

    expect(deps.write).toHaveBeenCalledWith(
      '/repo/.deploylog.yml',
      'project: my-app\ndefault_type: fix\n',
    )
  })

  it('rejects an unknown default type before any write', async () => {
    const deps = makeDeps()
    const res = await runInit({ type: 'hotfix' }, deps)

    expect(res.kind).toBe('missing-fields')
    expect(deps.write).not.toHaveBeenCalled()
  })

  it('rejects a --project slug that is not in the organization', async () => {
    const deps = makeDeps()
    const res = await runInit({ project: 'other-app' }, deps)

    expect(res.kind).toBe('missing-fields')
    if (res.kind === 'missing-fields') expect(res.message).toContain('my-app')
  })

  it('prompts a pick when multiple projects exist on a TTY', async () => {
    const deps = makeDeps({
      api: {
        listProjects: vi
          .fn()
          .mockResolvedValue([project(), project({ id: 'p-2', slug: 'other', name: 'Other' })]),
      },
    })
    const res = await runInit({}, deps)

    expect(deps.select).toHaveBeenCalled()
    expect(res).toMatchObject({ kind: 'written', project: 'my-app' })
  })

  it('refuses interactive pick on a non-interactive shell', async () => {
    const deps = makeDeps({
      isTTY: false,
      api: {
        listProjects: vi
          .fn()
          .mockResolvedValue([project(), project({ id: 'p-2', slug: 'other', name: 'Other' })]),
      },
    })
    const res = await runInit({}, deps)

    expect(res.kind).toBe('missing-fields')
    expect(deps.select).not.toHaveBeenCalled()
  })

  it('cancels cleanly when the pick is abandoned', async () => {
    const deps = makeDeps({
      select: vi.fn().mockResolvedValue(null),
      api: {
        listProjects: vi
          .fn()
          .mockResolvedValue([project(), project({ id: 'p-2', slug: 'other', name: 'Other' })]),
      },
    })
    const res = await runInit({}, deps)

    expect(res.kind).toBe('cancelled')
    expect(deps.write).not.toHaveBeenCalled()
  })

  it('points at projects create when the org has no projects', async () => {
    const deps = makeDeps({ api: { listProjects: vi.fn().mockResolvedValue([]) } })
    const res = await runInit({}, deps)

    expect(res.kind).toBe('missing-fields')
    if (res.kind === 'missing-fields') expect(res.message).toContain('projects create')
  })
})
