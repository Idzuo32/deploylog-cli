import { ApiError, verifyManual } from './api.js'
import { readProjectConfig, type ProjectConfig } from './project-config.js'
import { changedPathsSince, headSha, originSlug, runGit, type GitRunner } from './git.js'
import {
  ManualVerifyRequestSchema,
  ManualVerifyResponseSchema,
  type ManualVerifyRequest,
  type ManualVerifyResponse,
  type VerifyChapterResult,
} from './manual-verify-schema.js'

export const FAIL_ON_VALUES = ['none', 'drift', 'any'] as const

export type FailOn = (typeof FAIL_ON_VALUES)[number]

/**
 * `drift`, not the Action's `none`: the Action's first run must not break a
 * build nobody asked it to gate, but a terminal run is a person asking, and a
 * person asking gets the answer as an exit code.
 */
export const DEFAULT_FAIL_ON: FailOn = 'drift'

/** Exit 1 is drift found; exit 2 is "could not vouch" under `any`. Never the same code. */
export const EXIT_DRIFT = 1
export const EXIT_UNVERIFIABLE = 2

export function isFailOn(value: string): value is FailOn {
  return (FAIL_ON_VALUES as readonly string[]).includes(value)
}

export interface ManualVerifyOptions {
  project?: string
  /** `owner/repo`; derived from `git remote get-url origin` when unset. */
  repository?: string
  /** Full commit sha; `git rev-parse HEAD` when unset. */
  ref?: string
  /** Scope the check to files changed since this base; a full sweep when unset. */
  changedFrom?: string
  failOn?: FailOn
  /** Print the validated report and nothing else on stdout. */
  json?: boolean
}

export interface Verdict {
  /** Claims whose cited value moved. The only drift signal. */
  drift: number
  /** Why this run cannot be called clean. Never folded into `drift`. */
  reasons: string[]
  exitCode: number
  /** The failure line, or null when the check passes under this `failOn`. */
  failure: string | null
}

/**
 * Outcome of a run. `verified` carries the report and the verdict; every other
 * kind is a typed refusal the adapter prints to stderr with exit 1. Each git
 * derivation failure is its own kind so the message can name the flag that
 * bypasses it. A 401 is not caught here: it propagates as an ApiError so the
 * adapter's login nudge handles it the same way as every other command.
 */
export type ManualVerifyResult =
  | { kind: 'verified'; report: ManualVerifyResponse; verdict: Verdict; exitCode: number }
  | { kind: 'missing-fields'; message: string }
  | { kind: 'no-remote'; message: string }
  | { kind: 'non-github-remote'; message: string }
  | { kind: 'no-head'; message: string }
  | { kind: 'bad-base'; message: string }
  | { kind: 'invalid-request'; message: string }
  | { kind: 'not-found'; message: string }
  | { kind: 'invalid-payload'; message: string }

export interface ManualVerifyDeps {
  api: { verifyManual(body: ManualVerifyRequest): Promise<unknown> }
  readProjectConfig(): ProjectConfig | null
  git: GitRunner
  /** The human report, or under `--json` the payload and nothing else. */
  stdout(text: string): void
  /** Notes about the run (full-sweep fallback, "verified nothing"), never the payload. */
  stderr(text: string): void
}

/**
 * `deploylog manual verify`: send one verify request and turn the report into
 * lines and an exit code. No checking happens here; the verdict on every claim
 * comes from the route. What this module owns is the three derivations
 * (repository, ref, changed files), the two guards that stop a false clean
 * (an empty diff is not a scope; a slug no claim cites verified nothing), and
 * the mapping from counts to exit status.
 */
