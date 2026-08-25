import { describe, it, expect } from 'vitest'
import {
  isGitRepo,
  getLastTag,
  getHeadVersion,
  getCommitsSince,
  defaultTitleFromGit,
  formatCommitsAsMarkdown,
  originSlug,
  headSha,
  changedPathsSince,
  type GitRunner,
} from './git.js'

/**
 * Build a GitRunner that replies based on the joined argv string.
 * Anything not matched returns null (simulating a git failure / no output).
 */
function stubRunner(replies: Record<string, string | null>): GitRunner {
  return (args: string[]) => {
    const key = args.join(' ')
    return key in replies ? replies[key]! : null
  }
}

describe('isGitRepo()', () => {
  it('true when rev-parse returns "true"', () => {
    const run = stubRunner({ 'rev-parse --is-inside-work-tree': 'true' })
    expect(isGitRepo(run)).toBe(true)
  })
  it('false when rev-parse fails', () => {
    const run = stubRunner({})
    expect(isGitRepo(run)).toBe(false)
  })
})

describe('getLastTag()', () => {
  it('returns the tag when describe succeeds', () => {
    const run = stubRunner({ 'describe --tags --abbrev=0': 'v1.2.3' })
    expect(getLastTag(run)).toBe('v1.2.3')
  })
  it('returns null when describe fails (no tags in repo)', () => {
    expect(getLastTag(stubRunner({}))).toBeNull()
  })
  it('returns null on empty output', () => {
    const run = stubRunner({ 'describe --tags --abbrev=0': '' })
    expect(getLastTag(run)).toBeNull()
  })
})

describe('getHeadVersion()', () => {
  it('extracts bare semver from "v1.2.3" tag on HEAD', () => {
    const run = stubRunner({ 'tag --points-at HEAD': 'v1.2.3' })
    expect(getHeadVersion(run)).toBe('1.2.3')
  })
  it('accepts un-prefixed "1.2.3"', () => {
    const run = stubRunner({ 'tag --points-at HEAD': '1.2.3' })
    expect(getHeadVersion(run)).toBe('1.2.3')
  })
  it('ignores non-semver tags', () => {
    const run = stubRunner({ 'tag --points-at HEAD': 'hotfix-abc' })
    expect(getHeadVersion(run)).toBeNull()
  })
  it('picks the first semver tag when multiple tags point at HEAD', () => {
    const run = stubRunner({ 'tag --points-at HEAD': 'release\nv2.0.0\nlatest' })
    expect(getHeadVersion(run)).toBe('2.0.0')
  })
  it('returns null when no tags point at HEAD', () => {
    expect(getHeadVersion(stubRunner({}))).toBeNull()
  })
})

describe('getCommitsSince()', () => {
  it('parses tab-delimited "hash\\tsubject" lines', () => {
    const run = stubRunner({
      'log v1.0.0..HEAD --pretty=format:%h\t%s --no-merges -200 --reverse':
        'abc1234\tfeat: add thing\ndef5678\tfix: that bug',
    })
    const commits = getCommitsSince('v1.0.0', 200, run)
    expect(commits).toEqual([
      { hash: 'abc1234', subject: 'feat: add thing' },
      { hash: 'def5678', subject: 'fix: that bug' },
    ])
  })

  it('uses HEAD as range when ref is null', () => {
    const run = stubRunner({
      'log HEAD --pretty=format:%h\t%s --no-merges -50 --reverse': 'aaa1111\tinitial commit',
    })
    expect(getCommitsSince(null, 50, run)).toEqual([
      { hash: 'aaa1111', subject: 'initial commit' },
    ])
  })

  it('returns empty array when git fails (unknown ref)', () => {
    expect(getCommitsSince('v99.0.0', 200, stubRunner({}))).toEqual([])
  })

  it('returns empty array on empty git output', () => {
    const run = stubRunner({
      'log v1.0.0..HEAD --pretty=format:%h\t%s --no-merges -200 --reverse': '',
    })
    expect(getCommitsSince('v1.0.0', 200, run)).toEqual([])
  })

  it('skips lines with no subject', () => {
    const run = stubRunner({
      'log HEAD --pretty=format:%h\t%s --no-merges -200 --reverse':
        'abc1234\tvalid subject\ndef5678\t   \nghi9012\tanother',
    })
    const commits = getCommitsSince(null, 200, run)
    expect(commits.map((c) => c.hash)).toEqual(['abc1234', 'ghi9012'])
  })

  it('trims whitespace in subjects', () => {
    const run = stubRunner({
      'log HEAD --pretty=format:%h\t%s --no-merges -200 --reverse': 'abc1234\t  spaced subject  ',
    })
    expect(getCommitsSince(null, 200, run)[0]?.subject).toBe('spaced subject')
  })
})

