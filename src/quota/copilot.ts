import type { ProviderCredentialStore } from '../credentials/credential-store.js'
import type { GitHubCopilotCredential } from '../auth/github-account.js'
import type { QuotaProvider, QuotaSource, QuotaMetric } from './contract.js'

const COPILOT_USER_API = 'https://api.github.com/copilot_internal/user'
const CACHE_TTL_MS = 60_000

const SNAPSHOT_LABELS: Record<string, string> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat',
  completions: 'Completions',
}

interface QuotaSnapshot {
  quota_id?: string
  entitlement?: number
  quota_remaining?: number
  remaining?: number
  unlimited?: boolean
  quota_reset_date_utc?: string
}

interface CopilotUserResponse {
  quota_snapshots?: Record<string, QuotaSnapshot>
  quota_reset_date_utc?: string
}

export interface GitHubCopilotQuotaProviderOptions {
  fetcher?: typeof fetch
  now?: () => number
}

export class GitHubCopilotQuotaProvider implements QuotaProvider {
  readonly id = 'github-copilot'
  readonly name = 'GitHub Copilot'

  private readonly request: typeof fetch
  private readonly now: () => number
  private cachedMetrics: QuotaMetric[] | null = null
  private cachedName: string | null = null
  private cachedAt = 0

  constructor(
    private readonly credentials: ProviderCredentialStore,
    options: GitHubCopilotQuotaProviderOptions = {},
  ) {
    this.request = options.fetcher ?? fetch
    this.now = options.now ?? Date.now
  }

  async getQuota(): Promise<QuotaSource> {
    const source: QuotaSource = {
      id: this.id,
      name: this.name,
      metrics: [],
    }

    try {
      if (this.cachedMetrics && this.now() - this.cachedAt < CACHE_TTL_MS) {
        return { ...source, name: this.cachedName ?? source.name, metrics: this.cachedMetrics }
      }

      const references = await this.credentials.listReferences()
      if (references.length === 0) {
        return source
      }

      let lastError: Error | undefined
      for (const reference of references) {
        const credential = (await this.credentials.get(reference)) as GitHubCopilotCredential | undefined
        if (!credential?.oauthToken) continue

        try {
          const data = await this.fetchSnapshots(credential.oauthToken)
          const metrics = this.toMetrics(data)

          if (credential.username) {
            source.name = `GitHub Copilot (${credential.username})`
          }
          this.cachedMetrics = metrics
          this.cachedName = source.name
          this.cachedAt = this.now()
          return { ...source, metrics }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
        }
      }

      if (lastError) throw lastError
      return source
    } catch (error) {
      console.warn('GitHub Copilot quota unavailable', {
        error: error instanceof Error ? error.message : String(error),
      })
      if (this.cachedMetrics) return { ...source, metrics: this.cachedMetrics }
      return {
        ...source,
        metrics: [{ kind: 'token-balance', label: 'Quota unavailable', total: 0, remaining: 0 }],
      }
    }
  }

  private async fetchSnapshots(oauthToken: string): Promise<CopilotUserResponse> {
    const res = await this.request(COPILOT_USER_API, {
      headers: {
        Authorization: `token ${oauthToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'GitHubCopilotChat/0.22.2',
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      throw new Error(`copilot_internal/user responded ${res.status}`)
    }
    const data = (await res.json()) as CopilotUserResponse
    return data
  }

  private toMetrics(data: CopilotUserResponse): QuotaMetric[] {
    const snapshots = data.quota_snapshots ?? {}
    const resetsAt = data.quota_reset_date_utc
    const metrics: QuotaMetric[] = []
    for (const [key, snapshot] of Object.entries(snapshots)) {
      if (snapshot.unlimited) continue
      const limit = Math.round(snapshot.entitlement ?? 0)
      const remaining = Math.round(snapshot.remaining ?? snapshot.quota_remaining ?? 0)
      const used = limit - remaining
      metrics.push({
        kind: 'windowed',
        label: SNAPSHOT_LABELS[key] ?? key,
        used,
        limit,
        window: 'month',
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
    return metrics
  }
}
