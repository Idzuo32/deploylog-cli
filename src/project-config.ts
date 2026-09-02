import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import chalk from 'chalk'

export interface ProjectConfig {
  project?: string
  default_type?: string
}

/**
 * Every key `.deploylog.yml` recognizes. Adding a field to ProjectConfig means
 * adding it here too, or the new key reports as unrecognized. (issue 08)
 */
const KNOWN_KEYS = ['project', 'default_type'] as const

export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectConfigError'
  }
}

/**
 * Presentational sink for the non-fatal lines the read emits. Injected so the
 * tests can assert on them; the default writes to **stderr**, keeping stdout a
 * clean JSON stream for `--json`.
 */
export type ConfigWarn = (message: string) => void

const defaultWarn: ConfigWarn = (message) => console.error(chalk.yellow(message))

/** Levenshtein distance — only ever run over a handful of short keys. */
function editDistance(a: string, b: string): number {
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[b.length]!
}

/**
 * The closest recognized key, when the given key looks like a typo of one.
 * Distance 2 covers what people actually mistype here: `default-type` and
 * `defaultType` for `default_type`, `projects` and `Project` for `project`.
 * Anything further away gets no suggestion — a wrong guess is worse than none.
 */
function suggestKey(key: string): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const known of KNOWN_KEYS) {
    const distance = editDistance(key.toLowerCase(), known)
    if (distance < bestDistance) {
      best = known
      bestDistance = distance
    }
  }
  return best
}

/**
 * Report keys `.deploylog.yml` does not recognize instead of dropping them.
 *
 * The silent drop was the whole defect: `default-type: fix` (hyphen) or
 * `projects: my-app` (plural) parses fine, means nothing, and the user sees
 * either the wrong default or "No project specified" with nothing pointing at
 * the typo. (issue 08)
 *
 * This WARNS rather than failing. `.deploylog.yml` carries no version pin, so
 * an unrecognized key can always be one a newer CLI understands, and failing
 * would break a repo whose config outruns the installed CLI. (pnpm 12 hard-errors
 * on the same class exactly where a version pin excludes that reading —
 * see references/transcripts/145.txt.)
 */
function warnUnrecognizedKeys(parsed: object, filePath: string, warn: ConfigWarn): void {
  const known = new Set<string>(KNOWN_KEYS)
  const unknown = Object.keys(parsed).filter((key) => !known.has(key))
  if (unknown.length === 0) return

  const lines = unknown.map((key) => {
    const suggestion = suggestKey(key)
    return suggestion ? `  ${key}  (did you mean ${suggestion}?)` : `  ${key}`
  })

  warn(
    `Unrecognized ${unknown.length === 1 ? 'setting' : 'settings'} in ${filePath} ` +
      `(ignored):\n${lines.join('\n')}\n` +
      `  Recognized: ${KNOWN_KEYS.join(', ')}`,
  )
}

/**
 * A recognized key holding the wrong type is a hard error, not a warning: it
 * was meant for us, so flowing it on lets YAML's own coercion decide (`project:
 * 123` would push to the project named "123"). (issue 08)
 */
function assertKnownKeyTypes(parsed: Record<string, unknown>, filePath: string): void {
  for (const key of KNOWN_KEYS) {
    const value = parsed[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') {
      throw new ProjectConfigError(
        `Invalid .deploylog.yml at ${filePath}: "${key}" must be a string, got ${
          Array.isArray(value) ? 'a list' : typeof value
        }.`,
      )
    }
  }
}

/**
 * Read .deploylog.yml from `startDir` (or its parents).
 *
 * The walk distinguishes two failures the old code conflated:
 *   - not found at this level  → keep walking up (returns null if none found)
 *   - present but malformed    → STOP and throw, so a broken config never
 *     silently falls through to a parent directory's config (a wrong-project
 *     push) or a misleading "No project specified". (A3)
 *
 * `startDir` is injected (not read from `process.cwd()` here) so the walk is
 * testable without `chdir`; `warn` is injected so the tests can assert on the
 * unrecognized-key report.
 */
export function readProjectConfig(
  startDir: string = process.cwd(),
  warn: ConfigWarn = defaultWarn,
): ProjectConfig | null {
  let dir = startDir

  while (true) {
    const filePath = resolve(dir, '.deploylog.yml')

    let content: string | null = null
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch {
      // Not found (or unreadable) at this level — walk up.
      content = null
    }

    if (content !== null) {
      // A file exists here: this level is authoritative. Any parse/shape
      // failure stops the walk — we never adopt a parent's config behind a
      // broken file.
      let parsed: unknown
      try {
        parsed = parse(content)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new ProjectConfigError(`Invalid YAML in ${filePath}: ${detail}`)
      }

      // An empty file parses to null/undefined — treat as a present-but-empty
      // config (stops the walk), not "not found".
      if (parsed === null || parsed === undefined) return {}

      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ProjectConfigError(
          `Invalid .deploylog.yml at ${filePath}: expected a mapping like "project: my-app".`,
        )
      }

      const record = parsed as Record<string, unknown>
      assertKnownKeyTypes(record, filePath)
      warnUnrecognizedKeys(record, filePath, warn)

      return {
        ...(typeof record['project'] === 'string' ? { project: record['project'] } : {}),
        ...(typeof record['default_type'] === 'string'
          ? { default_type: record['default_type'] }
          : {}),
      }
    }

    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }

  return null
}
