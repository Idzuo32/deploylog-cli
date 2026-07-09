import { describe, expect, it, vi } from 'vitest'
import {
  runSetPublished,
  runView,
  runEdit,
  runDelete,
  type EntryCommandDeps,
} from './entry-commands.js'
import { ApiError, type Entry, type EntryDetail, type PublishStateEntry } from './api.js'

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

function detail(overrides: Partial<EntryDetail> = {}): EntryDetail {
  return { ...entry(), body_markdown: '# Body', updated_at: null, ...overrides }
}

function makeDeps(overrides: Partial<EntryCommandDeps> = {}): EntryCommandDeps {
  return {
    api: {
      listEntries: vi.fn().mockResolvedValue([entry()]),
      getEntry: vi.fn().mockResolvedValue(detail()),
      updateEntry: vi.fn().mockResolvedValue(detail({ title: 'Updated' })),
      deleteEntry: vi.fn().mockResolvedValue({ id: 'id-1' }),
      setEntryPublished: vi.fn().mockResolvedValue(published()),
    },
    readProjectConfig: () => null,
    editor: vi.fn().mockReturnValue({ kind: 'edited', body: '# Edited' }),
    saveRecovery: vi.fn().mockReturnValue('/tmp/recovery.md'),
    readFile: vi.fn().mockReturnValue('# From file'),
    confirm: vi.fn().mockResolvedValue(true),
    isTTY: true,
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

describe('runView', () => {
  it('refuses without a project', async () => {
    const res = await runView({ ref: 'ship-it' }, makeDeps())
    expect(res.kind).toBe('missing-fields')
  })

  it('resolves a slug and fetches the full entry', async () => {
    const deps = makeDeps()
    const res = await runView({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(res).toMatchObject({ kind: 'found', entry: { body_markdown: '# Body' } })
    expect(deps.api.getEntry).toHaveBeenCalledWith('id-1')
  })

  it('fetches a uuid ref directly without listing', async () => {
    const deps = makeDeps()
    await runView({ ref: UUID, project: 'my-app' }, deps)

    expect(deps.api.listEntries).not.toHaveBeenCalled()
    expect(deps.api.getEntry).toHaveBeenCalledWith(UUID)
  })

  it('returns not-found for an unknown slug', async () => {
    const deps = makeDeps()
    const res = await runView({ ref: 'nope', project: 'my-app' }, deps)

    expect(res.kind).toBe('not-found')
    expect(deps.api.getEntry).not.toHaveBeenCalled()
  })
})

describe('runEdit', () => {
  it('sends only the provided flag fields', async () => {
    const deps = makeDeps()
    const res = await runEdit({ ref: 'ship-it', project: 'my-app', title: 'New title' }, deps)

    expect(res.kind).toBe('updated')
    expect(deps.api.updateEntry).toHaveBeenCalledWith('id-1', { title: 'New title' })
    expect(deps.editor).not.toHaveBeenCalled()
  })

  it('reads the body from --body-file', async () => {
    const deps = makeDeps()
    await runEdit({ ref: 'ship-it', project: 'my-app', bodyFile: 'notes.md' }, deps)

    expect(deps.readFile).toHaveBeenCalledWith('notes.md')
    expect(deps.api.updateEntry).toHaveBeenCalledWith('id-1', { body_markdown: '# From file' })
  })

  it('refuses cleanly on an unreadable --body-file', async () => {
    const deps = makeDeps({
      readFile: vi.fn(() => {
        throw new Error('ENOENT')
      }),
    })
    const res = await runEdit({ ref: 'ship-it', project: 'my-app', bodyFile: 'gone.md' }, deps)

    expect(res.kind).toBe('missing-fields')
    expect(deps.api.updateEntry).not.toHaveBeenCalled()
  })

  it('opens $EDITOR prefilled with the current body when no flags are given (TTY)', async () => {
    const deps = makeDeps()
    const res = await runEdit({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(deps.editor).toHaveBeenCalledWith('# Body')
    expect(deps.api.updateEntry).toHaveBeenCalledWith('id-1', { body_markdown: '# Edited' })
    expect(res.kind).toBe('updated')
  })

  it('refuses the editor flow on a non-interactive shell', async () => {
    const deps = makeDeps({ isTTY: false })
    const res = await runEdit({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(res.kind).toBe('missing-fields')
    expect(deps.editor).not.toHaveBeenCalled()
  })

  it('treats an unchanged editor round-trip as a no-op', async () => {
    const deps = makeDeps({ editor: vi.fn().mockReturnValue({ kind: 'unchanged' }) })
    const res = await runEdit({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(res.kind).toBe('unchanged')
    expect(deps.api.updateEntry).not.toHaveBeenCalled()
  })

  it('treats a nonzero editor exit as cancelled', async () => {
    const deps = makeDeps({
      editor: vi.fn().mockReturnValue({ kind: 'aborted', message: 'Editor exited with status 1' }),
    })
    const res = await runEdit({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(res.kind).toBe('cancelled')
  })

  it('saves an editor-authored body to a recovery file when the server rejects it', async () => {
    const deps = makeDeps()
    deps.api.updateEntry = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Body too long'))
    const res = await runEdit({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(res.kind).toBe('body-rejected')
    expect(deps.saveRecovery).toHaveBeenCalledWith('# Edited')
    if (res.kind === 'body-rejected') {
      expect(res.message).toContain('/tmp/recovery.md')
    }
  })

  it('rethrows server rejections of flag-provided bodies (no recovery file needed)', async () => {
    const deps = makeDeps()
    deps.api.updateEntry = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Body too long'))

    await expect(
      runEdit({ ref: 'ship-it', project: 'my-app', body: 'x' }, deps),
    ).rejects.toBeInstanceOf(ApiError)
    expect(deps.saveRecovery).not.toHaveBeenCalled()
  })

  it('reports the previous slug so the adapter can flag a slug change', async () => {
    const deps = makeDeps()
    deps.api.updateEntry = vi.fn().mockResolvedValue(detail({ slug: 'new-slug' }))
    const res = await runEdit({ ref: 'ship-it', project: 'my-app', title: 'New' }, deps)

    expect(res).toMatchObject({ kind: 'updated', previousSlug: 'ship-it' })
  })
})

describe('runDelete', () => {
  it('confirms on a TTY with the entry named, then deletes', async () => {
    const deps = makeDeps()
    const res = await runDelete({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining('Ship it'))
    expect(deps.api.deleteEntry).toHaveBeenCalledWith('id-1')
    expect(res).toMatchObject({ kind: 'deleted', id: 'id-1', title: 'Ship it' })
  })

  it('cancels without deleting when the prompt is declined', async () => {
    const deps = makeDeps({ confirm: vi.fn().mockResolvedValue(false) })
    const res = await runDelete({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(res.kind).toBe('cancelled')
    expect(deps.api.deleteEntry).not.toHaveBeenCalled()
  })

  it('refuses on a non-interactive shell without --yes (stricter than push)', async () => {
    const deps = makeDeps({ isTTY: false })
    const res = await runDelete({ ref: 'ship-it', project: 'my-app' }, deps)

    expect(res.kind).toBe('confirm-required')
    expect(deps.api.deleteEntry).not.toHaveBeenCalled()
  })

  it('deletes without prompting when --yes is passed', async () => {
    const deps = makeDeps({ isTTY: false })
    const res = await runDelete({ ref: 'ship-it', project: 'my-app', yes: true }, deps)

    expect(deps.confirm).not.toHaveBeenCalled()
    expect(res.kind).toBe('deleted')
  })

  it('returns not-found before any prompt or delete call', async () => {
    const deps = makeDeps()
    const res = await runDelete({ ref: 'nope', project: 'my-app' }, deps)

    expect(res.kind).toBe('not-found')
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.api.deleteEntry).not.toHaveBeenCalled()
  })
})
