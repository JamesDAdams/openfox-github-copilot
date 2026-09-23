import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderCredentialStore } from '../credentials/credential-store.js'
import type { GitHubCopilotCredential } from '../auth/github-account.js'
import type {
  QuotaProvider,
  QuotaSource,
  QuotaMetric,
  PluginRegistry,
} from './contract.js'

const COPILOT_USER_API = 'https://api.github.com/copilot_internal/user'
const CACHE_TTL_MS = 60_000

const GLOBAL_QUOTA_KEY = Symbol.for('openfox.quotaManager')
const PENDING_PROVIDERS_KEY = Symbol.for('openfox.pendingQuotaProviders')

const SNAPSHOT_LABELS: Record<string, string> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat',
  completions: 'Completions',
}

export interface GitHubCopilotProviderAccount {
  id: string
  name: string
  oauthToken?: string
  apiKey?: string
  url?: string
  sourceId: string
  username?: string
  isDefault?: boolean
}

export interface GitHubCopilotQuotaProviderOptions {
  fetcher?: typeof fetch
  now?: () => number
  configDirectory?: string
}

interface QuotaSnapshot {
  quota_id?: string
  entitlement?: number
  quota_remaining?: number
  remaining?: number
  unlimited?: boolean
  quota_reset_date_utc?: string
  timestamp_utc?: string
  used?: number
  limit?: number
  displayName?: string
  label?: string
  window?: 'hour' | 'day' | 'week' | 'month'
}

interface CopilotUserResponse {
  quota_snapshots?: Record<string, QuotaSnapshot>
  quota_reset_date_utc?: string
  quotas?: Record<string, any>
  usage?: Record<string, any>
}

interface CacheEntry {
  metrics: QuotaMetric[]
  name: string
  cachedAt: number
}

