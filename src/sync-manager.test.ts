import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitHubCopilotSyncManager, syncCopilotConfigProviders } from './sync-manager.js'
import { DEFAULT_SETTINGS } from './settings.js'
import type { ModelConfig } from 'openfox/provider'

describe('GitHubCopilotSyncManager', () => {
  let mockAuth: any
  let mockCredentials: any
  let mockTransport: any
  let notifyFn: any
  let syncManager: GitHubCopilotSyncManager

  beforeEach(() => {
    vi.useFakeTimers()
    notifyFn = vi.fn()

    mockCredentials = {
      listReferences: vi.fn().mockResolvedValue(['cred-1']),
      get: vi.fn().mockResolvedValue({ username: 'mona', oauthToken: 'token-123' }),
    }

    mockAuth = {
      getStatus: vi.fn().mockResolvedValue({ state: 'connected', accountLabel: 'mona' }),
    }

    mockTransport = {
      listModels: vi.fn().mockResolvedValue([
        { id: 'gpt-5-mini', name: 'GPT-5 Mini', contextWindow: 128000, source: 'backend', pricing: { input: 10, output: 20 } },
        { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', contextWindow: 1000000, source: 'backend', pricing: { input: 300, output: 1500 } },
      ]),
    }

    syncManager = new GitHubCopilotSyncManager({
      auth: mockAuth,
      credentials: mockCredentials,
      transport: mockTransport,
      notify: notifyFn,
      modelsRefreshIntervalMs: 10000,
      pricesRefreshIntervalMs: 20000,
      settings: {
        ...DEFAULT_SETTINGS,
        modelsRefreshIntervalMinutes: 10,
        pricesRefreshIntervalMinutes: 20,
      },
    })
  })

  afterEach(() => {
    syncManager.stop()
    vi.useRealTimers()
  })

  it('performs initial models and prices check on start', async () => {
    syncManager.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockTransport.listModels).toHaveBeenCalled()
  })

  it('notifies on new models discovered during subsequent check', async () => {
    // 1. Initial check (no notify if notifyOnNewModelsOnly is true and it is initial)
    await syncManager.checkModels(false, false)
    expect(notifyFn).not.toHaveBeenCalled()

    // 2. Second check with added model
    mockTransport.listModels.mockResolvedValueOnce([
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'new-model-2026', name: 'New Model 2026' },
    ])

    await syncManager.checkModels(false, false)
    expect(notifyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'GitHub Copilot: New Models Available',
        body: expect.stringContaining('New Model 2026'),
      }),
    )
    expect(syncManager.getLastDiscoveredModels()).toEqual(['New Model 2026'])
  })

  it('notifies on price modifications during subsequent check', async () => {
    // 1. Initial check
    await syncManager.checkPrices(false, false)
    expect(notifyFn).not.toHaveBeenCalled()

    // 2. Pricing changed for gpt-5-mini
    mockTransport.listModels.mockResolvedValueOnce([
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', pricing: { input: 15, output: 25, cacheRead: 5 } },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', pricing: { input: 300, output: 1500 } },
    ])

    const diffs = await syncManager.checkPrices(false, false)
    expect(diffs.length).toBe(1)
    expect(diffs[0].modelId).toBe('gpt-5-mini')
    expect(diffs[0].changes).toEqual([
      'Input: 10 -> 15',
      'Output: 20 -> 25',
      'CacheRead: N/A -> 5',
    ])

    expect(notifyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'GitHub Copilot API Pricing Updated',
        body: expect.stringContaining('gpt-5-mini: Input: 10 -> 15, Output: 20 -> 25, CacheRead: N/A -> 5'),
      }),
    )
  })

  it('runs syncAll and gives a manual summary message', async () => {
    const result = await syncManager.syncAll()
    expect(result.models.length).toBe(2)
    expect(notifyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'GitHub Copilot Models Synced',
      }),
    )
  })

  it('triggers periodic checks according to timer intervals', async () => {
    syncManager.start()
    await vi.advanceTimersByTimeAsync(0)
    mockTransport.listModels.mockClear()

    // Advance 10s (models interval)
    await vi.advanceTimersByTimeAsync(10000)
    expect(mockTransport.listModels).toHaveBeenCalledTimes(1)

    // Advance 10s more (20s total -> prices interval & models interval)
    await vi.advanceTimersByTimeAsync(10000)
    expect(mockTransport.listModels).toHaveBeenCalledTimes(3) // 2 from models total + 1 from prices
  })

  it('automatically adds new models to config.json when autoAddModels is true', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'copilot-sync-test-'))
    const configPath = join(tempDir, 'config.json')
    const initialConfig = {
      providers: [
        {
          id: 'copilot-1',
          name: 'GitHub Copilot',
          preset: 'github-copilot',
          backend: 'openai',
          models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
        },
      ],
    }
    await writeFile(configPath, JSON.stringify(initialConfig, null, 2))

    const newModels = [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000 },
    ]

    const result = await syncCopilotConfigProviders(newModels as any, [], DEFAULT_SETTINGS, tempDir)
    expect(result.added).toBe(1)

    const updatedRaw = await readFile(configPath, 'utf8')
    const updated = JSON.parse(updatedRaw)
    expect(updated.providers[0].models).toHaveLength(2)
    expect(updated.providers[0].models.map((m: any) => m.id)).toEqual(['gpt-4o', 'claude-3-5-sonnet'])

    await rm(tempDir, { recursive: true, force: true })
  })

  it('automatically removes deleted models from config.json when autoRemoveModels is true', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'copilot-sync-test-'))
    const configPath = join(tempDir, 'config.json')
    const initialConfig = {
      providers: [
        {
          id: 'copilot-1',
          name: 'GitHub Copilot',
          preset: 'github-copilot',
          backend: 'openai',
          models: [
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'old-deprecated-model', name: 'Old Model' },
          ],
        },
      ],
    }
    await writeFile(configPath, JSON.stringify(initialConfig, null, 2))

    const result = await syncCopilotConfigProviders(
      [],
      ['old-deprecated-model'],
      { ...DEFAULT_SETTINGS, autoRemoveModels: true },
      tempDir,
    )
    expect(result.removed).toBe(1)

    const updatedRaw = await readFile(configPath, 'utf8')
    const updated = JSON.parse(updatedRaw)
    expect(updated.providers[0].models).toHaveLength(1)
    expect(updated.providers[0].models[0].id).toBe('gpt-4o')

    await rm(tempDir, { recursive: true, force: true })
  })
})
