import 'openfox/provider'

// Local augmentation of the OpenFox quota contract.
//
// The QuotaProvider contract is defined in the OpenFox source repo
// (src/provider/index.ts / src/shared/types.ts) but has not been published to
// the openfox npm package yet. This module declares the shapes so the plugin
// compiles and registers a QuotaProvider today.
//
// TODO(quota-contract): remove this file and import the types from 'openfox/provider'
// once the QuotaProvider contract ships in the published openfox package. Leaving
// it in place after that point risks type drift / duplicate declarations.

export type QuotaMetric =
  | {
      kind: 'windowed'
      label: string
      used: number
      limit: number
      window: 'hour' | 'week' | 'month'
      model?: string
      resetsAt?: string
    }
  | {
      kind: 'token-balance'
      label: string
      total: number
      remaining: number
      model?: string
    }

export interface QuotaSource {
  id: string
  name: string
  metrics: QuotaMetric[]
}

export interface QuotaProvider {
  readonly id: string
  readonly name: string
  getQuota(): Promise<QuotaSource>
}

declare module 'openfox/provider' {
  interface ProviderPluginRegistry {
    registerQuotaProvider?(provider: QuotaProvider): void
  }
}
