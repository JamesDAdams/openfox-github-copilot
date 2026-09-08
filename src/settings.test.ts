import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginSettingsStore, DEFAULT_SETTINGS } from './settings.js'

describe('PluginSettingsStore', () => {
  let tempDir: string
  let settingsPath: string
  let store: PluginSettingsStore

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'copilot-settings-test-'))
    settingsPath = join(tempDir, 'settings.json')
    store = new PluginSettingsStore(settingsPath)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads default settings when file does not exist', async () => {
    const settings = await store.load()
    expect(settings).toEqual(DEFAULT_SETTINGS)
  })

  it('saves and reloads custom settings', async () => {
    const updated = await store.save({
      checkModelsOnStartup: false,
      modelsRefreshIntervalMinutes: 30,
      checkPricesOnStartup: false,
      pricesRefreshIntervalMinutes: 120,
      notifyOnNewModelsOnly: false,
      notifyOnEveryCheck: true,
      notifyOnPriceChanges: false,
    })

    expect(updated).toEqual({
      checkModelsOnStartup: false,
      modelsRefreshIntervalMinutes: 30,
      checkPricesOnStartup: false,
      pricesRefreshIntervalMinutes: 120,
      pricingUnit: 'credits',
      notifyOnNewModelsOnly: false,
      notifyOnEveryCheck: true,
      notifyOnPriceChanges: false,
    })

    const reloaded = await store.load()
    expect(reloaded).toEqual(updated)
  })

  it('ignores invalid values and falls back safely', async () => {
    await store.save({
      modelsRefreshIntervalMinutes: -10,
      pricesRefreshIntervalMinutes: 'invalid',
    })

    const reloaded = await store.load()
    expect(reloaded.modelsRefreshIntervalMinutes).toBe(DEFAULT_SETTINGS.modelsRefreshIntervalMinutes)
    expect(reloaded.pricesRefreshIntervalMinutes).toBe(DEFAULT_SETTINGS.pricesRefreshIntervalMinutes)
  })
})
