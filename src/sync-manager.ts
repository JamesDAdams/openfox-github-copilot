import type { ModelConfig } from 'openfox/provider'
import type { GitHubCopilotAuthAdapter } from './auth/github-browser-auth.js'
import type { ProviderCredentialStore } from './credentials/credential-store.js'
import type { GitHubCopilotTransportAdapter, ModelPricing } from './transport/copilot.js'
import { DEFAULT_SETTINGS, type GitHubCopilotPluginSettings } from './settings.js'

export interface SyncManagerOptions {
  auth: GitHubCopilotAuthAdapter
  credentials: ProviderCredentialStore
  transport: GitHubCopilotTransportAdapter
  notify?: (notification: { title: string; body: string }) => void
  settings?: GitHubCopilotPluginSettings
  modelsRefreshIntervalMs?: number
  pricesRefreshIntervalMs?: number
}

export interface PriceDiff {
  modelId: string
  oldPricing?: ModelPricing
  newPricing?: ModelPricing
  changes: string[]
}

export class GitHubCopilotSyncManager {
  private readonly auth: GitHubCopilotAuthAdapter
  private readonly credentials: ProviderCredentialStore
  private readonly transport: GitHubCopilotTransportAdapter
  private notifier?: (notification: { title: string; body: string }) => void
  private settings: GitHubCopilotPluginSettings

  private customModelsIntervalMs?: number
  private customPricesIntervalMs?: number

  private modelsTimer: NodeJS.Timeout | null = null
  private pricesTimer: NodeJS.Timeout | null = null

  private knownModelIds = new Set<string>()
  private knownModelPrices = new Map<string, ModelPricing>()
  private isInitialModelsLoad = true
  private isInitialPricesLoad = true

  private lastDiscoveredModels: string[] = []
  private lastRemovedModels: string[] = []
  private lastPriceDiffs: PriceDiff[] = []

  constructor(options: SyncManagerOptions) {
    this.auth = options.auth
    this.credentials = options.credentials
    this.transport = options.transport
    this.notifier = options.notify
    this.settings = options.settings ?? { ...DEFAULT_SETTINGS }
    this.customModelsIntervalMs = options.modelsRefreshIntervalMs
    this.customPricesIntervalMs = options.pricesRefreshIntervalMs
  }

  setNotifier(notify: (notification: { title: string; body: string }) => void): void {
    this.notifier = notify
  }

  getSettings(): GitHubCopilotPluginSettings {
    return { ...this.settings }
  }

  getLastDiscoveredModels(): string[] {
    return [...this.lastDiscoveredModels]
  }

  getLastRemovedModels(): string[] {
    return [...this.lastRemovedModels]
  }

  getLastPriceDiffs(): PriceDiff[] {
    return [...this.lastPriceDiffs]
  }

  getModelsRefreshIntervalMs(): number {
    if (this.customModelsIntervalMs !== undefined) return this.customModelsIntervalMs
    const minutes = this.settings.modelsRefreshIntervalMinutes || DEFAULT_SETTINGS.modelsRefreshIntervalMinutes
    return minutes * 60 * 1000
  }

  getPricesRefreshIntervalMs(): number {
    if (this.customPricesIntervalMs !== undefined) return this.customPricesIntervalMs
    const minutes = this.settings.pricesRefreshIntervalMinutes || DEFAULT_SETTINGS.pricesRefreshIntervalMinutes
    return minutes * 60 * 1000
  }

  updateSettings(settings: GitHubCopilotPluginSettings): void {
    const prevModelsInterval = this.getModelsRefreshIntervalMs()
    const prevPricesInterval = this.getPricesRefreshIntervalMs()
    this.settings = { ...settings }
    this.transport.setPricingUnit(settings.pricingUnit || 'credits')
    const newModelsInterval = this.getModelsRefreshIntervalMs()
    const newPricesInterval = this.getPricesRefreshIntervalMs()

    if (this.modelsTimer && prevModelsInterval !== newModelsInterval) {
      this.stopModelsSync()
      this.startModelsSync(false)
    }

    if (this.pricesTimer && prevPricesInterval !== newPricesInterval) {
      this.stopPricesSync()
      this.startPricesSync(false)
    }
  }

