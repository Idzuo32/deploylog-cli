// mirrored from deploylog src/lib/schemas.ts @ 946dead
//
// `GET /api/cli/manual/export` validates its body against the server's
// ManualExportResponseSchema on the way out; this file is that schema and every
// schema it embeds, copied verbatim (comments included) so `deploylog manual
// export` refuses a payload the server would also have refused. If the server's
// copy changes, re-copy and bump the sha above — never loosen this one to make
// a drifted payload fit (issue 03, Boundaries).

import { z } from 'zod'

const REPOSITORY_SLUG = /^[\w.-]+\/[\w.-]+$/

export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'Must be a full 40-character commit sha')

// --- Manual claims (Manual feature) ---
// A claim is the unit the verification service checks: one manual sentence, the
// repository and file it refers to, and the value it asserts. Four kinds cover
// the measured error classes. The absence kind exists because immutability
// claims ("this cannot be changed later") were the most severe class found.

export const CLAIM_KINDS = ['const', 'zod-field', 'zod-field-absent', 'literal'] as const

export type ClaimKind = (typeof CLAIM_KINDS)[number]

/**
 * A path inside a repository.
 *
 * Every segment must be an ordinary name. Percent-encoding a path is not
 * protection: `encodeURIComponent('..')` is `'..'`, and `fetch` resolves the
 * finished URL through the WHATWG parser, which collapses dot segments — so a
 * path containing `..` walked out of the repository the caller had been
 * authorized for and read a different one through the same installation token.
 * Rejecting the input is the guard; encoding it is not.
 */
export const RepoFilePathSchema = z
  .string()
  .min(1, 'A path is required')
  .refine(
    (path) =>
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Every path segment must be an ordinary name (no empty, "." or ".." segments)',
  )

export const ClaimSchema = z
  .object({
    id: z.string().min(1),
    // The manual sentence, mandatory. A finding that names a moved symbol but no
    // sentence is not actionable, and the literal kind carries no symbol at all,
    // so this is the only universal handle on a finding.
    text: z.string().min(1),
    repository: z.string().regex(REPOSITORY_SLUG, 'Must be owner/repo'),
    // The same rule the reader enforces, applied where a claim enters the system,
    // so a traversal path cannot be stored and replayed later.
    source: RepoFilePathSchema,
    symbol: z.string().min(1).optional(),
    kind: z.enum(CLAIM_KINDS),
    // No empty expect: a literal claim expecting '' matches every file and could
    // never fire.
    expect: z.string().min(1),
  })
  // strict, so a hand-authored `anchors` key is REJECTED rather than silently
  // stripped. Anchors are derived from the files claims already cite; a
  // hand-authored anchor encodes where an author believes behaviour lives and
  // rots exactly as the manual does.
  .strict()

export type Claim = z.infer<typeof ClaimSchema>

export const ChapterSchema = z
  .object({
    // A string: chapters are numbered "01", "02", and a number type would reject
    // the leading zero.
    number: z.string().min(1),
    title: z.string().min(1),
    // The chapter's prose, in markdown. Required, not optional: claim coverage is
    // measured over these sentences, and a chapter whose body went missing would
    // measure as "no sentences to cover" — a clean coverage figure produced by
    // the absence of the thing being measured.
    body: z.string(),
    claims: z.array(ClaimSchema),
  })
  .strict()

export type Chapter = z.infer<typeof ChapterSchema>

/**
 * Repository slug to the commit it is pinned at. A product may span
 * repositories, so each claim is verified against the commit map entry for its
 * own repository. A single commit cannot describe a multi-repo product.
 */
export const CommitMapSchema = z.record(z.string().regex(REPOSITORY_SLUG), CommitShaSchema)

export type CommitMap = z.infer<typeof CommitMapSchema>

export const CHAPTER_STATUSES = ['draft', 'flagged', 'approved', 'published'] as const

export type ChapterStatus = (typeof CHAPTER_STATUSES)[number]

// --- Manual export (issue 57) ---
// The portability answer to `wiki/decisions/claims-are-mirror-owned.md`: the
// whole manual, every version with its commit map and its chapters with their
// claims, retrievable on any tier. The schema IS the contract the CLI's
// `deploylog manual export` mirrors, exactly as ManualVerifyResponseSchema is
// for the Action.

/**
 * A chapter as exported: ChapterSchema itself, so the claims are ClaimSchema
 * and cannot drift from the vocabulary `manual_claims` stores, plus the
 * review state the mirror holds for it.
 */
const ExportChapterSchema = ChapterSchema.extend({ status: z.enum(CHAPTER_STATUSES) }).strict()

/**
 * One version. `commitMap` is required and nullable, never optional: `expect`
 * is the value read at generation, so claims without the map of the version
 * they were cut against verify nothing. A version whose stored map is empty
 * (the working version's column default) is exported with `null` — marked as
 * having none — rather than with `{}`, which would read as a pinned version
 * that happens to cite few repositories. A non-null map must pin at least one
 * repository, so the empty object cannot reach the wire under either spelling.
 */
const ExportVersionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** When the version was cut, or null for the working version. */
    publishedAt: z.string().nullable(),
    createdAt: z.string(),
    commitMap: CommitMapSchema.refine(
      (map) => Object.keys(map).length > 0,
      'A pinned version maps at least one repository; an unpinned one is null',
    ).nullable(),
    chapters: z.array(ExportChapterSchema),
  })
  .strict()

export const ManualExportResponseSchema = z
  .object({
    project: z.string().min(1),
    manual: z.object({ id: z.string().min(1), title: z.string() }).strict(),
    versions: z.array(ExportVersionSchema),
  })
  .strict()

export type ManualExportResponse = z.infer<typeof ManualExportResponseSchema>
