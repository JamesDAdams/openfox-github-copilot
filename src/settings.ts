import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type PricingUnit = 'credits' | 'dollars'

export interface GitHubCopilotPluginSettings {
  checkModelsOnStartup: boolean
  modelsRefreshIntervalMinutes: number
  checkPricesOnStartup: boolean
  pricesRefreshIntervalMinutes: number
  pricingUnit: PricingUnit
  notifyOnNewModelsOnly: boolean
  notifyOnEveryCheck: boolean
  notifyOnPriceChanges: boolean
}

export const DEFAULT_SETTINGS: GitHubCopilotPluginSettings = {
  checkModelsOnStartup: true,
  modelsRefreshIntervalMinutes: 60,
  checkPricesOnStartup: true,
  pricesRefreshIntervalMinutes: 60,
  pricingUnit: 'credits',
  notifyOnNewModelsOnly: true,
  notifyOnEveryCheck: false,
  notifyOnPriceChanges: true,
}

export class PluginSettingsStore {
  constructor(private readonly settingsFilePath: string) {}

  async load(): Promise<GitHubCopilotPluginSettings> {
    try {
      const content = await readFile(this.settingsFilePath, 'utf8')
      const parsed = JSON.parse(content) as Partial<GitHubCopilotPluginSettings>
      return {
        checkModelsOnStartup:
          typeof parsed.checkModelsOnStartup === 'boolean'
            ? parsed.checkModelsOnStartup
            : DEFAULT_SETTINGS.checkModelsOnStartup,
        modelsRefreshIntervalMinutes:
          typeof parsed.modelsRefreshIntervalMinutes === 'number' && parsed.modelsRefreshIntervalMinutes > 0
            ? parsed.modelsRefreshIntervalMinutes
            : DEFAULT_SETTINGS.modelsRefreshIntervalMinutes,
        checkPricesOnStartup:
          typeof parsed.checkPricesOnStartup === 'boolean'
            ? parsed.checkPricesOnStartup
            : DEFAULT_SETTINGS.checkPricesOnStartup,
        pricesRefreshIntervalMinutes:
          typeof parsed.pricesRefreshIntervalMinutes === 'number' && parsed.pricesRefreshIntervalMinutes > 0
            ? parsed.pricesRefreshIntervalMinutes
            : DEFAULT_SETTINGS.pricesRefreshIntervalMinutes,
        pricingUnit:
          parsed.pricingUnit === 'dollars' || parsed.pricingUnit === 'credits'
            ? parsed.pricingUnit
            : DEFAULT_SETTINGS.pricingUnit,
        notifyOnNewModelsOnly:
          typeof parsed.notifyOnNewModelsOnly === 'boolean'
            ? parsed.notifyOnNewModelsOnly
            : DEFAULT_SETTINGS.notifyOnNewModelsOnly,
        notifyOnEveryCheck:
          typeof parsed.notifyOnEveryCheck === 'boolean'
            ? parsed.notifyOnEveryCheck
            : DEFAULT_SETTINGS.notifyOnEveryCheck,
        notifyOnPriceChanges:
          typeof parsed.notifyOnPriceChanges === 'boolean'
            ? parsed.notifyOnPriceChanges
            : DEFAULT_SETTINGS.notifyOnPriceChanges,
      }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  async save(values: Record<string, unknown>): Promise<GitHubCopilotPluginSettings> {
    const existing = await this.load()
    const parsedModelsMinutes = Number(values.modelsRefreshIntervalMinutes)
    const parsedPricesMinutes = Number(values.pricesRefreshIntervalMinutes)

    const updated: GitHubCopilotPluginSettings = {
      checkModelsOnStartup:
        typeof values.checkModelsOnStartup === 'boolean'
          ? values.checkModelsOnStartup
          : existing.checkModelsOnStartup,
      modelsRefreshIntervalMinutes:
        !isNaN(parsedModelsMinutes) && parsedModelsMinutes > 0
          ? parsedModelsMinutes
          : existing.modelsRefreshIntervalMinutes,
      checkPricesOnStartup:
        typeof values.checkPricesOnStartup === 'boolean'
          ? values.checkPricesOnStartup
          : existing.checkPricesOnStartup,
      pricesRefreshIntervalMinutes:
        !isNaN(parsedPricesMinutes) && parsedPricesMinutes > 0
          ? parsedPricesMinutes
          : existing.pricesRefreshIntervalMinutes,
      pricingUnit:
        values.pricingUnit === 'dollars' || values.pricingUnit === 'credits'
          ? (values.pricingUnit as PricingUnit)
          : existing.pricingUnit,
      notifyOnNewModelsOnly:
        typeof values.notifyOnNewModelsOnly === 'boolean'
          ? values.notifyOnNewModelsOnly
          : existing.notifyOnNewModelsOnly,
      notifyOnEveryCheck:
        typeof values.notifyOnEveryCheck === 'boolean'
          ? values.notifyOnEveryCheck
          : existing.notifyOnEveryCheck,
      notifyOnPriceChanges:
        typeof values.notifyOnPriceChanges === 'boolean'
          ? values.notifyOnPriceChanges
          : existing.notifyOnPriceChanges,
    }

    await mkdir(dirname(this.settingsFilePath), { recursive: true })
    await writeFile(this.settingsFilePath, JSON.stringify(updated, null, 2), { mode: 0o600 })
    return updated
  }
}
