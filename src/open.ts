import { spawn } from 'node:child_process'
import { getEntry, type EntryDetail } from './api.js'
import { getApiUrl } from './config.js'
import { readProjectConfig, type ProjectConfig } from './project-config.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OpenOptions {
  ref?: string
  project?: string
}

export type OpenResult =
  | { kind: 'opened'; url: string }
  | { kind: 'printed'; url: string }
  | { kind: 'missing-fields'; message: string }

export interface OpenDeps {
  api: { getEntry(id: string): Promise<EntryDetail> }
  readProjectConfig(): ProjectConfig | null
  /** Try to open the URL in a browser; false when there's nothing to open with. */
  launch(url: string): boolean
  baseUrl(): string
}

/**
 * Build the public URL (changelog page, or a single entry's page) and open it.
 * A slug ref goes straight into the URL — public pages don't need auth. Only a
 * uuid ref costs an API call (to look up the slug the public URL wants).
 * Headless environments get the URL printed instead of a hung browser spawn.
 */
export async function runOpen(
  opts: OpenOptions,
  deps: OpenDeps = defaultOpenDeps,
): Promise<OpenResult> {
  const projectConfig = deps.readProjectConfig()
  const project = opts.project ?? projectConfig?.project
  if (!project) {
    return {
      kind: 'missing-fields',
      message:
        'No project specified. Use --project <slug> or create a .deploylog.yml with:\n  project: my-app',
    }
  }

  const base = deps.baseUrl()
  let url = `${base}/p/${project}/changelog`

  if (opts.ref) {
    const entrySlug = UUID_RE.test(opts.ref)
      ? (await deps.api.getEntry(opts.ref)).slug
      : opts.ref
    url = `${base}/p/${project}/c/${entrySlug}`
  }

  if (deps.launch(url)) {
    return { kind: 'opened', url }
  }
  return { kind: 'printed', url }
}

function launchBrowser(url: string): boolean {
  // No display server → nothing to open with; the caller prints the URL.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false
  }
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
  // ENOENT arrives async — swallow it; the URL is printed either way.
  child.on('error', () => {})
  child.unref()
  return true
}

export const defaultOpenDeps: OpenDeps = {
  api: { getEntry },
  readProjectConfig: () => readProjectConfig(),
  launch: launchBrowser,
  baseUrl: () => getApiUrl(),
}
