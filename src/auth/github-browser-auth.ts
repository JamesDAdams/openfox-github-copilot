import type {
  ProviderAccessContext,
  ProviderAuthAdapter,
  ProviderAuthStatus,
  ProviderLoginChallenge,
} from 'openfox/provider'
import type { ProviderCredentialStore } from '../credentials/credential-store.js'
import { GitHubAccountTokenClient, type GitHubCopilotCredential } from './github-account.js'

export interface GitHubCopilotAuthOptions {
  fetcher?: typeof fetch
  now?: () => number
}

export class GitHubCopilotAuthAdapter implements ProviderAuthAdapter {
  readonly id = 'github-copilot-auth'
  private readonly activeLogins = new Map<string, {
    challenge: ProviderLoginChallenge
    completion: Promise<{ credentialRef: string }>
  }>()
  private readonly tokens: GitHubAccountTokenClient
  private readonly nowSec: () => number

  constructor(
    private readonly credentials: ProviderCredentialStore,
    options: GitHubCopilotAuthOptions = {},
  ) {
    const now = options.now ?? Date.now
    this.tokens = new GitHubAccountTokenClient(credentials, options)
    this.nowSec = () => now() / 1000
  }

  async resolveCredential(
    refOrProviderId?: string,
  ): Promise<{ credentialRef: string; credential: GitHubCopilotCredential } | undefined> {
    if (!refOrProviderId) return undefined

    // 1. Direct reference check
    const direct = (await this.credentials.get(refOrProviderId)) as GitHubCopilotCredential | undefined
    if (direct?.oauthToken) {
      return { credentialRef: refOrProviderId, credential: direct }
    }

    // 2. Lookup by providerId among stored credentials
    if (typeof this.credentials.listReferences === 'function') {
      const refs = await this.credentials.listReferences()
      for (const ref of refs) {
        const cred = (await this.credentials.get(ref)) as GitHubCopilotCredential | undefined
        if (cred?.oauthToken && cred.providerId === refOrProviderId) {
          return { credentialRef: ref, credential: cred }
        }
      }
    }

    return undefined
  }

  async refreshCopilotToken(credentialRef: string): Promise<void> {
    const resolved = await this.resolveCredential(credentialRef)
    const ref = resolved?.credentialRef ?? credentialRef
    await this.tokens.refreshCopilotToken(ref)
  }

  async beginLogin(context: { providerId: string }): Promise<{
    challenge: ProviderLoginChallenge
    completion: Promise<{ credentialRef: string }>
  }> {
    const existing = this.activeLogins.get(context.providerId)
    if (existing) {
      const expiresAtMs = new Date(existing.challenge.expiresAt ?? 0).getTime()
      if (expiresAtMs > this.nowSec() * 1000) {
        return existing
      }
      this.activeLogins.delete(context.providerId)
    }

    const { challenge: device, completion: oauthCompletion } = await this.tokens.beginDeviceLogin()

    const challenge: ProviderLoginChallenge = {
      mode: 'device',
      verificationUrl: device.verification_uri,
      userCode: device.user_code,
      instructions: `Please go to ${device.verification_uri} and enter code ${device.user_code} to authorize GitHub Copilot.`,
      expiresAt: new Date(this.nowSec() * 1000 + device.expires_in * 1000).toISOString(),
      intervalSeconds: device.interval || 5,
    }

    const completion = (async () => {
      try {
        const oauthToken = await oauthCompletion
        const username = await this.tokens.fetchUsername(oauthToken)

        // If an existing credential exists for this providerId, update it; otherwise create a new one
        let existingRef: string | undefined
        if (typeof this.credentials.listReferences === 'function') {
          const refs = await this.credentials.listReferences()
          for (const ref of refs) {
            const cred = (await this.credentials.get(ref)) as GitHubCopilotCredential | undefined
            if (cred && cred.providerId === context.providerId) {
              existingRef = ref
              break
            }
          }
        }

        if (existingRef) {
          const cred = (await this.credentials.get(existingRef)) as GitHubCopilotCredential
          await this.credentials.set(existingRef, {
            ...cred,
            providerId: context.providerId,
            oauthToken,
            username,
            copilotToken: undefined,
            copilotExpiresAt: undefined,
          })
          return { credentialRef: existingRef }
        }

        const credentialRef = await this.credentials.create({
          providerId: context.providerId,
          oauthToken,
          username,
        })
        return { credentialRef }
      } finally {
        this.activeLogins.delete(context.providerId)
      }
    })()

    const loginObj = { challenge, completion }
    this.activeLogins.set(context.providerId, loginObj)
    return loginObj
  }

  async getStatus(context: { providerId: string; credentialRef?: string }): Promise<ProviderAuthStatus> {
    const active = this.activeLogins.get(context.providerId)
    if (active) {
      const expiresAtMs = new Date(active.challenge.expiresAt ?? 0).getTime()
      if (expiresAtMs > this.nowSec() * 1000) {
        return { state: 'pending' }
      }
      this.activeLogins.delete(context.providerId)
    }

    const resolved = await this.resolveCredential(context.credentialRef ?? context.providerId)
    if (!resolved) return { state: 'disconnected' }

    const { credentialRef, credential: raw } = resolved

    if (raw.copilotToken && raw.copilotExpiresAt && raw.copilotExpiresAt > this.nowSec()) {
      return { state: 'connected', accountLabel: raw.username }
    }

    try {
      const credential = await this.tokens.getValidCredential(credentialRef)
      return { state: 'connected', accountLabel: credential.username }
    } catch (err) {
      return {
        state: 'expired',
        accountLabel: raw.username,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async getAccessContext(credentialRef: string): Promise<ProviderAccessContext> {
    const resolved = await this.resolveCredential(credentialRef)
    const ref = resolved?.credentialRef ?? credentialRef
    const credential = await this.tokens.getValidCredential(ref)
    return {
      accessToken: credential.copilotToken,
      headers: {
        Authorization: `Bearer ${credential.copilotToken}`,
        'Copilot-Integration-Id': 'vscode-chat',
        'Editor-Version': 'vscode/1.91.0',
        'Editor-Plugin-Version': 'copilot-chat/1.250.0',
        'User-Agent': 'GithubCopilot/1.250.0',
      },
    }
  }

  async getOAuthToken(credentialRef: string): Promise<string> {
    const resolved = await this.resolveCredential(credentialRef)
    const ref = resolved?.credentialRef ?? credentialRef
    const credential = (await this.credentials.get(ref)) as GitHubCopilotCredential | undefined
    if (!credential?.oauthToken) throw new Error('OAuth token not found')
    return credential.oauthToken
  }

  async invalidateCopilotToken(credentialRef: string, currentToken?: string): Promise<void> {
    const resolved = await this.resolveCredential(credentialRef)
    const ref = resolved?.credentialRef ?? credentialRef
    await this.tokens.invalidateCopilotToken(ref, currentToken)
  }

  async logout(credentialRef: string): Promise<void> {
    const resolved = await this.resolveCredential(credentialRef)
    const ref = resolved?.credentialRef ?? credentialRef
    await this.credentials.delete(ref)
  }

  async deleteProvider(providerId: string): Promise<void> {
    this.activeLogins.delete(providerId)
    if (typeof this.credentials.listReferences !== 'function') return
    const refs = await this.credentials.listReferences()
    for (const ref of refs) {
      const cred = (await this.credentials.get(ref)) as (GitHubCopilotCredential & { providerId?: string }) | undefined
      if (cred?.providerId === providerId) {
        await this.credentials.delete(ref)
      }
    }
  }
}
