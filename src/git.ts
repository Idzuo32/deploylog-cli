import { execFileSync } from 'node:child_process'

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

/**
 * Thin shell-out wrapper. Exported for test injection.
 * Returns stdout with trailing newline trimmed, or null on non-zero exit.
 */
export function runGit(args: string[], cwd: string = process.cwd()): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\n$/, '')
  } catch {
    return null
  }
}

export interface GitRunner {
  (args: string[]): string | null
}

export function isGitRepo(run: GitRunner = runGit): boolean {
  return run(['rev-parse', '--is-inside-work-tree']) === 'true'
}

/**
 * Most recent annotated or lightweight tag reachable from HEAD, or null.
 */
export function getLastTag(run: GitRunner = runGit): string | null {
  const out = run(['describe', '--tags', '--abbrev=0'])
  return out && out.length > 0 ? out : null
}

/**
 * If HEAD is on a tag that looks like semver (v1.2.3 or 1.2.3), return the
 * bare semver string (without the 'v'). Otherwise null.
 */
export function getHeadVersion(run: GitRunner = runGit): string | null {
  const exact = run(['tag', '--points-at', 'HEAD'])
  if (!exact) return null
  for (const line of exact.split('\n')) {
    const m = line.match(/^v?(\d+\.\d+\.\d+)$/)
    if (m?.[1]) return m[1]
  }
  return null
}

export interface CommitSummary {
  hash: string
  subject: string
}

/**
 * Commit subjects (and short hashes) between `ref` and HEAD, oldest-first.
 * If `ref` is null, returns the most recent `limit` commits on HEAD.
 */
export function getCommitsSince(
  ref: string | null,
  limit = 200,
  run: GitRunner = runGit,
): CommitSummary[] {
  const range = ref ? `${ref}..HEAD` : 'HEAD'
  const args = ['log', range, `--pretty=format:%h\t%s`, '--no-merges', `-${limit}`, '--reverse']
  const out = run(args)
  if (out === null) {
    // `ref..HEAD` with an unknown ref (or an empty repo) returns null via our wrapper.
    return []
  }
  if (out.length === 0) return []

  const commits: CommitSummary[] = []
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const hash = line.slice(0, tab)
    const subject = line.slice(tab + 1).trim()
    if (subject.length > 0) commits.push({ hash, subject })
  }
  return commits
}

/**
 * Derive a sensible default title from the latest tag (or fallback).
 */
export function defaultTitleFromGit(version: string | null, lastTag: string | null): string {
  if (version) return `Release v${version}`
  if (lastTag) return `Changes since ${lastTag}`
  return 'Recent changes'
}

/**
 * Format a commit list as a markdown bullet body.
 */
export function formatCommitsAsMarkdown(commits: CommitSummary[]): string {
  if (commits.length === 0) return '_No new commits since last tag._'
  return commits.map((c) => `- ${c.subject}`).join('\n')
}

// ─── manual verify derivations ──────────────────────────────────────────────
// Each helper answers one question the verify body needs and reports failure by
// kind, never by throwing: the command turns each kind into a named error that
// says which flag to pass instead.

const GITHUB_REMOTE =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i

export type OriginSlug =
  | { kind: 'slug'; slug: string }
  | { kind: 'no-remote' }
  | { kind: 'not-github'; url: string }

/**
 * `owner/repo` parsed out of `git remote get-url origin`, in its HTTPS and SSH
 * spellings. A remote that is not github.com is reported with its url so the
 * caller can say what it saw.
 */
export function originSlug(run: GitRunner = runGit): OriginSlug {
  const url = run(['remote', 'get-url', 'origin'])
  if (url === null || url.trim().length === 0) return { kind: 'no-remote' }
  const m = url.trim().match(GITHUB_REMOTE)
  if (!m?.[1] || !m[2]) return { kind: 'not-github', url: url.trim() }
  return { kind: 'slug', slug: `${m[1]}/${m[2]}` }
}

/** The full sha at HEAD, or null when there is no HEAD (an empty repository). */
export function headSha(run: GitRunner = runGit): string | null {
  const out = run(['rev-parse', 'HEAD'])
  return out && out.length > 0 ? out : null
}

/**
 * Paths changed between the merge base of `base` and HEAD, or null when git
 * could not compute the diff (an unknown base, or one sharing no history).
 *
 * `core.quotePath=false` so a non-ASCII path is not octal-escaped into a string
 * that matches no anchor; `--no-renames` so a claim citing the OLD path of a
 * renamed file still lands in scope, the way the Action keeps
 * `previous_filename`. An empty diff is `[]`, which the caller must not send.
 */
export function changedPathsSince(base: string, run: GitRunner = runGit): string[] | null {
  const out = run([
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-only',
    '--no-renames',
    `${base}...HEAD`,
  ])
  if (out === null) return null
  return out.split('\n').filter((line) => line.length > 0)
}
