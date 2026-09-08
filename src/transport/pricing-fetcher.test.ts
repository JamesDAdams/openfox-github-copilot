import { describe, it, expect, vi } from 'vitest'
import {
  GitHubCopilotPricingFetcher,
  GITHUB_MODELS_PRICING_URL,
  GITHUB_SUPPORTED_MODELS_DOC_URL,
} from './pricing-fetcher.js'

const SAMPLE_YAML = `
- model: 'GPT-5.5'
  provider: openai
  release_status: GA
  category: Powerful
  threshold: '≤ 272K'
  tier: Default
  input: $5.00
  cached_input: $0.50
  output: $30.00
  cache_write: Not applicable

- model: 'GPT-5.5'
  provider: openai
  release_status: GA
  category: Powerful
  threshold: '> 272K'
  tier: 'Long context'
  input: $10.00
  cached_input: $1.00
  output: $45.00
  cache_write: Not applicable

- model: 'GPT-5.6 Luna'
  provider: openai
  release_status: GA
  category: Lightweight
  threshold: '≤ 200K'
  tier: Default
  input: $0.20
  cached_input: $0.02
  output: $1.20
  cache_write: $0.25

- model: 'Claude Opus 4.8'
  provider: anthropic
  release_status: GA
  category: Powerful
  input: $5.00
  cached_input: $0.50
  output: $25.00
  cache_write: $6.25
`

const SAMPLE_DOC = `
| Model | 1 million token context window |
| --- | --- |
| {% data variables.copilot.copilot_claude_opus_48 %} | {% octicon "check" aria-label="Supported" %} |
| {% data variables.copilot.copilot_gpt_55 %} | {% octicon "check" aria-label="Supported" %} |
`

describe('GitHubCopilotPricingFetcher', () => {
  it('parses YAML pricing and calculates credits correctly', async () => {
    const fetcherFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === GITHUB_MODELS_PRICING_URL) {
        return { ok: true, text: async () => SAMPLE_YAML }
      }
      if (url === GITHUB_SUPPORTED_MODELS_DOC_URL) {
        return { ok: true, text: async () => SAMPLE_DOC }
      }
      return { ok: false }
    })

    const pricingFetcher = new GitHubCopilotPricingFetcher(fetcherFn as any)
    await pricingFetcher.fetchPricing()

    // Test GPT-5.5 default credits
    const gpt55DefaultCredits = pricingFetcher.getPricing('gpt-5.5', 'Default', 'credits')
    expect(gpt55DefaultCredits).toEqual({
      currency: 'tokens',
      input: 500,
      output: 3000,
      cacheRead: 50,
    })

    // Test GPT-5.5 long context credits
    const gpt55LongCredits = pricingFetcher.getPricing('gpt-5.5', 'Long context', 'credits')
    expect(gpt55LongCredits).toEqual({
      currency: 'tokens',
      input: 1000,
      output: 4500,
      cacheRead: 100,
    })

    // Test Claude Opus 4.8 cache write in credits
    const opus48Credits = pricingFetcher.getPricing('claude-opus-4.8', 'Default', 'credits')
    expect(opus48Credits).toEqual({
      currency: 'tokens',
      input: 500,
      output: 2500,
      cacheRead: 50,
      cacheWrite: 625,
    })
  })

  it('calculates prices in dollars when requested', async () => {
    const fetcherFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === GITHUB_MODELS_PRICING_URL) {
        return { ok: true, text: async () => SAMPLE_YAML }
      }
      return { ok: false }
    })

    const pricingFetcher = new GitHubCopilotPricingFetcher(fetcherFn as any)
    await pricingFetcher.fetchPricing()

    const gpt55Dollars = pricingFetcher.getPricing('gpt-5.5', 'Default', 'dollars')
    expect(gpt55Dollars).toEqual({
      currency: 'usd',
      input: 5,
      output: 30,
      cacheRead: 0.5,
    })

    const lunaDollars = pricingFetcher.getPricing('gpt-5.6-luna', 'Default', 'dollars')
    expect(lunaDollars).toEqual({
      currency: 'usd',
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
    })
  })

  it('identifies long-context capable models', async () => {
    const fetcherFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === GITHUB_MODELS_PRICING_URL) {
        return { ok: true, text: async () => SAMPLE_YAML }
      }
      if (url === GITHUB_SUPPORTED_MODELS_DOC_URL) {
        return { ok: true, text: async () => SAMPLE_DOC }
      }
      return { ok: false }
    })

    const pricingFetcher = new GitHubCopilotPricingFetcher(fetcherFn as any)
    await pricingFetcher.fetchPricing()

    expect(pricingFetcher.hasLongContextSupport('gpt-5.5')).toBe(true)
    expect(pricingFetcher.hasLongContextSupport('claude-opus-4.8')).toBe(true)
    expect(pricingFetcher.hasLongContextSupport('gpt-5-mini')).toBe(false)
  })
})
