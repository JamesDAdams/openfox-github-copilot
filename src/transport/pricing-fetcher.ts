import type { ModelPricing } from './copilot.js'
import type { PricingUnit } from '../settings.js'

export const GITHUB_MODELS_PRICING_URL =
  'https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml'
export const GITHUB_SUPPORTED_MODELS_DOC_URL =
  'https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/ai-models/supported-models.md'

export interface CopilotYamlPricingEntry {
  model: string
  provider?: string
  tier?: string
  threshold?: string
  input?: string
  cached_input?: string
  cache_write?: string
  output?: string
}

function parseDollarPrice(val?: string): number | undefined {
  if (!val || typeof val !== 'string') return undefined
  const cleaned = val.replace(/\$|,/g, '').trim()
  if (!cleaned || cleaned.toLowerCase() === 'not applicable') return undefined
  const num = Number(cleaned)
  return isNaN(num) ? undefined : num
}

function normalizeKey(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

export const BUNDLED_PRICING_YAML = `
- model: 'GPT-5 mini'
  tier: Default
  input: $0.25
  cached_input: $0.025
  output: $2.00

- model: GPT-5.3-Codex
  tier: Default
  input: $1.75
  cached_input: $0.175
  output: $14.00

- model: 'GPT-5.4'
  tier: Default
  input: $2.50
  cached_input: $0.25
  output: $15.00

- model: 'GPT-5.4'
  tier: 'Long context'
  input: $5.00
  cached_input: $0.50
  output: $22.50

- model: GPT-5.4 mini
  tier: Default
  input: $0.75
  cached_input: $0.075
  output: $4.50

- model: GPT-5.5
  tier: Default
  input: $5.00
  cached_input: $0.50
  output: $30.00

- model: GPT-5.5
  tier: 'Long context'
  input: $10.00
  cached_input: $1.00
  output: $45.00

- model: GPT-5.6 Luna
  tier: Default
  input: $0.20
  cached_input: $0.02
  output: $1.20
  cache_write: $0.25

- model: GPT-5.6 Luna
  tier: 'Long context'
  input: $0.40
  cached_input: $0.04
  output: $1.80
  cache_write: $0.50

- model: GPT-5.6 Sol
  tier: Default
  input: $4.00
  cached_input: $0.40
  output: $20.00
  cache_write: $5.00

- model: GPT-5.6 Sol
  tier: 'Long context'
  input: $8.00
  cached_input: $0.80
  output: $30.00
  cache_write: $10.00

- model: GPT-5.6 Terra
  tier: Default
  input: $2.00
  cached_input: $0.20
  output: $12.00
  cache_write: $2.50

- model: GPT-5.6 Terra
  tier: 'Long context'
  input: $4.00
  cached_input: $0.40
  output: $18.00
  cache_write: $5.00

- model: GPT-6 Astra
  tier: Default
  input: $10.00
  cached_input: $1.00
  output: $50.00
  cache_write: $12.50

- model: GPT-6 Astra
  tier: 'Long context'
  input: $20.00
  cached_input: $2.00
  output: $75.00
  cache_write: $25.00

- model: Claude Haiku 4.5
  tier: Default
  input: $1.00
  cached_input: $0.10
  output: $5.00
  cache_write: $1.25

- model: Claude Sonnet 4
  tier: Default
  input: $3.00
  cached_input: $0.30
  output: $15.00
  cache_write: $3.75

- model: Claude Sonnet 4.6
  tier: Default
  input: $3.00
  cached_input: $0.30
  output: $15.00
  cache_write: $3.75

- model: Claude Opus 4.7
  tier: Default
  input: $5.00
  cached_input: $0.50
  output: $25.00
  cache_write: $6.25

- model: Claude Opus 4.8
  tier: Default
  input: $5.00
  cached_input: $0.50
  output: $25.00
  cache_write: $6.25

- model: Claude Opus 5
  tier: Default
  input: $5.00
  cached_input: $0.50
  output: $25.00
  cache_write: $6.25

- model: Claude Sonnet 5
  tier: Default
  input: $2.00
  cached_input: $0.20
  output: $10.00
  cache_write: $2.50

- model: Gemini 3.6 Flash
  tier: Default
  input: $0.75
  cached_input: $0.075
  output: $3.75

- model: Gemini 3.7 Flash
  tier: Default
  input: $0.75
  cached_input: $0.075
  output: $3.75

- model: Gemini 3.8 Flash
  tier: Default
  input: $0.75
  cached_input: $0.075
  output: $3.75

- model: Grok 4.5
  tier: Default
  input: $2.00
  cached_input: $0.50
  output: $6.00

- model: Grok 4.5
  tier: 'Long context'
  input: $4.00
  cached_input: $1.00
  output: $12.00

- model: Grok 4.6
  tier: Default
  input: $2.00
  cached_input: $0.50
  output: $6.00

- model: Grok 4.6
  tier: 'Long context'
  input: $4.00
  cached_input: $1.00
  output: $12.00

- model: MAI-Code-1-Flash
  tier: Default
  input: $0.75
  cached_input: $0.075
  output: $4.50

- model: MAI-Code-1.1-Flash
  tier: Default
  input: $0.20
  cached_input: $0.02
  output: $1.20

- model: Kimi K3
  tier: Default
  input: $3.00
  cached_input: $0.30
  output: $15.00
`

export class GitHubCopilotPricingFetcher {
  private parsedEntries: CopilotYamlPricingEntry[] = []
  private extendedModels = new Set<string>()
  private lastFetchTime = 0
  private fetchPromise: Promise<void> | null = null

  constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.parsedEntries = this.parseYaml(BUNDLED_PRICING_YAML)
  }

  async fetchPricing(): Promise<void> {
    if (this.fetchPromise) return this.fetchPromise
    this.fetchPromise = this.doFetch()
      .finally(() => {
        this.fetchPromise = null
      })
    return this.fetchPromise
  }

  private async doFetch(): Promise<void> {
    try {
      const [pricingRes, docRes] = await Promise.all([
        this.fetcher(GITHUB_MODELS_PRICING_URL, { signal: AbortSignal.timeout(6000) }).catch(() => null),
        this.fetcher(GITHUB_SUPPORTED_MODELS_DOC_URL, { signal: AbortSignal.timeout(6000) }).catch(() => null),
      ])

      if (pricingRes?.ok) {
        const text = await pricingRes.text()
        this.parsedEntries = this.parseYaml(text)
        this.lastFetchTime = Date.now()
      }

      if (docRes?.ok) {
        const docText = await docRes.text()
        this.extendedModels = this.parseExtendedModelsFromDoc(docText)
      }
    } catch {
      // Retain existing / fallback parsed entries
    }
  }

  parseYaml(yamlText: string): CopilotYamlPricingEntry[] {
    const entries: CopilotYamlPricingEntry[] = []
    let current: Partial<CopilotYamlPricingEntry> | null = null

    for (const line of yamlText.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('- model:')) {
        if (current && current.model) {
          entries.push(current as CopilotYamlPricingEntry)
        }
        current = {
          model: trimmed
            .replace('- model:', '')
            .trim()
            .replace(/^['"]|['"]$/g, '')
            .replace(/\[\^.*\]$/, '')
            .trim(),
        }
      } else if (current && trimmed.includes(':')) {
        const idx = trimmed.indexOf(':')
        const key = trimmed.slice(0, idx).trim()
        const val = trimmed
          .slice(idx + 1)
          .trim()
          .replace(/^['"]|['"]$/g, '')
          .replace(/\[\^.*\]$/, '')
          .trim()
        ;(current as Record<string, string>)[key] = val
      }
    }

    if (current && current.model) {
      entries.push(current as CopilotYamlPricingEntry)
    }

    return entries
  }

  parseExtendedModelsFromDoc(docText: string): Set<string> {
    const set = new Set<string>()
    const lines = docText.split('\n')
    for (const l of lines) {
      if (l.includes('{% octicon "check" aria-label="Supported" %}')) {
        const m = l.match(/copilot_([a-z0-9_]+)/)
        if (m) {
          set.add(m[1].replace(/_/g, '-'))
        }
      }
    }
    return set
  }

  hasLongContextSupport(modelId: string): boolean {
    const normId = normalizeKey(modelId)

    // Check if YAML explicitly has a Long context tier entry
    const inYaml = this.parsedEntries.some((e) => {
      return (
        (e.tier || '').toLowerCase() === 'long context' &&
        normalizeKey(e.model) === normId
      )
    })
    if (inYaml) return true

    // Check if in extended models set
    for (const ext of this.extendedModels) {
      if (normalizeKey(ext) === normId) return true
    }

    // Default static list fallback if no network fetch happened yet
    const STATIC_EXTENDED = [
      'claude-sonnet-4.6',
      'claude-opus-4.7',
      'claude-opus-4.8',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5.1',
      'gpt-5.3-codex',
      'gpt-5.4',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-6-astra',
      'kimi-k3',
      'grok-4.5',
      'grok-4.6',
    ]
    return STATIC_EXTENDED.some((ext) => normalizeKey(ext) === normId)
  }

  getPricing(
    modelId: string,
    tier: 'Default' | 'Long context' = 'Default',
    unit: PricingUnit = 'credits',
  ): ModelPricing | undefined {
    const normId = normalizeKey(modelId)
    const tierLower = tier.toLowerCase()

    const tierEntries = this.parsedEntries.filter(
      (e) => (e.tier || 'Default').toLowerCase() === tierLower,
    )

    let match = tierEntries.find((e) => normalizeKey(e.model) === normId)

    if (!match && tier === 'Long context') {
      // If no long-context specific tier price exists (e.g. Claude Opus 4.8 keeps same per-token price),
      // fallback to Default tier price
      const defEntries = this.parsedEntries.filter(
        (e) => (e.tier || 'Default').toLowerCase() === 'default',
      )
      match = defEntries.find((e) => normalizeKey(e.model) === normId)
    }

    if (!match) return undefined

    const inputRaw = parseDollarPrice(match.input)
    const outputRaw = parseDollarPrice(match.output)
    const cachedInputRaw = parseDollarPrice(match.cached_input)
    const cacheWriteRaw = parseDollarPrice(match.cache_write)

    const multiplier = unit === 'credits' ? 100 : 1

    const result: ModelPricing = {
      currency: unit === 'credits' ? 'tokens' : 'usd',
    }
    if (inputRaw !== undefined) result.input = roundPrice(inputRaw * multiplier, unit)
    if (outputRaw !== undefined) result.output = roundPrice(outputRaw * multiplier, unit)
    if (cachedInputRaw !== undefined) result.cacheRead = roundPrice(cachedInputRaw * multiplier, unit)
    if (cacheWriteRaw !== undefined) result.cacheWrite = roundPrice(cacheWriteRaw * multiplier, unit)

    return (result.input !== undefined || result.output !== undefined || result.cacheRead !== undefined || result.cacheWrite !== undefined) ? result : undefined
  }
}

function roundPrice(val: number, unit: PricingUnit): number {
  if (unit === 'credits') {
    return Math.round(val * 100) / 100
  }
  return Math.round(val * 10000) / 10000
}
