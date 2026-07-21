import type { ProviderCredentialStore } from '../credentials/credential-store.js'

export interface GitHubCopilotCredential {
  oauthToken: string
  username: string
  copilotToken?: string
  copilotExpiresAt?: number
}

interface GitHubDeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface GitHubAccessTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface GitHubCopilotTokenResponse {
  token: string
  expires_at: number | string
}

interface GitHubUserResponse {
  login?: string
}

export interface GitHubAccountTokenClientOptions {
  fetcher?: typeof fetch
  now?: () => number
  refreshMarginSeconds?: number
}

export class GitHubAccountTokenClient {
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly refreshMarginSeconds: number
  private readonly refreshes = new Map<string, Promise<GitHubCopilotCredential>>()
  private readonly clientId = 'Iv1.b507a08c87ecfe98'
  constructor(
    private readonly credentials: ProviderCredentialStore,
    options: GitHubAccountTokenClientOptions = {},
  ) {
    this.request = options.fetcher ?? fetch
    this.now = options.now ?? Date.now
    this.refreshMarginSeconds = options.refreshMarginSeconds ?? 300
  }

  async beginDeviceLogin(): Promise<{
    challenge: GitHubDeviceCodeResponse
    completion: Promise<string>
  }> {
    const res = await this.request('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'OpenFox',
      },
      body: JSON.stringify({ client_id: this.clientId, scope: 'read:user' }),
    })

    if (!res.ok) throw new Error(`Failed to request GitHub device code: ${res.statusText}`)

    const data = (await res.json()) as GitHubDeviceCodeResponse
    const intervalMs = (data.interval || 5) * 1000
    const expiresAt = this.now() + data.expires_in * 1000

    const completion = this.pollAccessToken(data.device_code, data.interval, intervalMs, expiresAt)

    return { challenge: data, completion }
  }

  private async pollAccessToken(
    deviceCode: string,
    interval: number,
    intervalMs: number,
    expiresAt: number,
  ): Promise<string> {
    while (this.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))

      const res = await this.request('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'OpenFox',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })

      if (!res.ok) continue

      const data = (await res.json()) as GitHubAccessTokenResponse
      if (data.access_token) return data.access_token
      if (data.error === 'authorization_pending') continue
      if (data.error === 'slow_down') {
        intervalMs += 5000
        continue
      }
      throw new Error(data.error_description || data.error || 'Authorization failed')
    }

    throw new Error('GitHub device code authorization expired')
  }

  async fetchUsername(oauthToken: string): Promise<string> {
    const res = await this.request('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${oauthToken}`, 'User-Agent': 'OpenFox' },
    })
    if (!res.ok) return 'GitHub User'
    const data = (await res.json()) as GitHubUserResponse
    return data.login ?? 'GitHub User'
  }

  async fetchCopilotToken(oauthToken: string): Promise<{ token: string; expiresAt: number }> {
    const res = await this.request('https://api.github.com/copilot_internal/v2/token', {
      headers: { Authorization: `token ${oauthToken}`, 'User-Agent': 'GithubCopilot/1.250.0' },
    })

    if (!res.ok) throw new Error(`Failed to fetch Copilot token: ${res.statusText} (${res.status})`)

    const data = (await res.json()) as GitHubCopilotTokenResponse
    if (!data.token) throw new Error('Copilot token response is empty')

    const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : Math.floor(new Date(data.expires_at).getTime() / 1000)
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error('Copilot token has invalid expiration')

    return { token: data.token, expiresAt }
  }

  async refreshCopilotToken(reference: string): Promise<GitHubCopilotCredential> {
    const existing = this.refreshes.get(reference)
    if (existing) return existing

    const promise = (async () => {
      try {
        const credential = (await this.credentials.get(reference)) as GitHubCopilotCredential | undefined
        if (!credential) throw new Error('GitHub Copilot credential not found')

        const tokenData = await this.fetchCopilotToken(credential.oauthToken)
        credential.copilotToken = tokenData.token
        credential.copilotExpiresAt = tokenData.expiresAt
        await this.credentials.set(reference, credential)
        return credential
      } finally {
        this.refreshes.delete(reference)
      }
    })()

    this.refreshes.set(reference, promise)
    return promise
  }

  async getValidCredential(reference: string): Promise<GitHubCopilotCredential> {
    const credential = (await this.credentials.get(reference)) as GitHubCopilotCredential | undefined
    if (!credential) throw new Error('GitHub Copilot credential not found')

    const isExpired = !credential.copilotExpiresAt || this.now() / 1000 >= credential.copilotExpiresAt - this.refreshMarginSeconds
    if (credential.copilotToken && !isExpired) return credential

    return this.refreshCopilotToken(reference)
  }

  async invalidateCopilotToken(reference: string, currentToken?: string): Promise<void> {
    const credential = (await this.credentials.get(reference)) as GitHubCopilotCredential | undefined
    if (!credential) return
    if (currentToken !== undefined && credential.copilotToken !== currentToken) return
    credential.copilotToken = undefined
    credential.copilotExpiresAt = undefined
    await this.credentials.set(reference, credential)
  }
}