export async function runManualVerify(
  opts: ManualVerifyOptions,
  deps: ManualVerifyDeps = defaultManualVerifyDeps,
): Promise<ManualVerifyResult> {
  const failOn = opts.failOn ?? DEFAULT_FAIL_ON

  const project = opts.project ?? deps.readProjectConfig()?.project
  if (!project) {
    return {
      kind: 'missing-fields',
      message:
        'No project specified. Use --project <slug> or create a .deploylog.yml with:\n  project: my-app',
    }
  }

  let repository = opts.repository
  if (!repository) {
    const origin = originSlug(deps.git)
    if (origin.kind === 'no-remote') {
      return {
        kind: 'no-remote',
        message:
          'No `origin` remote to derive the repository from. ' +
          'Pass --repository <owner/repo> (a repository the manual\'s commit map covers).',
      }
    }
    if (origin.kind === 'not-github') {
      return {
        kind: 'non-github-remote',
        message:
          `The \`origin\` remote (${origin.url}) is not a github.com repository, so no owner/repo ` +
          'can be derived from it. Pass --repository <owner/repo> ' +
          '(a repository the manual\'s commit map covers).',
      }
    }
    repository = origin.slug
  }

  let ref = opts.ref
  if (!ref) {
    const sha = headSha(deps.git)
    if (!sha) {
      return {
        kind: 'no-head',
        message:
          'No HEAD commit to verify at (`git rev-parse HEAD` failed; an empty repository, or not ' +
          'a git repository). Commit first, or pass --ref <full-sha>.',
      }
    }
    ref = sha
  }

  let changedFiles: string[] | null = null
  if (opts.changedFrom !== undefined) {
    const paths = changedPathsSince(opts.changedFrom, deps.git)
    if (paths === null) {
      return {
        kind: 'bad-base',
        message:
          `Could not diff against '${opts.changedFrom}' ` +
          `(\`git diff --name-only ${opts.changedFrom}...HEAD\` failed). ` +
          'Pass --changed-from a ref that exists here and shares history with HEAD, ' +
          'or omit it to verify the whole manual.',
      }
    }
    // An empty diff is not a scope. The route passes the array through and the
    // service skips every claim outside it, so `[]` verifies nothing and reports
    // a clean sweep byte-identical to a real one. Zero is not a scope.
    if (paths.length === 0) {
      deps.stderr(
        `No files changed since '${opts.changedFrom}', so there is nothing to scope the check to. ` +
          'Verifying the whole manual instead.\n',
      )
    } else {
      changedFiles = paths
    }
  }

  const body = { project, repository, ref, changedFiles }
  const request = ManualVerifyRequestSchema.safeParse(body)
  if (!request.success) {
    const first = request.error.issues[0]
    const path = first && first.path.length > 0 ? first.path.join('.') : '(root)'
    return {
      kind: 'invalid-request',
      message:
        `The verify request this CLI derived does not match the schema it mirrors ` +
        `(first failing path: ${path}: ${first?.message ?? 'invalid'}). Nothing was sent.\n` +
        flagFor(path),
    }
  }

  let raw: unknown
  try {
    raw = await deps.api.verifyManual(request.data)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return {
        kind: 'not-found',
        message: `No manual for project '${project}' under this key (${err.message}).`,
      }
    }
    throw err
  }

  const parsed = ManualVerifyResponseSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first && first.path.length > 0 ? first.path.join('.') : '(root)'
    return {
      kind: 'invalid-payload',
      message:
        `The verify report for '${project}' does not match the schema this CLI mirrors ` +
        `(first failing path: ${path}: ${first?.message ?? 'invalid'}). No verdict was decided.\n` +
        'Update the CLI, or report this if you are already on the latest version.',
    }
  }

  const report = parsed.data
  const verdict = decideVerdict(report, failOn)

  // A fork or a mirror is a GitHub remote with the wrong slug. The route re-pins
  // only the slug it is sent; claims citing another repository keep their stored
  // pin and go untriggered, so under `drift` a run can report green having
  // verified nothing at this ref. Said loudly, whatever `--fail-on` is.
  if (verifiedNothing(report)) {
    deps.stderr(
      `verified nothing at ${ref}: no claim cites ${repository}. ` +
        'Pass --repository <owner/repo> naming a repository the manual\'s commit map covers.\n',
    )
  }

  if (opts.json) {
    deps.stdout(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    deps.stdout(renderReport(report, verdict, failOn))
  }

  return { kind: 'verified', report, verdict, exitCode: verdict.exitCode }
}

/**
 * No claim was evaluated at this ref: either the service evaluated nothing, or
 * every claim in the manual sits in a repository this run does not trigger.
 * Each claim is either evaluated or skipped, so their sum is the claim total.
 */
function verifiedNothing(report: ManualVerifyResponse): boolean {
  const total = report.evaluatedCount + report.skippedCount
  return (
    report.evaluatedCount === 0 ||
    (report.untriggeredCount > 0 && report.untriggeredCount >= total)
  )
}

function flagFor(path: string): string {
  if (path === 'ref') return 'Pass --ref <full-40-character-sha>.'
  if (path === 'repository') return 'Pass --repository <owner/repo>.'
  if (path.startsWith('changedFiles')) return 'Omit --changed-from to verify the whole manual.'
  return 'Pass --project <slug>.'
}

/**
 * Counts to exit status. `drift` is `confirmedCount` and nothing else; every
 * other non-zero count is a reason the run cannot be called clean, and the two
 * never collapse into each other, because collapsing them is how a broken
 * checker reads as a clean one (the Action's `verdict.ts`, same rule).
 */
