import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type EditorResult =
  | { kind: 'edited'; body: string }
  | { kind: 'unchanged' }
  | { kind: 'aborted'; message: string }
  | { kind: 'no-editor'; message: string }

/**
 * Round-trip a markdown body through $EDITOR (fallback: $VISUAL, then vi).
 * Trailing newlines are normalized before the no-op check — editors append
 * one on save, and that alone must not count as a change.
 */
export function editInEditor(initial: string): EditorResult {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi'

  const dir = mkdtempSync(join(tmpdir(), 'deploylog-'))
  const file = join(dir, 'entry.md')
  writeFileSync(file, initial, 'utf8')

  try {
    const res = spawnSync(editor, [file], { stdio: 'inherit' })

    if (res.error) {
      return {
        kind: 'no-editor',
        message: `Could not launch editor '${editor}'. Set $EDITOR, or pass --body / --body-file instead.`,
      }
    }
    if (res.status !== 0) {
      return { kind: 'aborted', message: `Editor exited with status ${res.status}; entry not changed.` }
    }

    const edited = readFileSync(file, 'utf8')
    if (edited.replace(/\n+$/, '') === initial.replace(/\n+$/, '')) {
      return { kind: 'unchanged' }
    }
    return { kind: 'edited', body: edited }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Persist a body the server rejected so the user's writing is never lost —
 * printed in the error message as a recoverable path.
 */
export function saveRecoveryFile(body: string): string {
  const dir = join(tmpdir(), 'deploylog-recovery')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `entry-${process.pid}-${Date.now()}.md`)
  writeFileSync(file, body, 'utf8')
  return file
}