  start(): void {
    this.startModelsSync(this.settings.checkModelsOnStartup)
    this.startPricesSync(this.settings.checkPricesOnStartup)
  }

  stop(): void {
    this.stopModelsSync()
    this.stopPricesSync()
  }

  startModelsSync(checkOnStart = this.settings.checkModelsOnStartup): void {
    if (this.modelsTimer) return
    if (checkOnStart) {
      this.checkModels(false, false).catch(() => {})
    }
    this.modelsTimer = setInterval(() => {
      this.checkModels(false, false).catch(() => {})
    }, this.getModelsRefreshIntervalMs())
    if (this.modelsTimer.unref) this.modelsTimer.unref()
  }

  stopModelsSync(): void {
    if (this.modelsTimer) {
      clearInterval(this.modelsTimer)
      this.modelsTimer = null
    }
  }

  startPricesSync(checkOnStart = this.settings.checkPricesOnStartup): void {
    if (this.pricesTimer) return
    if (checkOnStart) {
      this.checkPrices(false, false).catch(() => {})
    }
    this.pricesTimer = setInterval(() => {
      this.checkPrices(false, false).catch(() => {})
    }, this.getPricesRefreshIntervalMs())
    if (this.pricesTimer.unref) this.pricesTimer.unref()
  }

  stopPricesSync(): void {
    if (this.pricesTimer) {
      clearInterval(this.pricesTimer)
      this.pricesTimer = null
    }
  }

  private async getFirstValidCredentialRef(): Promise<string | undefined> {
    const references = await this.credentials.listReferences()
    for (const ref of references) {
      const status = await this.auth.getStatus({ providerId: 'github-copilot', credentialRef: ref })
      if (status.state === 'connected') {
        return ref
      }
    }
    return references[0]
  }

  async checkModels(force = false, isManual = false): Promise<ModelConfig[]> {
    try {
      const credRef = await this.getFirstValidCredentialRef()
      if (!credRef) {
        if (isManual && this.notifier) {
          this.notifier({
            title: 'GitHub Copilot Sync',
            body: 'No connected GitHub Copilot account found to sync models.',
          })
        }
        return []
      }

      const models = await this.transport.listModels({
        providerId: 'github-copilot',
        credentialRef: credRef,
      })

      const currentModelIds = new Set(models.map((m) => m.id))
      const newModels: string[] = []
      const removedModels: string[] = []

      for (const m of models) {
        if (!this.knownModelIds.has(m.id)) {
          newModels.push(m.name || m.id)
        }
      }

      if (!this.isInitialModelsLoad) {
        for (const id of this.knownModelIds) {
          if (!currentModelIds.has(id)) {
            removedModels.push(id)
          }
        }
      }

      const wasInitial = this.isInitialModelsLoad
      this.lastDiscoveredModels = newModels
      this.lastRemovedModels = removedModels
      if (models.length > 0) {
        this.knownModelIds = currentModelIds
      }
      this.isInitialModelsLoad = false

      if (this.notifier) {
        const changes: string[] = []
        if (newModels.length > 0) {
          changes.push(`New models (${newModels.length}): ${newModels.join(', ')}`)
        }
        if (removedModels.length > 0) {
          changes.push(`Removed models (${removedModels.length}): ${removedModels.join(', ')}`)
        }

        if (isManual) {
          this.notifier({
            title: 'GitHub Copilot Models Synced',
            body: changes.length > 0
              ? `Sync complete: ${models.length} models available (${changes.join(' | ')}).`
              : `Sync complete: ${models.length} models available (no changes).`,
          })
        } else if (!wasInitial && changes.length > 0 && (this.settings.notifyOnNewModelsOnly || this.settings.notifyOnEveryCheck)) {
          this.notifier({
            title: 'GitHub Copilot: New Models Available',
            body: changes.join('\n'),
          })
        } else if (this.settings.notifyOnEveryCheck && (!wasInitial || changes.length === 0)) {
          this.notifier({
            title: 'GitHub Copilot Models Checked',
            body: `Check complete: ${models.length} models available (no changes).`,
          })
        }
      }

      return models
    } catch (err) {
      if (isManual && this.notifier) {
        this.notifier({
          title: 'GitHub Copilot Models Sync Error',
          body: err instanceof Error ? err.message : 'Error syncing models',
        })
      }
      return []
    }
  }

