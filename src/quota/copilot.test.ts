import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GitHubCopilotQuotaProvider } from './copilot.js'
import { MemoryProviderCredentialStore } from '../credentials/credential-store.js'
import type { GitHubCopilotCredential } from '../auth/github-account.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

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
    delete process.env.GITHUB_COPILOT_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.COPILOT_API_KEY
    const pendingKey = Symbol.for('openfox.pendingQuotaProviders')
    const globalQuotaKey = Symbol.for('openfox.quotaManager')
    delete (globalThis as any)[pendingKey]
    delete (globalThis as any)[globalQuotaKey]
  })

  afterEach(() => {
    mockFetch.mockReset()
  })

  it('returns empty metrics when no credentials and no env var', async () => {
    const store = makeStore()
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.id).toBe('github-copilot')
    expect(quota.name).toBe('GitHub Copilot')
    expect(quota.metrics).toEqual([])
  })

  it('returns default metrics when credentials exist without live API response', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.metrics).toHaveLength(2)
    expect(quota.metrics[0]).toMatchObject({ kind: 'windowed', label: 'Premium requests', used: 0, limit: 500 })
    expect(quota.metrics[1]).toMatchObject({ kind: 'windowed', label: 'Chat', used: 0, limit: 1000 })
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
    expect(metric?.kind).toBe('windowed')
    if (metric?.kind !== 'windowed') throw new Error('expected windowed')
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
    if (m?.kind !== 'windowed') throw new Error('expected windowed')
    expect(m.used).toBe(20000 - 8598)
  })

  it('falls back to default metrics on 401 without crashing', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
    const provider = makeProvider(store)
    const quota = await provider.getQuota()
    expect(quota.metrics).toHaveLength(2)
  })

  it('uses the cache within the TTL and does not refetch', async () => {
    const store = makeStore()
    await addCredential(store)
    mockFetch.mockResolvedValue({
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
    if (m?.kind !== 'windowed') throw new Error('expected windowed')
    expect(m.used).toBe(20000 - 5000)
  })

  it('discovers providers from config.json, credential store, and env variables', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-test-'))
    const configPath = path.join(tempDir, 'config.json')
    const store = makeStore()
    const ref = await addCredential(store, { username: 'octocat', oauthToken: 'ghu_store_token' })

    await fs.writeFile(
      configPath,
      JSON.stringify({
        providers: [
          {
            id: 'copilot-business',
            name: 'GitHub Copilot Business',
            preset: 'github-copilot',
            apiKey: 'ghu_config_key',
          },
          {
            id: 'copilot-user',
            name: 'GitHub Copilot User',
            preset: 'github-copilot',
            credentialRef: ref,
          },
        ],
      }),
    )

    process.env.GITHUB_COPILOT_TOKEN = 'ghu_env_token'

    const provider = makeProvider(store, { configDirectory: tempDir })
    const accounts = await provider.discoverProviders()

    expect(accounts).toHaveLength(3)
    expect(accounts.find((a) => a.id === 'copilot-business')).toBeDefined()
    expect(accounts.find((a) => a.id === `copilot-cred-${ref}`)).toBeDefined()
    expect(accounts.find((a) => a.id === 'copilot-env')).toBeDefined()

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('registers with openfox-quota pending providers and global quota manager', async () => {
    const store = makeStore()
    await addCredential(store)

    const submittedSources: any[] = []
    const globalQuotaManager = {
      registerProvider: vi.fn(),
      submitSource: (src: any) => submittedSources.push(src),
      clearPushedSources: vi.fn(),
    }
    const globalQuotaKey = Symbol.for('openfox.quotaManager')
    const pendingKey = Symbol.for('openfox.pendingQuotaProviders')
    ;(globalThis as any)[globalQuotaKey] = globalQuotaManager

    const provider = makeProvider(store)
    await provider.registerProviders()

    const pending = (globalThis as any)[pendingKey]
    expect(pending).toContain(provider)
    expect(globalQuotaManager.registerProvider).toHaveBeenCalledWith(provider)
  })
})
