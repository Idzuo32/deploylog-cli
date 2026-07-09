import { readFileSync } from 'node:fs'
import {
  listEntries,
  getEntry,
  updateEntry,
  deleteEntry,
  setEntryPublished,
  ApiError,
  type Entry,
  type EntryDetail,
  type PublishStateEntry,
  type UpdateEntryInput,
} from './api.js'
import { readProjectConfig, type ProjectConfig } from './project-config.js'
import { resolveEntryRef } from './resolve.js'
import { editInEditor, saveRecoveryFile, type EditorResult } from './editor.js'
import { defaultPushDeps } from './push.js'

/**
 * Shared deps for the entry-lifecycle commands (publish/unpublish, and the
 * view/edit/delete siblings that follow) — same DI shape as PushDeps.
 */
export interface EntryCommandDeps {
  api: {
    listEntries(slug: string): Promise<Entry[]>
    getEntry(id: string): Promise<EntryDetail>
    updateEntry(id: string, input: UpdateEntryInput): Promise<EntryDetail>
    deleteEntry(id: string): Promise<{ id: string }>
    setEntryPublished(id: string, published: boolean): Promise<PublishStateEntry>
  }
  readProjectConfig(): ProjectConfig | null
  editor(initial: string): EditorResult
  saveRecovery(body: string): string
  readFile(path: string): string
  confirm(question: string): Promise<boolean>
  isTTY: boolean
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

export interface EditOptions {
  ref: string
  project?: string
  title?: string
  type?: string
  version?: string
  body?: string
  bodyFile?: string
}

export type EditResult =
  | { kind: 'updated'; entry: EntryDetail; previousSlug: string }
  | { kind: 'not-found'; message: string }
  | { kind: 'missing-fields'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'unchanged'; message: string }
  | { kind: 'body-rejected'; message: string; recoveryPath: string }

export async function runEdit(
  opts: EditOptions,
  deps: EntryCommandDeps = defaultEntryCommandDeps,
): Promise<EditResult> {
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

  const current = await deps.api.getEntry(resolved.id)

  const hasFieldFlags =
    opts.title !== undefined ||
    opts.type !== undefined ||
    opts.version !== undefined ||
    opts.body !== undefined ||
    opts.bodyFile !== undefined

  let body = opts.body
  let bodyFromEditor = false

  if (opts.bodyFile !== undefined && body === undefined) {
    try {
      body = deps.readFile(opts.bodyFile)
    } catch {
      return { kind: 'missing-fields', message: `Could not read body file '${opts.bodyFile}'.` }
    }
  }

  if (!hasFieldFlags) {
    if (!deps.isTTY) {
      return {
        kind: 'missing-fields',
        message:
          'Nothing to edit. Pass --title / --type / --version / --body / --body-file (the $EDITOR flow needs an interactive terminal).',
      }
    }
    const edited = deps.editor(current.body_markdown)
    switch (edited.kind) {
      case 'unchanged':
        return { kind: 'unchanged', message: 'No changes made; entry left as is.' }
      case 'aborted':
        return { kind: 'cancelled', message: edited.message }
      case 'no-editor':
        return { kind: 'missing-fields', message: edited.message }
      case 'edited':
        body = edited.body
        bodyFromEditor = true
    }
  }

  const input: UpdateEntryInput = {}
  if (opts.title !== undefined) input.title = opts.title
  if (opts.type !== undefined) input.entry_type = opts.type
  if (opts.version !== undefined) input.version = opts.version
  if (body !== undefined) input.body_markdown = body

  try {
    const entry = await deps.api.updateEntry(resolved.id, input)
    return { kind: 'updated', entry, previousSlug: current.slug }
  } catch (err) {
    // A rejected editor-authored body must never be discarded — park it on
    // disk and point at it.
    if (bodyFromEditor && err instanceof ApiError && body !== undefined) {
      const recoveryPath = deps.saveRecovery(body)
      return {
        kind: 'body-rejected',
        message: `${err.message}\nYour edited body was saved to ${recoveryPath}`,
        recoveryPath,
      }
    }
    throw err
  }
}

export interface DeleteOptions {
  ref: string
  project?: string
  yes?: boolean
}

export type DeleteResult =
  | { kind: 'deleted'; id: string; title: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'confirm-required'; message: string }
  | { kind: 'not-found'; message: string }
  | { kind: 'missing-fields'; message: string }

export async function runDelete(
  opts: DeleteOptions,
  deps: EntryCommandDeps = defaultEntryCommandDeps,
): Promise<DeleteResult> {
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

  // Fetch first so the confirm prompt names what's about to be destroyed
  // (and so a wrong-org/missing id 404s before any prompt).
  const entry = await deps.api.getEntry(resolved.id)

  if (!opts.yes) {
    // Deleting is permanent — stricter than push: a non-interactive shell
    // must opt in explicitly instead of auto-proceeding.
    if (!deps.isTTY) {
      return {
        kind: 'confirm-required',
        message: 'Refusing to delete without confirmation. Pass --yes in non-interactive mode.',
      }
    }
    const ok = await deps.confirm(
      `Delete '${entry.title}' (${entry.slug})? This is permanent.`,
    )
    if (!ok) {
      return { kind: 'cancelled', message: 'Cancelled. Entry not deleted.' }
    }
  }

  await deps.api.deleteEntry(resolved.id)
  return { kind: 'deleted', id: resolved.id, title: entry.title }
}

export const defaultEntryCommandDeps: EntryCommandDeps = {
  api: { listEntries, getEntry, updateEntry, deleteEntry, setEntryPublished },
  readProjectConfig: () => readProjectConfig(),
  editor: editInEditor,
  saveRecovery: saveRecoveryFile,
  // '-' reads stdin so agents/CI can pipe a body without a temp file.
  readFile: (path) => readFileSync(path === '-' ? 0 : path, 'utf8'),
  confirm: (question) => defaultPushDeps.confirm(question),
  isTTY: Boolean(process.stdin.isTTY),
}
