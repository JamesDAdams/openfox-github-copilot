import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GitHubCopilotQuotaProvider } from './copilot.js'
import { MemoryProviderCredentialStore } from '../credentials/credential-store.js'
import type { GitHubCopilotCredential } from '../auth/github-account.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeStore(): MemoryProviderCredentialStore {
  return new MemoryProviderCredentialStore()
}

async function addCredential(store: MemoryProviderCredentialStore, overrides: Partial<GitHubCopilotCredential> = {}) {
  return store.create({
    oauthToken: 'test-oauth-token',
    username: 'test-user',
    ...overrides,
  })
}

function makeProvider(store: MemoryProviderCredentialStore, options: any = {}) {
  return new GitHubCopilotQuotaProvider(store, { fetcher: mockFetch as any, ...options })
}

const SNAPSHOT_RESPONSE = {
  quota_snapshots: {
    premium_interactions: {
      quota_id: 'premium_interactions',
      entitlement: 20000,
      quota_remaining: 8598.2,
      remaining: 8598,
      unlimited: false,
      timestamp_utc: '2026-08-28T00:26:30.866-07:00',
    },
    chat: {
      quota_id: 'chat',
      entitlement: 0,
      quota_remaining: 0,
      remaining: 0,
      unlimited: true,
      timestamp_utc: '2026-08-28T00:26:30.866-07:00',
    },
    completions: {
      quota_id: 'completions',
      entitlement: 0,
      quota_remaining: 0,
      remaining: 0,
      unlimited: true,
      timestamp_utc: '2026-08-28T00:26:30.866-07:00',
    },
  },
  quota_reset_date_utc: '2026-09-01T00:00:00.000Z',
}

describe('GitHubCopilotQuotaProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    mockFetch.mockReset()
  })

  it('returns empty metrics when no credential is stored', async () => {
    const store = makeStore()
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.id).toBe('github-copilot')
    expect(quota.name).toBe('GitHub Copilot')
    expect(quota.metrics).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('emits one windowed metric per non-unlimited snapshot', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SNAPSHOT_RESPONSE,
    })
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.metrics).toHaveLength(1)
    const metric = quota.metrics[0]
    expect(metric.kind).toBe('windowed')
    if (metric.kind !== 'windowed') throw new Error('expected windowed')
    expect(metric.label).toBe('Premium requests')
    expect(metric.limit).toBe(20000)
    expect(metric.used).toBe(20000 - 8598)
    expect(metric.window).toBe('month')
    expect(metric.resetsAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('calls copilot_internal/user with the OAuth token', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SNAPSHOT_RESPONSE,
    })
    const provider = makeProvider(store)
    await provider.getQuota()
    const call = mockFetch.mock.calls.find((c: any) => c[0] === 'https://api.github.com/copilot_internal/user')
    expect(call).toBeDefined()
    expect(call![1].headers.Authorization).toBe('token test-oauth-token')
  })

  it('includes the account username in the source name', async () => {
    const store = makeStore()
    await addCredential(store, { username: 'octocat' })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SNAPSHOT_RESPONSE,
    })
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.name).toBe('GitHub Copilot (octocat)')
  })

  it('skips unlimited snapshots', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quota_snapshots: {
          chat: { entitlement: 0, quota_remaining: 0, unlimited: true },
          completions: { entitlement: 0, quota_remaining: 0, unlimited: true },
        },
      }),
    })
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.metrics).toEqual([])
  })

  it('returns last-good source when the fetch fails and a cache exists', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SNAPSHOT_RESPONSE,
    })
    const provider = makeProvider(store, { now: () => 1000 })
    const first = await provider.getQuota()
    expect(first.metrics).toHaveLength(1)

    mockFetch.mockRejectedValueOnce(new Error('network error'))
    const second = await provider.getQuota()
    expect(second.metrics).toHaveLength(1)
    const m = second.metrics[0]
    if (m.kind !== 'windowed') throw new Error('expected windowed')
    expect(m.used).toBe(20000 - 8598)
  })

  it('surfaces a "Quota unavailable" metric when fetch fails and no cache exists (never throws)', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockRejectedValue(new Error('network error'))
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.id).toBe('github-copilot')
    expect(quota.metrics).toHaveLength(1)
    const m = quota.metrics[0]
    if (m.kind !== 'token-balance') throw new Error('expected token-balance')
    expect(m.label).toBe('Quota unavailable')
    expect(m.total).toBe(0)
    expect(m.remaining).toBe(0)
  })

  it('surfaces a "Quota unavailable" metric on a 401 (expired credential)', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.metrics).toHaveLength(1)
    const m = quota.metrics[0]
    if (m.kind !== 'token-balance') throw new Error('expected token-balance')
    expect(m.label).toBe('Quota unavailable')
  })

  it('returns empty metrics when the credential has no OAuth token (no fetch)', async () => {
    const store = makeStore()
    await addCredential(store, { oauthToken: undefined })
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.metrics).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('uses the cache within the TTL and does not refetch', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SNAPSHOT_RESPONSE,
    })
    let now = 1000
    const provider = makeProvider(store, { now: () => now })
    await provider.getQuota()
    now = 1000 + 30_000
    await provider.getQuota()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('refetches after the TTL expires', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => SNAPSHOT_RESPONSE,
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quota_snapshots: {
          premium_interactions: { entitlement: 20000, quota_remaining: 5000, remaining: 5000, unlimited: false },
        },
      }),
    })
    let now = 1000
    const provider = makeProvider(store, { now: () => now })
    await provider.getQuota()
    now = 1000 + 61_000
    const quota = await provider.getQuota()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const m = quota.metrics[0]
    if (m.kind !== 'windowed') throw new Error('expected windowed')
    expect(m.used).toBe(20000 - 5000)
  })
})
