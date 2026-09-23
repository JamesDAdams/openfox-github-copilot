import { join } from 'node:path'
import type { ProviderPluginRegistry, ProviderPreset } from 'openfox/provider'
import { FileProviderCredentialStore } from './credentials/file-credential-store.js'
import { GitHubCopilotAuthAdapter } from './auth/github-browser-auth.js'
import { GitHubCopilotTransportAdapter } from './transport/copilot.js'
import { GitHubCopilotQuotaProvider } from './quota/copilot.js'
import { PluginSettingsStore } from './settings.js'
import { GitHubCopilotSyncManager } from './sync-manager.js'
import './quota/contract.js'
import './types.js'

const copilotPreset: ProviderPreset = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  description: 'Use your GitHub Copilot subscription via device code authentication.',
  requiresAuth: true,
  authAdapter: 'github-copilot-auth',
  transportAdapter: 'github-copilot-transport',
  defaults: {
    name: 'GitHub Copilot',
    url: 'https://api.githubcopilot.com',
    backend: 'openai',
  },
  connectLabel: 'Connect GitHub',
  disconnectLabel: 'Disconnect',
  missingPluginMessage: 'Install openfox-github-copilot to use this provider.',
}

export { GitHubCopilotTransportAdapter, type ModelPricing } from './transport/copilot.js'
export { GitHubCopilotSyncManager, type PriceDiff, type SyncManagerOptions } from './sync-manager.js'
export { PluginSettingsStore, DEFAULT_SETTINGS, type GitHubCopilotPluginSettings } from './settings.js'
export {
  GitHubCopilotQuotaProvider,
  type GitHubCopilotProviderAccount,
  type GitHubCopilotQuotaProviderOptions,
} from './quota/copilot.js'

