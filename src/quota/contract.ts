import type { ProviderPluginRegistry } from 'openfox/provider'

export type LocalizedString = { en: string; fr: string }
export type PluginRegistry = ProviderPluginRegistry

export type QuotaMetric =
  | {
      kind: 'windowed'
      label: string
      used: number
      limit: number
      window: 'hour' | 'day' | 'week' | 'month'
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
  description?: string
  metrics: QuotaMetric[]
}

export interface QuotaProviderAssignment {
  sourceId: string
  providerId: string
  providerName?: string
  selectedModels?: string[]
}

export interface QuotaProvider {
  readonly id: string
  readonly name: string
  getQuota(): Promise<QuotaSource> | QuotaSource
}

export interface PluginContext {
  readonly id?: string
  readonly version?: string
  readonly runtime?: { mode: 'production' | 'development'; configDirectory: string }
  readonly logger?: {
    debug(message: string, context?: Record<string, unknown>): void
    info(message: string, context?: Record<string, unknown>): void
    warn(message: string, context?: Record<string, unknown>): void
    error(message: string, context?: Record<string, unknown>): void
  }
  readonly storage?: {
    get(key: string): unknown
    set(key: string, value: unknown): void
  }
  settings?(scope?: 'global' | 'project', projectId?: string): Record<string, unknown>
  notify?(request: {
    title: LocalizedString
    body?: LocalizedString
    level?: 'info' | 'success' | 'warning' | 'error'
    actions?: { label: LocalizedString; onActivate: any }[]
  }): void
  publish?(panelId: string | undefined, key: string, value: unknown): void
}

declare module 'openfox/provider' {
  interface ProviderPluginRegistry {
    context?: PluginContext
    registerQuotaProvider?(provider: QuotaProvider): void
    registerHook?(event: string, handler: (payload: any) => void | Promise<void>): void
    registerRpc?(
      method: string,
      handler: (params: Record<string, unknown>, context: Record<string, unknown>) => unknown | Promise<unknown>,
    ): void
    registerTool?(tool: {
      name: string
      description: string
      parameters: Record<string, unknown>
      execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }>
    }): void
  }
}
