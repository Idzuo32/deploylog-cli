import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock at the boundary: config (key/url) and global fetch.
const getApiKey = vi.fn()
const getApiUrl = vi.fn()
vi.mock('./config.js', () => ({
  getApiKey: () => getApiKey(),
  getApiUrl: () => getApiUrl(),
}))

import { listProjects, createEntry, exportManual, ApiError } from './api.js'

function fetchReturning(status: number, body: string, ok?: boolean) {
  return vi.fn().mockResolvedValue({
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: () => Promise.resolve(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getApiKey.mockReturnValue('dk_testkey')
  getApiUrl.mockReturnValue('https://deploylog.dev')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request() auth', () => {
  it('throws when no API key is configured', async () => {
    getApiKey.mockReturnValue(undefined)
    await expect(listProjects()).rejects.toThrow(/Not authenticated/)
  })

  it('sends a Bearer token to the /api/cli URL', async () => {
    const fetchMock = fetchReturning(200, JSON.stringify({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await listProjects()

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://deploylog.dev/api/cli/projects')
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer dk_testkey')
  })
})

describe('request() response contract', () => {
  it('returns data on a well-formed 200', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, JSON.stringify({ data: [{ id: '1' }] })))
    await expect(listProjects()).resolves.toEqual([{ id: '1' }])
  })

  it('throws ApiError with code + message on a JSON error response', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(401, JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad key' } })),
    )
    await expect(listProjects()).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'bad key',
    })
  })

  it('throws ApiError with a fallback on a non-JSON error body (CDN 502)', async () => {
    vi.stubGlobal('fetch', fetchReturning(502, '<html>Bad Gateway</html>'))
    const err = await listProjects().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toMatch(/Request failed \(502\)/)
  })

  it('rejects a 200 with a non-JSON body (INVALID_RESPONSE)', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, 'not json'))
    await expect(listProjects()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects a 200 whose JSON is missing the data field', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, JSON.stringify({ ok: true })))
    await expect(listProjects()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})

describe('createEntry()', () => {
  it('POSTs the body and returns the created entry', async () => {
    const fetchMock = fetchReturning(200, JSON.stringify({ data: { id: 'e1', title: 'x' } }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await createEntry('proj', { title: 'x', body_markdown: 'b' })

    expect(res).toEqual({ id: 'e1', title: 'x' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://deploylog.dev/api/cli/projects/proj/entries')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string)).toEqual({ title: 'x', body_markdown: 'b' })
  })
})

describe('exportManual()', () => {
  it('GETs /api/cli/manual/export?project=<slug> and returns the raw data', async () => {
    const fetchMock = fetchReturning(200, JSON.stringify({ data: { project: 'my app' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(exportManual('my app')).resolves.toEqual({ project: 'my app' })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://deploylog.dev/api/cli/manual/export?project=my+app')
    expect(opts.method ?? 'GET').toBe('GET')
  })
})
