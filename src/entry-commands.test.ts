import { describe, expect, it, vi } from 'vitest'
import { runSetPublished, type EntryCommandDeps } from './entry-commands.js'
import type { Entry, PublishStateEntry } from './api.js'

const UUID = '3f2b8a1c-9d4e-4f6a-b2c3-1a2b3c4d5e6f'

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'id-1',
    title: 'Ship it',
    slug: 'ship-it',
    entry_type: null,
    version: null,
    published: false,
    published_at: null,
    created_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

function published(overrides: Partial<PublishStateEntry> = {}): PublishStateEntry {
  return {
    id: 'id-1',
    title: 'Ship it',
    slug: 'ship-it',
    published: true,
    published_at: '2026-07-09T00:00:00.000Z',
    changed: true,
    ...overrides,
  }
}

function makeDeps(overrides: Partial<EntryCommandDeps> = {}): EntryCommandDeps {
  return {
    api: {
      listEntries: vi.fn().mockResolvedValue([entry()]),
      setEntryPublished: vi.fn().mockResolvedValue(published()),
    },
    readProjectConfig: () => null,
    ...overrides,
  }
}

describe('runSetPublished', () => {
  it('refuses without a project (flag or .deploylog.yml)', async () => {
    const res = await runSetPublished({ ref: 'ship-it', publish: true }, makeDeps())
    expect(res.kind).toBe('missing-fields')
  })

  it('uses the project from .deploylog.yml when no flag is passed', async () => {
    const deps = makeDeps({ readProjectConfig: () => ({ project: 'yml-app' }) })
    const res = await runSetPublished({ ref: 'ship-it', publish: true }, deps)

    expect(res.kind).toBe('updated')
    expect(deps.api.listEntries).toHaveBeenCalledWith('yml-app')
  })

  it('the --project flag wins over .deploylog.yml', async () => {
    const deps = makeDeps({ readProjectConfig: () => ({ project: 'yml-app' }) })
    await runSetPublished({ ref: 'ship-it', project: 'flag-app', publish: true }, deps)

    expect(deps.api.listEntries).toHaveBeenCalledWith('flag-app')
  })

  it('resolves a slug to its id before calling the publish API', async () => {
    const deps = makeDeps()
    const res = await runSetPublished({ ref: 'ship-it', project: 'my-app', publish: true }, deps)

    expect(res.kind).toBe('updated')
    expect(deps.api.setEntryPublished).toHaveBeenCalledWith('id-1', true)
  })

  it('sends a uuid ref directly without listing', async () => {
    const deps = makeDeps()
    await runSetPublished({ ref: UUID, project: 'my-app', publish: false }, deps)

    expect(deps.api.listEntries).not.toHaveBeenCalled()
    expect(deps.api.setEntryPublished).toHaveBeenCalledWith(UUID, false)
  })

  it('returns not-found when the slug is outside the recent window', async () => {
    const deps = makeDeps()
    const res = await runSetPublished({ ref: 'nope', project: 'my-app', publish: true }, deps)

    expect(res.kind).toBe('not-found')
    expect(deps.api.setEntryPublished).not.toHaveBeenCalled()
  })

  it('surfaces the changed flag for idempotent re-publish', async () => {
    const deps = makeDeps()
    deps.api.setEntryPublished = vi.fn().mockResolvedValue(published({ changed: false }))
    const res = await runSetPublished({ ref: 'ship-it', project: 'my-app', publish: true }, deps)

    expect(res).toMatchObject({ kind: 'updated', entry: { changed: false } })
  })
})