export async function register(registry: ProviderPluginRegistry): Promise<void> {
  const storageDir = join(registry.runtime.configDirectory, 'plugins', 'openfox-github-copilot')
  const settingsStore = new PluginSettingsStore(join(storageDir, 'settings.json'))
  const initialSettings = await settingsStore.load()

  const credentials = new FileProviderCredentialStore(
    join(storageDir, 'credentials.json'),
    join(storageDir, 'credentials.key'),
  )
  const auth = new GitHubCopilotAuthAdapter(credentials)
  const transport = new GitHubCopilotTransportAdapter(auth, {
    pricingUnit: initialSettings.pricingUnit,
  })

  const notify =
    typeof (registry as any).context?.notify === 'function'
      ? (registry as any).context.notify.bind((registry as any).context)
      : typeof (registry as any).notify === 'function'
        ? (registry as any).notify.bind(registry)
        : undefined

  const syncManager = new GitHubCopilotSyncManager({
    auth,
    credentials,
    transport,
    settings: initialSettings,
    ...(notify ? { notify } : {}),
  })
  syncManager.start()

  registry.registerAuth(auth)
  registry.registerTransport(transport)
  registry.registerPreset(copilotPreset)

  const quotaProvider = new GitHubCopilotQuotaProvider(credentials, {
    configDirectory: registry.runtime.configDirectory,
  })

  await quotaProvider.registerProviders(registry)

  // Register RPC methods for manual quota sync and retrieval
  if (typeof registry.registerRpc === 'function') {
    registry.registerRpc('copilot.getQuota', async (params) => {
      const providerId = typeof params?.['providerId'] === 'string' ? params['providerId'] : undefined
      if (providerId) {
        const accounts = await quotaProvider.discoverProviders()
        const target = accounts.find((a) => a.id === providerId || a.sourceId === providerId)
        if (target) {
          const source = await quotaProvider.getQuotaForAccount(target)
          return { source }
        }
      }
      const sources = await quotaProvider.getAllQuotaSources()
      return { sources }
    })

    registry.registerRpc('copilot.syncQuota', async () => {
      return await quotaProvider.syncQuota(registry)
    })

    registry.registerRpc('copilot.manualSync', async () => {
      const { models, priceDiffs } = await syncManager.syncAll()
      notify?.({
        title: {
          en: 'GitHub Copilot Check Completed',
          fr: 'Vérification GitHub Copilot terminée',
        },
        body: {
          en: `${models.length} models verified. ${priceDiffs.length} pricing changes.`,
          fr: `${models.length} modèles vérifiés. ${priceDiffs.length} changements de prix.`,
        },
        level: 'success',
      })
      return { success: true, modelsCount: models.length, priceDiffsCount: priceDiffs.length }
    })
  }

  // Register tool for LLM to query all GitHub Copilot quotas
  if (typeof registry.registerTool === 'function') {
    registry.registerTool({
      name: 'get_copilot_quota',
      description: 'Retrieve current model quota limits and usage across all configured GitHub Copilot provider accounts.',
      parameters: {
        type: 'object',
        properties: {
          providerId: {
            type: 'string',
            description: 'Optional GitHub Copilot provider ID or source ID filter',
          },
        },
      },
      execute: async (args) => {
        const providerId = typeof args['providerId'] === 'string' ? args['providerId'] : undefined
        if (providerId) {
          const accounts = await quotaProvider.discoverProviders()
          const target = accounts.find((a) => a.id === providerId || a.sourceId === providerId)
          if (target) {
            const source = await quotaProvider.getQuotaForAccount(target)
            return {
              success: true,
              output: JSON.stringify(source, null, 2),
            }
          }
        }
        const sources = await quotaProvider.getAllQuotaSources()
        return {
          success: true,
          output: JSON.stringify({ sources }, null, 2),
        }
      },
    })
  }

  // Register turn completion hook to keep quotas updated
  if (typeof registry.registerHook === 'function') {
    registry.registerHook('turn.completed', async () => {
      try {
        await quotaProvider.syncQuota(registry)
      } catch {
        // Silently ignore background quota sync failure
      }
    })
  }

  if (typeof registry.registerSettings === 'function') {
    registry.registerSettings({
      title: {
        en: 'GitHub Copilot Configuration',
        fr: 'Configuration GitHub Copilot',
      },
      description: {
        en: 'Configure models discovery, pricing display and periodic synchronization.',
        fr: 'Configurer la découverte des modèles, l’affichage des prix et la synchronisation périodique.',
      },
      fields: [
        {
          key: 'pricingUnit',
          label: {
            en: 'Pricing display unit',
            fr: 'Unité d’affichage des prix',
          },
          type: 'select',
          description: {
            en: 'Choose whether to display model pricing in GitHub Copilot credits or US dollars.',
            fr: 'Choisissez si les prix des modèles s’affichent en crédits GitHub Copilot ou en dollars américains.',
          },
          options: [
            { label: { en: 'Credits (per 1k tokens)', fr: 'Crédits (par 1k jetons)' }, value: 'credits' },
            { label: { en: 'Dollars ($ per 1k tokens)', fr: 'Dollars ($ par 1k jetons)' }, value: 'dollars' },
          ],
          default: 'credits',
          defaultValue: 'credits',
        },
        {
          key: 'checkModelsOnStartup',
          label: {
            en: 'Check models on OpenFox startup',
            fr: 'Vérifier les modèles au démarrage d’OpenFox',
          },
          type: 'boolean',
          description: {
            en: 'Automatically check GitHub Copilot for new models when OpenFox starts.',
            fr: 'Vérifier automatiquement les nouveaux modèles GitHub Copilot au démarrage.',
          },
          default: true,
          defaultValue: true,
        },
        {
          key: 'modelsRefreshIntervalMinutes',
          label: {
            en: 'Models check interval (minutes)',
            fr: 'Intervalle de vérification des modèles (minutes)',
          },
          type: 'number',
          description: {
            en: 'How often to automatically check GitHub Copilot for new models (in minutes).',
            fr: 'Fréquence de vérification des nouveaux modèles (en minutes).',
          },
          default: 60,
          defaultValue: 60,
          required: true,
        },
        {
          key: 'checkPricesOnStartup',
          label: {
            en: 'Check API prices on OpenFox startup',
            fr: 'Vérifier les prix de l’API au démarrage',
          },
          type: 'boolean',
          description: {
            en: 'Automatically check API pricing changes when OpenFox starts.',
            fr: 'Vérifier automatiquement les changements de prix de l’API au démarrage.',
          },
          default: true,
          defaultValue: true,
        },
        {
          key: 'pricesRefreshIntervalMinutes',
          label: {
            en: 'Pricing check interval (minutes)',
            fr: 'Intervalle de vérification des prix (minutes)',
          },
          type: 'number',
          description: {
            en: 'How often to automatically check GitHub Copilot API prices (default: 60 minutes).',
            fr: 'Fréquence de vérification des prix de l’API (par défaut : 60 minutes).',
          },
          default: 60,
          defaultValue: 60,
          required: true,
        },
        {
          key: 'notifyOnNewModelsOnly',
          label: {
            en: 'Notify only when new models are available or removed',
            fr: 'Notifier uniquement lors de l’ajout ou du retrait de modèles',
          },
          type: 'boolean',
          description: {
            en: 'Receive an in-app notification only when models are added or removed.',
            fr: 'Recevoir une notification uniquement lorsque des modèles sont ajoutés ou retirés.',
          },
          default: true,
          defaultValue: true,
        },
        {
          key: 'notifyOnPriceChanges',
          label: {
            en: 'Notify on price modifications',
            fr: 'Notifier en cas de modification des prix',
          },
          type: 'boolean',
          description: {
            en: 'Receive an in-app notification when model API prices change.',
            fr: 'Recevoir une notification lorsque les prix des modèles changent.',
          },
          default: true,
          defaultValue: true,
        },
        {
          key: 'notifyOnEveryCheck',
          label: {
            en: 'Notify on every check',
            fr: 'Notifier à chaque vérification',
          },
          type: 'boolean',
          description: {
            en: 'Receive an in-app notification every time the background batch checks models or pricing.',
            fr: 'Recevoir une notification à chaque vérification en arrière-plan.',
          },
          default: false,
          defaultValue: false,
        },
        {
          key: 'manualSync',
          label: { en: 'Sync Now', fr: 'Synchroniser' },
          type: 'button',
          buttonLabel: { en: 'Sync Now', fr: 'Synchroniser' },
          action: 'manualSync',
          rpcMethod: 'copilot.manualSync',
        },
      ],
      async getSettings() {
        return (await settingsStore.load()) as unknown as Record<string, unknown>
      },
      async saveSettings(values: Record<string, unknown>) {
        const updated = await settingsStore.save(values)
        syncManager.updateSettings(updated)
      },
      async executeAction(action: string) {
        if (action === 'manualSync') {
          const { models, priceDiffs } = await syncManager.syncAll()
          const newModels = syncManager.getLastDiscoveredModels()
          const removedModels = syncManager.getLastRemovedModels()
          const parts: string[] = [`${models.length} models available`]
          if (newModels.length > 0) parts.push(`${newModels.length} new: ${newModels.join(', ')}`)
          if (removedModels.length > 0) parts.push(`${removedModels.length} removed: ${removedModels.join(', ')}`)
          if (priceDiffs.length > 0) parts.push(`${priceDiffs.length} price changes`)
          return { message: `Sync complete: ${parts.join(' | ')}.` }
        }
      },
    })
  }
}
