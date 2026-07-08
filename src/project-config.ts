import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

export interface ProjectConfig {
  project?: string
  default_type?: string
}

export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectConfigError'
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
 * testable without `chdir`.
 */
export function readProjectConfig(startDir: string = process.cwd()): ProjectConfig | null {
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

      return parsed as ProjectConfig
    }

    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }

  return null
}
