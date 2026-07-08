import { describe, it, expect, vi } from 'vitest'
import { runPush, type PushDeps, type PushOptions } from './push.js'
import type { Entry } from './api.js'

const FAKE_ENTRY: Entry = {
  id: 'e1',
  title: 'from-server',
  slug: 'from-server',
  entry_type: null,
  version: null,
  published: false,
  published_at: null,
  created_at: '2026-07-08T00:00:00Z',
}

const FAKE_SUMMARY = {
  summary: {
    title: 'AI Title',
    entry_type: 'feature' as const,
    body_markdown: 'AI body',
  },
  model: 'claude-haiku',
  usage: { used: 1, limit: 100, month_key: '2026-07' },
}

/** A fully-stubbed PushDeps; override per-test. Defaults = benign happy path. */
function makeDeps(over: Partial<PushDeps> = {}): PushDeps {
  return {
    git: {
      isGitRepo: () => true,
      getLastTag: () => null,
      getHeadVersion: () => null,
      getCommitsSince: () => [],
      defaultTitleFromGit: () => 'Recent changes',
      formatCommitsAsMarkdown: () => '_No new commits since last tag._',
      ...(over.git ?? {}),
    },
    api: {
      createEntry: vi.fn().mockResolvedValue(FAKE_ENTRY),
      summarize: vi.fn().mockResolvedValue(FAKE_SUMMARY),
      ...(over.api ?? {}),
    },
    readProjectConfig: over.readProjectConfig ?? (() => ({ project: 'proj' })),
    confirm: over.confirm ?? vi.fn().mockResolvedValue(true),
    isTTY: over.isTTY ?? false,
    out: over.out ?? {
      progressStart: vi.fn(),
      progressDone: vi.fn(),
      notice: vi.fn(),
      aiPreview: vi.fn(),
    },
  }
}