  async checkPrices(force = false, isManual = false): Promise<PriceDiff[]> {
    try {
      const credRef = await this.getFirstValidCredentialRef()
      if (!credRef) {
        if (isManual && this.notifier) {
          this.notifier({
            title: 'GitHub Copilot Pricing Sync',
            body: 'No connected GitHub Copilot account found to sync pricing.',
          })
        }
        return []
      }

      const models = await this.transport.listModels({
        providerId: 'github-copilot',
        credentialRef: credRef,
      })

      const priceDiffs: PriceDiff[] = []
      const wasInitial = this.isInitialPricesLoad

      for (const m of models) {
        const currentPricing = (m as any).pricing as ModelPricing | undefined
        if (!currentPricing) continue

        const known = this.knownModelPrices.get(m.id)
        if (known) {
          const changes: string[] = []
          if (known.input !== currentPricing.input) {
            changes.push(`Input: ${known.input ?? 'N/A'} -> ${currentPricing.input ?? 'N/A'}`)
          }
          if (known.output !== currentPricing.output) {
            changes.push(`Output: ${known.output ?? 'N/A'} -> ${currentPricing.output ?? 'N/A'}`)
          }
          if (known.cacheRead !== currentPricing.cacheRead) {
            changes.push(`CacheRead: ${known.cacheRead ?? 'N/A'} -> ${currentPricing.cacheRead ?? 'N/A'}`)
          }
          if (known.cacheWrite !== currentPricing.cacheWrite) {
            changes.push(`CacheWrite: ${known.cacheWrite ?? 'N/A'} -> ${currentPricing.cacheWrite ?? 'N/A'}`)
          }

          if (changes.length > 0) {
            priceDiffs.push({
              modelId: m.id,
              oldPricing: { ...known },
              newPricing: { ...currentPricing },
              changes,
            })
          }
        }

        this.knownModelPrices.set(m.id, { ...currentPricing })
      }

      this.lastPriceDiffs = priceDiffs
      this.isInitialPricesLoad = false

      if (this.notifier) {
        if (priceDiffs.length > 0) {
          const detail = priceDiffs
            .map((p) => `• ${p.modelId}: ${p.changes.join(', ')}`)
            .join('\n')

          if (isManual || this.settings.notifyOnPriceChanges || this.settings.notifyOnEveryCheck) {
            this.notifier({
              title: 'GitHub Copilot API Pricing Updated',
              body: `Price changes detected for ${priceDiffs.length} model(s):\n${detail}`,
            })
          }
        } else if (isManual) {
          this.notifier({
            title: 'GitHub Copilot Pricing Checked',
            body: 'All model prices are up-to-date (no changes).',
          })
        } else if (this.settings.notifyOnEveryCheck) {
          this.notifier({
            title: 'GitHub Copilot Pricing Checked',
            body: 'All model prices are up-to-date (no changes).',
          })
        }
      }

      return priceDiffs
    } catch (err) {
      if (isManual && this.notifier) {
        this.notifier({
          title: 'GitHub Copilot Pricing Sync Error',
          body: err instanceof Error ? err.message : 'Error checking API prices',
        })
      }
      return []
    }
  }

  async syncAll(): Promise<{ models: ModelConfig[]; priceDiffs: PriceDiff[] }> {
    const models = await this.checkModels(true, true)
    const priceDiffs = await this.checkPrices(true, false)
    return { models, priceDiffs }
  }
}
