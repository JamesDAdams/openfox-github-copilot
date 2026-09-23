import 'openfox/provider'

export type LocalizedString = string | { en: string; fr: string }

export interface PluginNotification {
  title: LocalizedString
  body?: LocalizedString
  level?: 'info' | 'success' | 'warning' | 'error'
}

export type PluginSettingFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'button'

export interface PluginSettingOption {
  label: LocalizedString
  value: string
}

export interface PluginSettingField {
  key: string
  label: LocalizedString
  type: PluginSettingFieldType
  description?: LocalizedString
  default?: string | number | boolean
  defaultValue?: string | number | boolean
  options?: PluginSettingOption[]
  placeholder?: string
  required?: boolean
  buttonLabel?: LocalizedString
  action?: string
  rpcMethod?: string
}

export interface PluginSettingsSpec {
  title?: LocalizedString
  description?: LocalizedString
  fields?: PluginSettingField[]
  customUiUrl?: string
  getSettings?: () => Promise<Record<string, unknown>> | Record<string, unknown>
  saveSettings?: (values: Record<string, unknown>) => Promise<void> | void
  executeAction?: (action: string, values?: Record<string, unknown>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
}

declare module 'openfox/provider' {
  interface ProviderPluginRegistry {
    registerSettings?(spec: PluginSettingsSpec): void
    registerSettingsForPlugin?(packageName: string, spec: PluginSettingsSpec): void
    notify?(notification: PluginNotification): void
  }
}
