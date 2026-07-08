import chalk from 'chalk'
import {
  isGitRepo,
  getLastTag,
  getHeadVersion,
  getCommitsSince,
  defaultTitleFromGit,
  formatCommitsAsMarkdown,
  type CommitSummary,
} from './git.js'
import {
  createEntry,
  summarize,
  type Entry,
  type CreateEntryInput,
  type SummarizeInput,
  type SummarizeResponse,
  type AiSummary,
} from './api.js'
import { readProjectConfig, type ProjectConfig } from './project-config.js'

/** Raw commander options for `push`, aliases included (reconciled inside runPush). */
export interface PushOptions {
  title?: string
  body?: string
  project?: string
  type?: string
  version?: string
  publish?: boolean
  draft?: boolean
  fromGit?: boolean
  git?: boolean
  aiSummarize?: boolean
  ai?: boolean
  yes?: boolean
}

/**
 * Outcome of a push attempt. `created` carries the entry; every other kind is a
 * typed refusal that replaces a `process.exit(1)` — the adapter decides how to
 * print and what exit code to use.
 */
export type PushResult =
  | { kind: 'created'; entry: Entry }
  | { kind: 'no-commits'; message: string }
  | { kind: 'no-ai-source'; message: string }
  | { kind: 'missing-fields'; message: string }
  | { kind: 'cancelled'; message: string }

/** Presentational sink — the progress/preview/warning lines runPush emits mid-flow. */
export interface PushOutput {
  progressStart(msg: string): void
  progressDone(msg: string): void
  notice(msg: string): void
  aiPreview(summary: AiSummary, usage: SummarizeResponse['usage']): void
}

export interface PushDeps {
  git: {
    isGitRepo(): boolean
    getLastTag(): string | null
    getHeadVersion(): string | null
    getCommitsSince(ref: string | null): CommitSummary[]
    defaultTitleFromGit(version: string | null, lastTag: string | null): string
    formatCommitsAsMarkdown(commits: CommitSummary[]): string
  }
  api: {
    createEntry(slug: string, input: CreateEntryInput): Promise<Entry>
    summarize(input: SummarizeInput): Promise<SummarizeResponse>
  }
  readProjectConfig(): ProjectConfig | null
  confirm(question: string): Promise<boolean>
  isTTY: boolean
  out: PushOutput
}

/**
 * The push orchestration as a pure(ish) function: takes options + injected
 * boundaries, returns a typed result. No `process.exit`, no direct git/network
 * — every branch is reachable from a unit test.
 */
