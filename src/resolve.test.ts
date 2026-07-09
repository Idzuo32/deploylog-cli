import { describe, expect, it, vi } from 'vitest'
import { resolveEntryRef } from './resolve.js'
import type { Entry } from './api.js'

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

describe('resolveEntryRef', () => {
  it('passes a uuid-shaped ref straight through without listing', async () => {
    const listEntries = vi.fn()
    const res = await resolveEntryRef(UUID, 'my-app', listEntries)

    expect(res).toEqual({ kind: 'resolved', id: UUID })
    expect(listEntries).not.toHaveBeenCalled()
  })

  it('resolves a slug via the project entry list', async () => {
    const listEntries = vi.fn().mockResolvedValue([entry(), entry({ id: 'id-2', slug: 'other' })])
    const res = await resolveEntryRef('ship-it', 'my-app', listEntries)

    expect(res).toMatchObject({ kind: 'resolved', id: 'id-1' })
    expect(listEntries).toHaveBeenCalledWith('my-app')
  })

  it('refuses with a helpful message when the slug is not in the recent window', async () => {
    const listEntries = vi.fn().mockResolvedValue([entry()])
    const res = await resolveEntryRef('missing-slug', 'my-app', listEntries)

    expect(res.kind).toBe('not-found')
    if (res.kind === 'not-found') {
      expect(res.message).toContain("'missing-slug'")
      expect(res.message).toContain('by id')
    }
  })

  it('does not treat a non-canonical uuid-ish string as an id', async () => {
    const listEntries = vi.fn().mockResolvedValue([entry({ slug: 'abc' })])
    const res = await resolveEntryRef('not-a-uuid-1234', 'my-app', listEntries)

    expect(res.kind).toBe('not-found')
    expect(listEntries).toHaveBeenCalled()
  })
})
