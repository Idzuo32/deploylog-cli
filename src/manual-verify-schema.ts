// mirrored from deploylog src/lib/schemas.ts @ 4c115c0
//
// `POST /api/cli/manual/verify` validates its request against the server's
// ManualVerifyRequestSchema on the way in and its report against
// ManualVerifyResponseSchema on the way out; this file is both schemas and every
// schema they embed, copied verbatim (comments included) so `deploylog manual
// verify` refuses to send a body the server would reject and refuses to act on a
// report the server's own contract would not have produced. The three building
// blocks the two schemas share with the export contract (`REPOSITORY_SLUG`,
// `CommitShaSchema`, `RepoFilePathSchema`) are imported from `manual-schema.ts`
// rather than cut a second time. If the server's copy changes, re-copy and bump
// the sha above — never loosen this one to make a drifted payload fit (issue 04,
// Boundaries).

import { z } from 'zod'
import { CommitShaSchema, REPOSITORY_SLUG, RepoFilePathSchema } from './manual-schema.js'

// --- The manual verify endpoint (issue 56) ---
// The transport the GitHub Action consumes. Both shapes below are the contract:
// the Action mirrors them, and the route validates its own response against the
// second one before sending it, so the wire shape cannot drift into whatever the
// internal `VerificationReport` type happens to be this week.

/**
 * A verify run.
 *
 * `project` rather than a version id: the caller is a workflow in a repository,
 * it knows its DeployLog project the way every other CLI route knows it (by
 * slug), and it has no business holding an internal version uuid. The route
 * resolves the project's *working* version — the manual currently being
 * maintained. An archived version is historical and is never what a push checks;
 * running one against a push is the permanent wall of false findings
 * `prd-manual.md:188-192` forbids.
 *
 * `ref` is the commit the run is on, and it re-pins **this repository** in the
 * version's commit map for the duration of the run. Sibling repositories keep
 * their stored pins. Without that, a push-triggered run reads the code as it was
 * when the version was cut, reports clean over the drift the push just
 * introduced, and reports finding lines that cannot land in the diff — the
 * Action needs `finding.line` to be where the value sits at the ref it is
 * annotating (`deploylog-action/issues/55`).
 *
 * `changedFiles` is paths, paired server-side with `repository`. A run knows what
 * changed in the repository it is running in and nowhere else, so a caller
 * cannot declare a change in a repository it is not in. `null` is a full sweep.
 */
export const ManualVerifyRequestSchema = z
  .object({
    project: z.string().min(1).max(100),
    // Not lowercased here, deliberately. Every place this value is compared
    // canonicalises first — the route's commit-map re-pin, and `canonicalSlug`
    // inside the verification service for changed files and triggers — and a
    // transform on top of that is a second guard that would keep the endpoint
    // working if the real one broke, which is how you end up not knowing which
    // one is load-bearing. Measured: removing a transform here changed no test.
    repository: z.string().regex(REPOSITORY_SLUG, 'Must be owner/repo'),
    ref: CommitShaSchema,
    changedFiles: z.array(RepoFilePathSchema).nullable(),
  })
  .strict()

export type ManualVerifyRequest = z.infer<typeof ManualVerifyRequestSchema>

export const VERIFY_VERDICTS = ['CONFIRMED', 'SUSPECT', 'CLEAR', 'ERROR', 'UNANCHORED'] as const

/**
 * Every reason an individual claim can fail. Enumerated here rather than imported
 * from the service: `manual-verification.ts` imports this module, so the
 * dependency only runs one way. The route asserts at compile time that this list
 * still covers the service's union, which is the part that would otherwise rot.
 */
export const VERIFY_ERROR_REASONS = [
  'no_access',
  'not_found',
  'not_configured',
  'unavailable',
  'invalid_request',
  'unmapped_repository',
  'missing_symbol',
  'malformed_claim',
  'unsupported_value',
] as const

export type VerifyErrorReason = (typeof VERIFY_ERROR_REASONS)[number]

const VerifyCoverageSchema = z
  .object({
    sentences: z.number().int().min(0),
    measurable: z.number().int().min(0),
    claimed: z.number().int().min(0),
    ratio: z.number().nullable(),
    unclaimed: z.array(z.string()),
  })
  .strict()

const VerifyConfirmedFindingSchema = z
  .object({
    claimId: z.string(),
    text: z.string(),
    repository: z.string(),
    source: z.string(),
    /** Where the value sits now, or null when the finding is a disappearance. */
    line: z.number().int().nullable(),
    detail: z.string(),
  })
  .strict()

const VerifyErrorFindingSchema = z
  .object({
    claimId: z.string(),
    text: z.string(),
    repository: z.string(),
    source: z.string(),
    reason: z.enum(VERIFY_ERROR_REASONS),
    detail: z.string(),
  })
  .strict()

const VerifyUntriggeredFindingSchema = z
  .object({ claimId: z.string(), text: z.string(), repository: z.string() })
  .strict()

const VerifyChapterResultSchema = z
  .object({
    number: z.string(),
    title: z.string(),
    state: z.enum(VERIFY_VERDICTS),
    confirmed: z.array(VerifyConfirmedFindingSchema),
    errors: z.array(VerifyErrorFindingSchema),
    touched: z.array(z.string()),
    coverage: VerifyCoverageSchema,
    untriggered: z.array(VerifyUntriggeredFindingSchema),
  })
  .strict()

export type VerifyChapterResult = z.infer<typeof VerifyChapterResultSchema>

/**
 * The report as the wire carries it.
 *
 * All five counts are present and required, because the consumer's exit status
 * comes from them and never from `unverifiable`
 * (`wiki/decisions/unverifiable-covers-thin-and-unwatched.md`). An optional count
 * would let a run with drift arrive looking like a run with none.
 */
export const ManualVerifyResponseSchema = z
  .object({
    chapters: z.array(VerifyChapterResultSchema),
    confirmedCount: z.number().int().min(0),
    errorCount: z.number().int().min(0),
    unanchoredCount: z.number().int().min(0),
    evaluatedCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
    lowCoverageChapters: z.array(z.string()),
    untriggeredCount: z.number().int().min(0),
    unverifiable: z.boolean(),
  })
  .strict()

export type ManualVerifyResponse = z.infer<typeof ManualVerifyResponseSchema>