describe('defaultTitleFromGit()', () => {
  it('prefers explicit version', () => {
    expect(defaultTitleFromGit('1.2.3', 'v1.0.0')).toBe('Release v1.2.3')
  })
  it('falls back to last-tag delta when no version', () => {
    expect(defaultTitleFromGit(null, 'v1.0.0')).toBe('Changes since v1.0.0')
  })
  it('final fallback when no version and no tags', () => {
    expect(defaultTitleFromGit(null, null)).toBe('Recent changes')
  })
})

describe('formatCommitsAsMarkdown()', () => {
  it('returns placeholder when no commits', () => {
    expect(formatCommitsAsMarkdown([])).toContain('_No new commits')
  })
  it('formats commits as markdown bullets', () => {
    const md = formatCommitsAsMarkdown([
      { hash: 'a', subject: 'feat: x' },
      { hash: 'b', subject: 'fix: y' },
    ])
    expect(md).toBe('- feat: x\n- fix: y')
  })
})

describe('originSlug()', () => {
  const cases: Array<[string, string]> = [
    ['https://github.com/marko-builds/deploylog.git', 'marko-builds/deploylog'],
    ['https://github.com/marko-builds/deploylog', 'marko-builds/deploylog'],
    ['https://github.com/marko-builds/deploylog/', 'marko-builds/deploylog'],
    ['https://user@github.com/marko-builds/deploylog.git', 'marko-builds/deploylog'],
    ['git@github.com:marko-builds/deploylog.git', 'marko-builds/deploylog'],
    ['git@github.com:marko-builds/deploylog', 'marko-builds/deploylog'],
    ['ssh://git@github.com/marko-builds/deploylog.git', 'marko-builds/deploylog'],
    ['ssh://git@github.com:22/marko-builds/deploylog.git', 'marko-builds/deploylog'],
    ['git://github.com/marko-builds/deploylog.git', 'marko-builds/deploylog'],
    ['https://github.com/my.org/repo.name.git', 'my.org/repo.name'],
  ]
  for (const [url, slug] of cases) {
    it(`parses ${url}`, () => {
      const run = stubRunner({ 'remote get-url origin': url })
      expect(originSlug(run)).toEqual({ kind: 'slug', slug })
    })
  }

  it('no-remote when get-url fails', () => {
    expect(originSlug(stubRunner({}))).toEqual({ kind: 'no-remote' })
  })

  it('no-remote on empty output', () => {
    expect(originSlug(stubRunner({ 'remote get-url origin': '' }))).toEqual({ kind: 'no-remote' })
  })

  it('not-github for a GitLab remote, carrying the url', () => {
    const url = 'git@gitlab.com:someone/repo.git'
    expect(originSlug(stubRunner({ 'remote get-url origin': url }))).toEqual({
      kind: 'not-github',
      url,
    })
  })

  it('not-github for a github.com url with no repo segment', () => {
    const url = 'https://github.com/marko-builds'
    expect(originSlug(stubRunner({ 'remote get-url origin': url }))).toEqual({
      kind: 'not-github',
      url,
    })
  })

  it('not-github for a lookalike host', () => {
    const url = 'https://github.com.evil.example/marko-builds/deploylog.git'
    expect(originSlug(stubRunner({ 'remote get-url origin': url })).kind).toBe('not-github')
  })
})

describe('headSha()', () => {
  it('returns the sha rev-parse prints', () => {
    const sha = 'a'.repeat(40)
    expect(headSha(stubRunner({ 'rev-parse HEAD': sha }))).toBe(sha)
  })
  it('null when rev-parse fails (empty repository)', () => {
    expect(headSha(stubRunner({}))).toBeNull()
  })
  it('null on empty output', () => {
    expect(headSha(stubRunner({ 'rev-parse HEAD': '' }))).toBeNull()
  })
})

describe('changedPathsSince()', () => {
  const KEY = '-c core.quotePath=false diff --name-only --no-renames main...HEAD'

  it('runs the three-dot diff with quotePath off and renames off', () => {
    const run = stubRunner({ [KEY]: 'a.ts\nb/c.ts' })
    expect(changedPathsSince('main', run)).toEqual(['a.ts', 'b/c.ts'])
  })

  it('returns [] for an empty diff (the caller must not send it)', () => {
    expect(changedPathsSince('main', stubRunner({ [KEY]: '' }))).toEqual([])
  })

  it('returns null when git fails (unknown base)', () => {
    expect(changedPathsSince('main', stubRunner({}))).toBeNull()
  })

  it('keeps a non-ASCII path whole', () => {
    expect(changedPathsSince('main', stubRunner({ [KEY]: 'docs/naïve.md' }))).toEqual([
      'docs/naïve.md',
    ])
  })
})
