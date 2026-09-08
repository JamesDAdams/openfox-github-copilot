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

  const syncManager = new GitHubCopilotSyncManager({
    auth,
    credentials,
    transport,
    settings: initialSettings,
    notify: (notification) => {
      if (typeof registry.notify === 'function') {
        registry.notify(notification)
      }
    },
  })
  syncManager.start()

  registry.registerAuth(auth)
  registry.registerTransport(transport)
  registry.registerPreset(copilotPreset)

  if (typeof registry.registerQuotaProvider === 'function') {
    registry.registerQuotaProvider(new GitHubCopilotQuotaProvider(credentials))
  }

  if (typeof registry.registerSettings === 'function') {
    registry.registerSettings({
      title: 'GitHub Copilot Configuration',
      description: 'Configure models discovery and API pricing periodic synchronization for GitHub Copilot.',
      fields: [
        {
          key: 'checkModelsOnStartup',
          label: 'Check models on OpenFox startup',
          type: 'boolean',
          description: 'Automatically check GitHub Copilot for new models when OpenFox starts.',
          defaultValue: true,
        },
        {
          key: 'modelsRefreshIntervalMinutes',
          label: 'Models check interval (minutes)',
          type: 'number',
          description: 'How often to automatically check GitHub Copilot for new models (in minutes).',
          defaultValue: 60,
          required: true,
        },
        {
          key: 'checkPricesOnStartup',
          label: 'Check API prices on OpenFox startup',
          type: 'boolean',
          description: 'Automatically check API pricing changes when OpenFox starts.',
          defaultValue: true,
        },
        {
          key: 'pricesRefreshIntervalMinutes',
          label: 'Pricing check interval (minutes)',
          type: 'number',
          description: 'How often to automatically check GitHub Copilot API prices (default: 60 minutes).',
          defaultValue: 60,
          required: true,
        },
        {
          key: 'pricingUnit',
          label: 'Pricing display unit',
          type: 'select',
          description: 'Display Copilot API prices in AI Credits or USD ($).',
          defaultValue: 'credits',
          options: [
            { label: 'AI Credits (1 credit = $0.01)', value: 'credits' },
            { label: 'USD ($ / 1M tokens)', value: 'dollars' },
          ],
        },
        {
          key: 'notifyOnNewModelsOnly',
          label: 'Notify only when new models are available or removed',
          type: 'boolean',
          description: 'Receive an in-app notification only when models are added or removed.',
          defaultValue: true,
        },
        {
          key: 'notifyOnPriceChanges',
          label: 'Notify on price modifications',
          type: 'boolean',
          description: 'Receive an in-app notification when model API prices change.',
          defaultValue: true,
        },
        {
          key: 'notifyOnEveryCheck',
          label: 'Notify on every check',
          type: 'boolean',
          description: 'Receive an in-app notification every time the background batch checks models or pricing.',
          defaultValue: false,
        },
        {
          key: 'manualSync',
          label: '',
          type: 'button',
          buttonLabel: 'Sync Now',
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
