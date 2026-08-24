import { getApiKey, getApiUrl } from './config.js'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('Not authenticated. Run `deploylog login` first.')
  }

  const url = `${getApiUrl()}/api/cli${path}`

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  })

  // Read the body as text first and parse defensively: proxies/CDNs return
  // non-JSON (HTML 502/504, empty 429) on outages, and `res.json()` would throw
  // an opaque SyntaxError instead of a useful status. (BUG-011)
  interface ApiResponse {
    data?: T
    error?: { code?: string; message?: string }
  }
  const raw = await res.text()
  let body: ApiResponse | null = null
  if (raw) {
    try {
      body = JSON.parse(raw) as ApiResponse
    } catch {
      body = null
    }
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `Request failed (${res.status})`,
    )
  }

  // Reject non-JSON bodies and well-formed JSON that's missing `data` — both
  // violate the response contract and would otherwise return undefined.
  if (!body || body.data === undefined) {
    throw new ApiError(res.status, 'INVALID_RESPONSE', `Server returned an unexpected response (${res.status})`)
  }

  return body.data
}

export interface Project {
  id: string
  name: string
  slug: string
  website_url: string | null
  created_at: string
}

export interface Entry {
  id: string
  title: string
  slug: string
  entry_type: string | null
  version: string | null
  published: boolean
  published_at: string | null
  created_at: string
}

export async function listProjects(): Promise<Project[]> {
  return request('/projects')
}

export async function createProject(name: string, websiteUrl?: string): Promise<Project> {
  return request('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, website_url: websiteUrl ?? '' }),
  })
}

export interface GithubImportResult {
  imported: number
  skipped: number
}

export async function importGithub(
  projectSlug: string,
  repo: string,
  token?: string,
): Promise<GithubImportResult> {
  return request(`/projects/${projectSlug}/import/github`, {
    method: 'POST',
    body: JSON.stringify(token ? { repo, token } : { repo }),
  })
}

export interface WhoAmI {
  organization: { name: string; slug: string; plan: string | null }
  api_key: {
    name: string
    prefix: string
    permissions: string[]
    last_used_at: string | null
    created_at: string
  }
  ai_usage: { used: number; limit: number | null; month_key: string }
}

export async function whoami(): Promise<WhoAmI> {
  return request('/whoami')
}

export interface ListEntriesFilters {
  status?: 'draft' | 'published'
  type?: string
  limit?: number
}

export async function listEntries(
  projectSlug: string,
  filters: ListEntriesFilters = {},
): Promise<Entry[]> {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.type) params.set('type', filters.type)
  if (filters.limit !== undefined) params.set('limit', String(filters.limit))
  const qs = params.toString()
  return request(`/projects/${projectSlug}/entries${qs ? `?${qs}` : ''}`)
}

/** Full entry including the markdown body — the single-entry GET. */
export interface EntryDetail extends Entry {
  body_markdown: string
  updated_at: string | null
}

export async function getEntry(entryId: string): Promise<EntryDetail> {
  return request(`/entries/${entryId}`)
}

export interface UpdateEntryInput {
  title?: string
  body_markdown?: string
  entry_type?: string | null
  version?: string
  slug?: string
}

export async function updateEntry(
  entryId: string,
  input: UpdateEntryInput,
): Promise<EntryDetail> {
  return request(`/entries/${entryId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export async function deleteEntry(entryId: string): Promise<{ id: string }> {
  return request(`/entries/${entryId}`, { method: 'DELETE' })
}

export interface CreateEntryInput {
  title: string
  body_markdown: string
  entry_type?: string | null
  version?: string
  publish?: boolean
}

export async function createEntry(projectSlug: string, input: CreateEntryInput): Promise<Entry> {
  return request(`/projects/${projectSlug}/entries`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** Entry row returned by the publish route, plus whether the state actually changed. */
export interface PublishStateEntry {
  id: string
  title: string
  slug: string
  published: boolean
  published_at: string | null
  changed: boolean
}

export async function setEntryPublished(
  entryId: string,
  published: boolean,
): Promise<PublishStateEntry> {
  return request(`/entries/${entryId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ published }),
  })
}

// ─── AI summarization ───────────────────────────────────────────────────────

export interface SummarizeInput {
  project_slug?: string
  commits?: string[]
  release_notes?: string
  version?: string
}

export type EntryType =
  | 'feature'
  | 'fix'
  | 'improvement'
  | 'breaking'
  | 'announcement'

export interface AiSummary {
  title: string
  entry_type: EntryType
  body_markdown: string
}

export interface SummarizeResponse {
  summary: AiSummary
  model: string
  usage: {
    used: number
    limit: number | null
    month_key: string
  }
}

export async function summarize(input: SummarizeInput): Promise<SummarizeResponse> {
  return request('/ai-summarize', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

// ─── Manual export ──────────────────────────────────────────────────────────

/**
 * `GET /api/cli/manual/export?project=<slug>`. Returns the body untyped on
 * purpose: the caller validates it against the mirrored server schema
 * (`manual-schema.ts`) before anything is written.
 */
export async function exportManual(projectSlug: string): Promise<unknown> {
  const params = new URLSearchParams({ project: projectSlug })
  return request(`/manual/export?${params.toString()}`)
}