export function decideVerdict(report: ManualVerifyResponse, failOn: FailOn): Verdict {
  const drift = report.confirmedCount
  const reasons = notCleanReasons(report)

  const failsOnDrift = drift > 0 && (failOn === 'drift' || failOn === 'any')
  // `unverifiable || errorCount > 0`, the Action's `drift > 0 || notCleanReasons`
  // in the route's own vocabulary: the service sets `unverifiable` from every
  // not-clean count, and errorCount is named beside it so a report whose flag
  // and counts disagree still fails on the count.
  const failsOnUnverifiable = (report.unverifiable || report.errorCount > 0) && failOn === 'any'

  const exitCode = failsOnDrift ? EXIT_DRIFT : failsOnUnverifiable ? EXIT_UNVERIFIABLE : 0
  const failure = exitCode === 0 ? null : failureLine(drift, reasons)
  return { drift, reasons, exitCode, failure }
}

function notCleanReasons(report: ManualVerifyResponse): string[] {
  const reasons: string[] = []
  if (report.errorCount > 0) {
    reasons.push(`${plural(report.errorCount, 'claim')} could not be read at all.`)
  }
  if (report.unanchoredCount > 0) {
    reasons.push(
      `${plural(report.unanchoredCount, 'chapter')} declare no claims, so nothing about them can ever drift.`,
    )
  }
  if (report.lowCoverageChapters.length > 0) {
    reasons.push(
      `${plural(report.lowCoverageChapters.length, 'chapter')} carry claims over too little of their own prose (${report.lowCoverageChapters.join(', ')}).`,
    )
  }
  if (report.untriggeredCount > 0) {
    reasons.push(
      `${plural(report.untriggeredCount, 'claim')} sit in a repository no push and no sweep visits, so future drift in them is invisible.`,
    )
  }
  return reasons
}

function failureLine(drift: number, reasons: string[]): string {
  if (drift > 0 && reasons.length > 0) {
    return `Manual check failed: ${plural(drift, 'claim')} drifted, and this run could not vouch for the rest of the manual.`
  }
  if (drift > 0) {
    return `Manual check failed: ${plural(drift, 'claim')} no longer match the code they cite.`
  }
  return 'Manual check failed: no drift was found, but this run could not vouch for the manual.'
}

/**
 * One line per chapter with its verdict counts, then one per confirmed finding
 * and one per error finding, then the summary counts, the low-coverage chapters
 * by name, and `unverifiable` in words.
 */
export function renderReport(
  report: ManualVerifyResponse,
  verdict: Verdict,
  failOn: FailOn,
): string {
  const lines: string[] = []

  for (const chapter of report.chapters) {
    lines.push(chapterLine(chapter))
    for (const finding of chapter.confirmed) {
      const where = finding.line === null ? finding.source : `${finding.source}:${finding.line}`
      lines.push(`  drift  ${where}  "${finding.text}"  ${finding.detail}`)
    }
    for (const finding of chapter.errors) {
      lines.push(`  error  ${finding.source}  ${finding.reason}  "${finding.text}"  ${errorDetail(finding)}`)
    }
  }

  lines.push(
    `Summary: confirmed ${report.confirmedCount} / errors ${report.errorCount} / ` +
      `unanchored ${report.unanchoredCount} / evaluated ${report.evaluatedCount} / ` +
      `skipped ${report.skippedCount}`,
  )
  if (report.lowCoverageChapters.length > 0) {
    lines.push(`Low coverage: ${report.lowCoverageChapters.join(', ')}`)
  }
  if (report.unverifiable) {
    lines.push('This run could not vouch for the manual (unverifiable):')
    for (const reason of verdict.reasons) lines.push(`  - ${reason}`)
  }

  lines.push(verdict.failure ?? escalationNote(verdict, failOn))
  return `${lines.join('\n')}\n`
}

function chapterLine(chapter: VerifyChapterResult): string {
  return (
    `${chapter.number} ${chapter.title}  ${chapter.state}  ` +
    `confirmed ${chapter.confirmed.length} / errors ${chapter.errors.length} / ` +
    `untriggered ${chapter.untriggered.length} / touched ${chapter.touched.length}`
  )
}

function errorDetail(finding: VerifyChapterResult['errors'][number]): string {
  if (finding.reason === 'unmapped_repository') {
    return (
      `${finding.repository} is not in this project's commit map, so nothing in it can be read. ` +
      finding.detail
    )
  }
  return finding.detail
}

function escalationNote(verdict: Verdict, failOn: FailOn): string {
  if (verdict.drift === 0 && verdict.reasons.length === 0) return 'Manual check passed: no drift found.'
  const why =
    verdict.drift > 0
      ? 'This check is green because escalation is off'
      : 'This check is green because no claim drifted'
  const hint =
    failOn === 'none'
      ? 'Pass --fail-on drift to fail on drift, or --fail-on any to fail on anything this run could not vouch for.'
      : 'Pass --fail-on any to fail on anything this run could not vouch for.'
  return `${why}. ${hint}`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export const defaultManualVerifyDeps: ManualVerifyDeps = {
  api: { verifyManual },
  readProjectConfig: () => readProjectConfig(),
  git: runGit,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}