/** Last argument passed to createEntry (the CreateEntryInput). */
function createEntryArg(deps: PushDeps) {
  return (deps.api.createEntry as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
}

describe('runPush — happy path + precedence', () => {
  it('creates an entry from explicit --title/--body', async () => {
    const deps = makeDeps()
    const res = await runPush({ title: 'T', body: 'B' }, deps)
    expect(res).toEqual({ kind: 'created', entry: FAKE_ENTRY })
    expect(createEntryArg(deps)).toMatchObject({ title: 'T', body_markdown: 'B' })
  })

  it('explicit --title/--type/--version win over git-derived values', async () => {
    const deps = makeDeps({
      git: {
        isGitRepo: () => true,
        getLastTag: () => 'v1.0.0',
        getHeadVersion: () => '2.0.0',
        getCommitsSince: () => [{ hash: 'a', subject: 'feat: x' }],
        defaultTitleFromGit: () => 'Release v2.0.0',
        formatCommitsAsMarkdown: () => '- feat: x',
      },
    })
    const opts: PushOptions = {
      fromGit: true,
      title: 'Explicit',
      type: 'fix',
      version: '9.9.9',
    }
    await runPush(opts, deps)
    expect(createEntryArg(deps)).toMatchObject({
      title: 'Explicit',
      entry_type: 'fix',
      version: '9.9.9',
    })
  })

  it('falls back to projectConfig.default_type when --type is absent', async () => {
    const deps = makeDeps({ readProjectConfig: () => ({ project: 'proj', default_type: 'improvement' }) })
    await runPush({ title: 'T', body: 'B' }, deps)
    expect(createEntryArg(deps)).toMatchObject({ entry_type: 'improvement' })
  })

  it('derives title/body from git when not given explicitly', async () => {
    const deps = makeDeps({
      git: {
        isGitRepo: () => true,
        getLastTag: () => 'v1.0.0',
        getHeadVersion: () => null,
        getCommitsSince: () => [{ hash: 'a', subject: 'feat: x' }],
        defaultTitleFromGit: () => 'Changes since v1.0.0',
        formatCommitsAsMarkdown: () => '- feat: x',
      },
    })
    await runPush({ fromGit: true }, deps)
    expect(createEntryArg(deps)).toMatchObject({
      title: 'Changes since v1.0.0',
      body_markdown: '- feat: x',
    })
  })
})

describe('runPush — alias reconciliation', () => {
  it('--git behaves like --from-git', async () => {
    const isGitRepo = vi.fn().mockReturnValue(false)
    const deps = makeDeps({ git: { ...makeDeps().git, isGitRepo } })
    const res = await runPush({ git: true }, deps)
    expect(isGitRepo).toHaveBeenCalled()
    expect(res.kind).toBe('no-commits') // not-in-repo refusal via the git path
  })

  it('--ai behaves like --ai-summarize', async () => {
    const deps = makeDeps()
    // No source (no from-git, no body) → the ai-source guard fires, proving --ai
    // was reconciled into aiSummarize.
    const res = await runPush({ ai: true }, deps)
    expect(res.kind).toBe('no-ai-source')
  })
})

describe('runPush — refusals', () => {
  it('from-git with no commits (and no body/ai) → no-commits', async () => {
    const deps = makeDeps({
      git: { ...makeDeps().git, getLastTag: () => 'v1.0.0', getCommitsSince: () => [] },
    })
    const res = await runPush({ fromGit: true }, deps)
    expect(res).toMatchObject({ kind: 'no-commits' })
    if (res.kind === 'no-commits') expect(res.message).toContain('v1.0.0')
  })

  it('not in a git repo with --from-git → no-commits', async () => {
    const deps = makeDeps({ git: { ...makeDeps().git, isGitRepo: () => false } })
    const res = await runPush({ fromGit: true }, deps)
    expect(res).toMatchObject({ kind: 'no-commits' })
    if (res.kind === 'no-commits') expect(res.message).toContain('git repository')
  })

  it('--ai-summarize without source material → no-ai-source', async () => {
    const deps = makeDeps()
    const res = await runPush({ aiSummarize: true }, deps)
    expect(res.kind).toBe('no-ai-source')
    expect(deps.api.summarize).not.toHaveBeenCalled()
  })

  it('no title and no body (no derivation) → missing-fields', async () => {
    const deps = makeDeps()
    const res = await runPush({}, deps)
    expect(res.kind).toBe('missing-fields')
    expect(deps.api.createEntry).not.toHaveBeenCalled()
  })

  it('no project (flag or config) → missing-fields', async () => {
    const deps = makeDeps({ readProjectConfig: () => null })
    const res = await runPush({ title: 'T', body: 'B' }, deps)
    expect(res).toMatchObject({ kind: 'missing-fields' })
    if (res.kind === 'missing-fields') expect(res.message).toContain('No project')
  })
})

describe('runPush — publish/draft', () => {
  it('--publish alone publishes', async () => {
    const deps = makeDeps()
    await runPush({ title: 'T', body: 'B', publish: true }, deps)
    expect(createEntryArg(deps)).toMatchObject({ publish: true })
  })

  it('--publish + --draft conflict → saved as draft, with a notice', async () => {
    const deps = makeDeps()
    await runPush({ title: 'T', body: 'B', publish: true, draft: true }, deps)
    expect(createEntryArg(deps)).toMatchObject({ publish: false })
    expect(deps.out.notice).toHaveBeenCalled()
  })
})

describe('runPush — AI --yes/TTY matrix (BUG-019)', () => {
  const aiOpts: PushOptions = { aiSummarize: true, body: 'raw notes' }

  it('TTY + no --yes + confirm=yes → created', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const deps = makeDeps({ isTTY: true, confirm })
    const res = await runPush(aiOpts, deps)
    expect(confirm).toHaveBeenCalledOnce()
    expect(res.kind).toBe('created')
  })

  it('TTY + no --yes + confirm=no → cancelled, nothing created', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const deps = makeDeps({ isTTY: true, confirm })
    const res = await runPush(aiOpts, deps)
    expect(res.kind).toBe('cancelled')
    expect(deps.api.createEntry).not.toHaveBeenCalled()
  })

  it('non-TTY + no --yes → proceeds with a notice, no confirm prompt', async () => {
    const confirm = vi.fn()
    const deps = makeDeps({ isTTY: false, confirm })
    const res = await runPush(aiOpts, deps)
    expect(confirm).not.toHaveBeenCalled()
    expect(deps.out.notice).toHaveBeenCalled()
    expect(res.kind).toBe('created')
  })

  it('--yes skips confirmation even on a TTY', async () => {
    const confirm = vi.fn()
    const deps = makeDeps({ isTTY: true, confirm })
    const res = await runPush({ ...aiOpts, yes: true }, deps)
    expect(confirm).not.toHaveBeenCalled()
    expect(res.kind).toBe('created')
  })
})

describe('runPush — AI title-override rule', () => {
  it('AI overrides body but NOT an explicit --title', async () => {
    const deps = makeDeps()
    await runPush({ aiSummarize: true, body: 'raw notes', title: 'Mine' }, deps)
    expect(createEntryArg(deps)).toMatchObject({ title: 'Mine', body_markdown: 'AI body' })
  })

  it('AI supplies the title when none is given', async () => {
    const deps = makeDeps()
    await runPush({ aiSummarize: true, body: 'raw notes' }, deps)
    expect(createEntryArg(deps)).toMatchObject({ title: 'AI Title', body_markdown: 'AI body' })
  })

  it('git gathering precedes the AI-source check (commits satisfy source)', async () => {
    const deps = makeDeps({
      git: {
        ...makeDeps().git,
        isGitRepo: () => true,
        getCommitsSince: () => [{ hash: 'a', subject: 'feat: x' }],
      },
    })
    const res = await runPush({ fromGit: true, aiSummarize: true }, deps)
    expect(deps.api.summarize).toHaveBeenCalled()
    expect(res.kind).toBe('created')
  })
})