export class GitHubCopilotQuotaProvider implements QuotaProvider {
  readonly id = 'github-copilot'
  readonly name = 'GitHub Copilot'

  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly configDirectory?: string
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly credentials: ProviderCredentialStore,
    options: GitHubCopilotQuotaProviderOptions = {},
  ) {
    this.request = options.fetcher ?? fetch
    this.now = options.now ?? Date.now
    this.configDirectory = options.configDirectory
  }

  /**
   * Discover all GitHub Copilot provider accounts configured in OpenFox
   * (config.json providers, credential store, environment variables).
   */
  async discoverProviders(): Promise<GitHubCopilotProviderAccount[]> {
    const discovered: GitHubCopilotProviderAccount[] = []
    const seenTokens = new Set<string>()
    const seenIds = new Set<string>()
    let activeCredRefs: Set<string> | null = null
    let hasConfigProviders = false

    // 1. Scan OpenFox config.json in configDirectory
    if (this.configDirectory) {
      try {
        const configPath = join(this.configDirectory, 'config.json')
        const raw = await readFile(configPath, 'utf8')
        const data = JSON.parse(raw)
        if (Array.isArray(data.providers)) {
          hasConfigProviders = true
          activeCredRefs = new Set()
          for (const p of data.providers) {
            if (!p || typeof p !== 'object') continue
            const backend = String(p.backend || '').toLowerCase()
            const transport = String(p.transport || p.transportAdapter || '').toLowerCase()
            const preset = String(p.preset || '').toLowerCase()
            const authAdapter = String(p.authAdapter || '').toLowerCase()

            const isCopilot =
              preset === 'github-copilot' ||
              preset === 'copilot' ||
              backend === 'github-copilot' ||
              backend === 'copilot' ||
              transport === 'github-copilot-transport' ||
              transport === 'copilot-transport' ||
              authAdapter === 'github-copilot-auth'

            if (isCopilot && p.credentialRef) {
              activeCredRefs.add(String(p.credentialRef))
            }
            if (isCopilot && p.apiKey && !p.credentialRef && !seenIds.has(String(p.id))) {
              seenIds.add(String(p.id))
              const token = String(p.apiKey)
              seenTokens.add(token)
              discovered.push({
                id: String(p.id),
                name: String(p.name || p.id || 'GitHub Copilot'),
                apiKey: token,
                oauthToken: token,
                sourceId: String(p.id),
              })
            }
          }
        }
      } catch {
        // Ignore file read / parse error
      }
    }

    // 2. Scan plugin credential store (only include credentials that belong to active providers, or if no config providers list)
    try {
      if (typeof this.credentials.listReferences === 'function') {
        const references = await this.credentials.listReferences()
        for (const ref of references) {
          if (hasConfigProviders && activeCredRefs && !activeCredRefs.has(ref)) {
            // Credential belongs to a deleted/inactive provider
            continue
          }
          const cred = (await this.credentials.get(ref)) as GitHubCopilotCredential | undefined
          if (cred?.oauthToken && !seenTokens.has(cred.oauthToken)) {
            seenTokens.add(cred.oauthToken)
            const credId = `copilot-cred-${ref}`
            const name = cred.username ? `GitHub Copilot (${cred.username})` : `GitHub Copilot (${ref})`
            if (!seenIds.has(credId)) {
              seenIds.add(credId)
              discovered.push({
                id: credId,
                name,
                oauthToken: cred.oauthToken,
                username: cred.username,
                sourceId: credId,
              })
            }
          }
        }
      }
    } catch {
      // Ignore credential read error
    }

    // 3. Scan environment variables
    const envToken = process.env.GITHUB_COPILOT_TOKEN || process.env.GITHUB_TOKEN || process.env.COPILOT_API_KEY
    if (envToken && !seenTokens.has(envToken)) {
      seenTokens.add(envToken)
      const envId = 'copilot-env'
      if (!seenIds.has(envId)) {
        seenIds.add(envId)
        discovered.push({
          id: envId,
          name: 'GitHub Copilot (Env)',
          oauthToken: envToken,
          sourceId: envId,
        })
      }
    }

    return discovered
  }

  /**
   * Fetch quota metrics for a single provider account.
   */
  async getQuotaForAccount(account: GitHubCopilotProviderAccount): Promise<QuotaSource> {
    const source: QuotaSource = {
      id: account.sourceId,
      name: account.name,
      metrics: [],
    }

    try {
      const cached = this.cache.get(account.id)
      if (cached && this.now() - cached.cachedAt < CACHE_TTL_MS) {
        return {
          ...source,
          name: cached.name || source.name,
          metrics: cached.metrics,
        }
      }

      let metrics: QuotaMetric[] = []
      let fetchedSuccessfully = false
      const token = account.oauthToken || account.apiKey

      // 1. Try direct GitHub Copilot endpoint
      if (token) {
        try {
          const authHeader = token.startsWith('ghu_') || token.startsWith('ghp_') || token.startsWith('gho_') || !token.startsWith('Bearer ')
            ? (token.startsWith('token ') || token.startsWith('Bearer ') ? token : `token ${token}`)
            : token

          const res = await this.request(COPILOT_USER_API, {
            headers: {
              Authorization: authHeader,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'GitHubCopilotChat/0.22.2',
              'Editor-Version': 'vscode/1.93.0',
              'Editor-Plugin-Version': 'copilot-chat/0.22.2',
            },
            signal: AbortSignal.timeout(5000),
          })

          if (res.ok) {
            const data = (await res.json()) as CopilotUserResponse
            metrics = this.parseUsageResponse(data)
            fetchedSuccessfully = true
          }
        } catch {
          // Direct endpoint failed
        }
      }

      // 2. Fallback to default metrics if still empty and not fetched successfully
      if (!fetchedSuccessfully && metrics.length === 0) {
        metrics = this.getDefaultMetrics()
      }

      this.cache.set(account.id, {
        metrics,
        name: source.name,
        cachedAt: this.now(),
      })

      return { ...source, metrics }
    } catch (error) {
      console.warn(`GitHub Copilot quota unavailable (${account.name})`, {
        error: error instanceof Error ? error.message : String(error),
      })
      const cached = this.cache.get(account.id)
      if (cached) {
        return { ...source, name: cached.name, metrics: cached.metrics }
      }
      return {
        ...source,
        metrics: this.getDefaultMetrics(),
      }
    }
  }

  /**
   * Fetch and aggregate quota sources across all discovered GitHub Copilot provider accounts.
   */
  async getAllQuotaSources(): Promise<QuotaSource[]> {
    const accounts = await this.discoverProviders()
    const sources = await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))
    return sources
  }

  /**
   * Main getQuota method implementing QuotaProvider contract.
   * Submits all discovered sources to openfox-quota manager and returns primary source.
   */
  async getQuota(): Promise<QuotaSource> {
    const accounts = await this.discoverProviders()
    if (accounts.length === 0) {
      this.submitSourcesToGlobalManager(accounts, [])
      return { id: this.id, name: this.name, metrics: [] }
    }
    const sources = await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))

    // Submit all sources in openfox-quota
    this.submitSourcesToGlobalManager(accounts, sources)

    const firstWithMetrics = sources.find((s) => s.metrics && s.metrics.length > 0)
    if (firstWithMetrics) {
      return firstWithMetrics
    }
    return sources[0] ?? { id: this.id, name: this.name, metrics: [] }
  }

  /**
   * Synchronize quota sources with openfox-quota plugin.
   */
  async syncQuota(registry?: PluginRegistry): Promise<{ success: boolean; sources: QuotaSource[] }> {
    this.cache.clear()
    const accounts = await this.discoverProviders()
    const sources = accounts.length > 0
      ? await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))
      : []

    this.submitSourcesToGlobalManager(accounts, sources)

    if (registry && typeof registry.registerQuotaProvider === 'function') {
      await this.registerProviders(registry)
    }

    return { success: true, sources }
  }

  /**
   * Register with openfox-quota (via pending list, global manager, registry).
   */
  async registerProviders(registry?: PluginRegistry): Promise<void> {
    // 1. Put in pending list so openfox-quota picks it up whenever it loads
    const pending = ((globalThis as any)[PENDING_PROVIDERS_KEY] ??= [])
    if (!pending.some((p: any) => p && p.id === this.id)) {
      pending.push(this)
    }

    // 2. Register with openfox-quota via global quota manager if present
    const globalMgr = (globalThis as any)[GLOBAL_QUOTA_KEY]
    if (globalMgr && typeof globalMgr.registerProvider === 'function') {
      globalMgr.registerProvider(this)
    }

    // 3. Register via registry.registerQuotaProvider if present
    if (registry && typeof registry.registerQuotaProvider === 'function') {
      registry.registerQuotaProvider(this)
    }

    // 4. Eagerly sync quota sources with openfox-quota so data appears immediately without reload
    void this.getQuota().catch(() => {})
  }

  private submitSourcesToGlobalManager(
    accounts: GitHubCopilotProviderAccount[],
    sources: QuotaSource[],
  ): void {
    const globalMgr = (globalThis as any)[GLOBAL_QUOTA_KEY]
    if (!globalMgr) return

    if (typeof globalMgr.clearPushedSources === 'function') {
      globalMgr.clearPushedSources((id: string) => id.startsWith('copilot') || id.startsWith('github-copilot'))
    } else if (globalMgr.pushedSources instanceof Map) {
      for (const key of Array.from(globalMgr.pushedSources.keys())) {
        if (typeof key === 'string' && (key.startsWith('copilot') || key.startsWith('github-copilot'))) {
          globalMgr.pushedSources.delete(key)
        }
      }
    }

    if (accounts.length > 1) {
      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i]
        const src = sources[i]
        if (!acc || !src) continue
        if (src.id === this.id) continue

        if (typeof globalMgr.submitSource === 'function') {
          globalMgr.submitSource(src)
        }
      }
    }
  }

  private parseUsageResponse(data: any): QuotaMetric[] {
    const metrics: QuotaMetric[] = []
    if (!data || typeof data !== 'object') return metrics

    const snapshots = data.quota_snapshots || data.quotas || data.usage || data
    const resetsAt = data.quota_reset_date_utc || data.resetsAt || data.resetAt || data.resets_at

    for (const [key, raw] of Object.entries(snapshots as Record<string, any>)) {
      if (!raw || typeof raw !== 'object') continue
      if (raw.unlimited) continue

      const label =
        SNAPSHOT_LABELS[key] ||
        raw.displayName ||
        raw.label ||
        (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '))

      const total =
        typeof raw.entitlement === 'number'
          ? raw.entitlement
          : typeof raw.total === 'number'
            ? raw.total
            : typeof raw.limit === 'number'
              ? raw.limit
              : typeof raw.quotaTotal === 'number'
                ? raw.quotaTotal
                : undefined

      const remainingVal =
        typeof raw.remaining === 'number'
          ? raw.remaining
          : typeof raw.quota_remaining === 'number'
            ? raw.quota_remaining
            : undefined

      const usedVal =
        typeof raw.used === 'number'
          ? raw.used
          : typeof raw.quotaUsed === 'number'
            ? raw.quotaUsed
            : typeof raw.consumed === 'number'
              ? raw.consumed
              : total !== undefined && remainingVal !== undefined
                ? Math.max(0, total - remainingVal)
                : typeof raw.percent === 'number' && total !== undefined
                  ? Math.round((raw.percent / 100) * total)
                  : 0

      const limit = total !== undefined ? Math.round(total) : 500
      const used = Math.round(usedVal)

      let window: 'hour' | 'day' | 'week' | 'month' = 'month'
      const lowerKey = (key + ' ' + (raw.window || '') + ' ' + (raw.period || '')).toLowerCase()
      if (lowerKey.includes('hour')) {
        window = 'hour'
      } else if (lowerKey.includes('day')) {
        window = 'day'
      } else if (lowerKey.includes('week')) {
        window = 'week'
      } else {
        window = 'month'
      }

      const itemReset = raw.quota_reset_date_utc || raw.resetsAt || raw.resetAt || resetsAt

      metrics.push({
        kind: 'windowed',
        label,
        used,
        limit,
        window,
        ...(itemReset ? { resetsAt: String(itemReset) } : {}),
      })
    }

    return metrics
  }

  private getDefaultMetrics(): QuotaMetric[] {
    return [
      {
        kind: 'windowed',
        label: 'Premium requests',
        used: 0,
        limit: 500,
        window: 'month',
      },
      {
        kind: 'windowed',
        label: 'Chat',
        used: 0,
        limit: 1000,
        window: 'month',
      },
    ]
  }
}
