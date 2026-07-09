import {
  listEntries,
  getEntry,
  setEntryPublished,
  type Entry,
  type EntryDetail,
  type PublishStateEntry,
} from './api.js'
import { readProjectConfig, type ProjectConfig } from './project-config.js'
import { resolveEntryRef } from './resolve.js'

/**
 * Shared deps for the entry-lifecycle commands (publish/unpublish, and the
 * view/edit/delete siblings that follow) — same DI shape as PushDeps.
 */
export interface EntryCommandDeps {
  api: {
    listEntries(slug: string): Promise<Entry[]>
    getEntry(id: string): Promise<EntryDetail>
    setEntryPublished(id: string, published: boolean): Promise<PublishStateEntry>
  }
  readProjectConfig(): ProjectConfig | null
}

export interface SetPublishedOptions {
  ref: string
  project?: string
  publish: boolean
}

export type SetPublishedResult =
  | { kind: 'updated'; entry: PublishStateEntry; publish: boolean }
  | { kind: 'not-found'; message: string }
  | { kind: 'missing-fields'; message: string }

export async function runSetPublished(
  opts: SetPublishedOptions,
  deps: EntryCommandDeps = defaultEntryCommandDeps,
): Promise<SetPublishedResult> {
  const projectConfig = deps.readProjectConfig()
  const slug = opts.project ?? projectConfig?.project
  if (!slug) {
    return {
      kind: 'missing-fields',
      message:
        'No project specified. Use --project <slug> or create a .deploylog.yml with:\n  project: my-app',
    }
  }

  const resolved = await resolveEntryRef(opts.ref, slug, deps.api.listEntries)
  if (resolved.kind === 'not-found') {
    return { kind: 'not-found', message: resolved.message }
  }

  const entry = await deps.api.setEntryPublished(resolved.id, opts.publish)
  return { kind: 'updated', entry, publish: opts.publish }
}

export interface ViewOptions {
  ref: string
  project?: string
}

export type ViewResult =
  | { kind: 'found'; entry: EntryDetail }
  | { kind: 'not-found'; message: string }
  | { kind: 'missing-fields'; message: string }

export async function runView(
  opts: ViewOptions,
  deps: EntryCommandDeps = defaultEntryCommandDeps,
): Promise<ViewResult> {
  const projectConfig = deps.readProjectConfig()
  const slug = opts.project ?? projectConfig?.project
  if (!slug) {
    return {
      kind: 'missing-fields',
      message:
        'No project specified. Use --project <slug> or create a .deploylog.yml with:\n  project: my-app',
    }
  }

  const resolved = await resolveEntryRef(opts.ref, slug, deps.api.listEntries)
  if (resolved.kind === 'not-found') {
    return { kind: 'not-found', message: resolved.message }
  }

  const entry = await deps.api.getEntry(resolved.id)
  return { kind: 'found', entry }
}

export const defaultEntryCommandDeps: EntryCommandDeps = {
  api: { listEntries, getEntry, setEntryPublished },
  readProjectConfig: () => readProjectConfig(),
}
