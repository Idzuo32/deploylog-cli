import type { Entry } from './api.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a user-supplied entry reference (slug or id) to an entry id.
 *
 * The id is the canonical handle — slugs are mutable on drafts (a title edit
 * regenerates them), so a uuid-shaped ref is passed straight through and the
 * server's org-scoped lookup is the authority. A slug is matched against the
 * project's recent entries; entries beyond that window need the id.
 */
export type ResolveResult =
  | { kind: 'resolved'; id: string; entry?: Entry }
  | { kind: 'not-found'; message: string }

export async function resolveEntryRef(
  ref: string,
  projectSlug: string,
  listEntries: (slug: string) => Promise<Entry[]>,
): Promise<ResolveResult> {
  if (UUID_RE.test(ref)) {
    return { kind: 'resolved', id: ref }
  }

  const entries = await listEntries(projectSlug)
  const match = entries.find((e) => e.slug === ref)
  if (match) {
    return { kind: 'resolved', id: match.id, entry: match }
  }

  return {
    kind: 'not-found',
    message:
      `Entry '${ref}' not found in the ${entries.length} most recent entries of '${projectSlug}'.\n` +
      'Older entries must be referenced by id — `deploylog list` shows ids.',
  }
}