export async function runPush(
  opts: PushOptions,
  deps: PushDeps = defaultPushDeps,
): Promise<PushResult> {
  const { git, api, out } = deps

  // Reconcile each flag with its alias (-g/--git, -a/--ai).
  const fromGit = Boolean(opts.fromGit || opts.git)
  const aiSummarize = Boolean(opts.aiSummarize || opts.ai)

  // Resolve the project (flag > .deploylog.yml). Missing is a refusal, not an exit.
  const projectConfig = deps.readProjectConfig()
  const slug = opts.project ?? projectConfig?.project
  if (!slug) {
    return {
      kind: 'missing-fields',
      message:
        'No project specified. Use --project <slug> or create a .deploylog.yml with:\n  project: my-app',
    }
  }

  // Gather source material (commits + version) if --from-git. This precedes the
  // AI-source check so --ai-summarize can see the commits.
  let commits: CommitSummary[] = []
  let gitVersion: string | null = null
  let gitTitle: string | null = null
  let gitBody: string | null = null

  if (fromGit) {
    if (!git.isGitRepo()) {
      return {
        kind: 'no-commits',
        message: 'Not in a git repository. Remove --from-git or cd to a repo.',
      }
    }
    const lastTag = git.getLastTag()
    commits = git.getCommitsSince(lastTag)
    gitVersion = git.getHeadVersion()
    gitTitle = git.defaultTitleFromGit(gitVersion, lastTag)
    gitBody = git.formatCommitsAsMarkdown(commits)

    if (commits.length === 0 && !opts.body && !aiSummarize) {
      return {
        kind: 'no-commits',
        message: lastTag
          ? `No commits since tag ${lastTag}. Nothing to summarize.`
          : 'No commits found on HEAD.',
      }
    }
  }

  // Build the entry (with optional AI rewrite).
  let title = opts.title ?? gitTitle ?? ''
  let body = opts.body ?? gitBody ?? ''
  let entryType = opts.type ?? projectConfig?.default_type ?? null
  const version = opts.version ?? gitVersion ?? undefined

  if (aiSummarize) {
    const hasSource = commits.length > 0 || Boolean(opts.body && opts.body.trim().length > 0)
    if (!hasSource) {
      return {
        kind: 'no-ai-source',
        message:
          '--ai-summarize needs source material. Pass --from-git or provide --body as raw notes.',
      }
    }

    out.progressStart('Summarizing with Claude Haiku...')
    const res = await api.summarize({
      project_slug: slug,
      commits: commits.map((c) => c.subject),
      release_notes: opts.body,
      version,
    })
    out.progressDone('done')

    // AI result overrides the body but never an explicit --title.
    title = opts.title ?? res.summary.title
    body = res.summary.body_markdown
    entryType = opts.type ?? res.summary.entry_type
    out.aiPreview(res.summary, res.usage)

    if (!opts.yes && deps.isTTY) {
      const ok = await deps.confirm('Publish this entry?')
      if (!ok) {
        return { kind: 'cancelled', message: 'Cancelled. No entry was created.' }
      }
    } else if (!opts.yes) {
      // Non-interactive shell (CI, piped stdin): no prompt to show, so make the
      // unreviewed auto-proceed explicit. (BUG-019)
      out.notice(
        'Non-interactive shell: proceeding with the AI-generated entry without confirmation.',
      )
    }
  }

  if (!title || !body) {
    return {
      kind: 'missing-fields',
      message:
        'Entry requires --title and --body (or --from-git / --ai-summarize to derive them).',
    }
  }

  if (opts.publish && opts.draft) {
    out.notice('Both --publish and --draft passed; saving as a draft.')
  }

  const entry = await api.createEntry(slug, {
    title,
    body_markdown: body,
    entry_type: entryType,
    version,
    publish: Boolean(opts.publish && !opts.draft),
  })

  return { kind: 'created', entry }
}

// ─── real-module defaults ─────────────────────────────────────────────────────

function printAiPreview(summary: AiSummary, usage: SummarizeResponse['usage']): void {
  console.log()
  console.log(chalk.bold('AI-generated entry:'))
  console.log(`  ${chalk.dim('Title:')}  ${summary.title}`)
  console.log(`  ${chalk.dim('Type:')}   ${summary.entry_type}`)
  console.log(chalk.dim('  Body:'))
  for (const line of summary.body_markdown.split('\n')) {
    console.log(`    ${line}`)
  }
  const limitLabel = usage.limit === null ? '∞' : String(usage.limit)
  console.log(chalk.dim(`  Usage:  ${usage.used}/${limitLabel} this month (${usage.month_key})`))
  console.log()
}

async function confirmPrompt(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${question} [y/N] `, resolve)
  })
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

export const defaultPushDeps: PushDeps = {
  git: {
    isGitRepo: () => isGitRepo(),
    getLastTag: () => getLastTag(),
    getHeadVersion: () => getHeadVersion(),
    getCommitsSince: (ref) => getCommitsSince(ref),
    defaultTitleFromGit,
    formatCommitsAsMarkdown,
  },
  api: { createEntry, summarize },
  readProjectConfig: () => readProjectConfig(),
  confirm: confirmPrompt,
  isTTY: Boolean(process.stdin.isTTY),
  out: {
    progressStart: (msg) => process.stdout.write(chalk.dim(`${msg} `)),
    progressDone: (msg) => process.stdout.write(chalk.green(`${msg}\n`)),
    notice: (msg) => console.log(chalk.yellow(msg)),
    aiPreview: printAiPreview,
  },
}
