import { writeFileSync } from 'node:fs'
import { ApiError, exportManual } from './api.js'
import { readProjectConfig, type ProjectConfig } from './project-config.js'
import { ManualExportResponseSchema, type ManualExportResponse } from './manual-schema.js'

export interface ManualExportOptions {
  project?: string
  /** Output path; `-` streams to stdout. Default `./<slug>-manual.json`. */
  out?: string
}

/**
 * Outcome of an export. `written` / `streamed` carry the version count; every
 * other kind is a typed refusal the adapter prints to stderr with exit 1.
 * A 401 is not caught here: it propagates as an ApiError so the adapter's
 * existing login nudge handles it the same way as every other command.
 */
export type ManualExportResult =
  | { kind: 'written'; path: string; versions: number }
  | { kind: 'streamed'; versions: number }
  | { kind: 'missing-fields'; message: string }
  | { kind: 'not-found'; message: string }
  | { kind: 'invalid-payload'; message: string }

export interface ManualExportDeps {
  api: { exportManual(slug: string): Promise<unknown> }
  readProjectConfig(): ProjectConfig | null
  writeFile(path: string, text: string): void
  /** The only thing that ever reaches stdout: the payload, when `--out -`. */
  stdout(text: string): void
}

/**
 * `deploylog manual export`: fetch the whole manual for one project and write
 * it where a human can open it. The payload is validated against the mirrored
 * server schema BEFORE anything is written, so a file on disk is always a
 * payload the server's own contract accepted. No reader, no diff, no import
 * (issue 03, Boundaries) — and no tier check of any kind: the export is the
 * exit, and the exit is never charged for.
 */
export async function runManualExport(
  opts: ManualExportOptions,
  deps: ManualExportDeps = defaultManualExportDeps,
): Promise<ManualExportResult> {
  const slug = opts.project ?? deps.readProjectConfig()?.project
  if (!slug) {
    return {
      kind: 'missing-fields',
      message:
        'No project specified. Use --project <slug> or create a .deploylog.yml with:\n  project: my-app',
    }
  }

  let raw: unknown
  try {
    raw = await deps.api.exportManual(slug)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return {
        kind: 'not-found',
        message: `No manual for project '${slug}' under this key (${err.message}).`,
      }
    }
    throw err
  }

  const parsed = ManualExportResponseSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first && first.path.length > 0 ? first.path.join('.') : '(root)'
    return {
      kind: 'invalid-payload',
      message:
        `The export for '${slug}' does not match the schema this CLI mirrors ` +
        `(first failing path: ${path}: ${first?.message ?? 'invalid'}). Nothing was written.\n` +
        'Update the CLI, or report this if you are already on the latest version.',
    }
  }

  const payload: ManualExportResponse = parsed.data
  const text = `${JSON.stringify(payload, null, 2)}\n`
  const versions = payload.versions.length

  if (opts.out === '-') {
    deps.stdout(text)
    return { kind: 'streamed', versions }
  }

  const path = opts.out ?? `${slug}-manual.json`
  deps.writeFile(path, text)
  return { kind: 'written', path, versions }
}

export const defaultManualExportDeps: ManualExportDeps = {
  api: { exportManual },
  readProjectConfig: () => readProjectConfig(),
  writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
  stdout: (text) => process.stdout.write(text),
}
