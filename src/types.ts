import 'openfox/provider'

export interface PluginNotification {
  title: string
  body: string
}

export type PluginSettingFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea' | 'button'

export interface PluginSettingOption {
  label: string
  value: string
}

export interface PluginSettingField {
  key: string
  label: string
  type: PluginSettingFieldType
  description?: string
  defaultValue?: string | number | boolean
  options?: PluginSettingOption[]
  placeholder?: string
  required?: boolean
  buttonLabel?: string
  action?: string
}

export interface PluginSettingsSpec {
  title?: string
  description?: string
  fields?: PluginSettingField[]
  customUiUrl?: string
  getSettings?: () => Promise<Record<string, unknown>> | Record<string, unknown>
  saveSettings?: (values: Record<string, unknown>) => Promise<void> | void
  executeAction?: (action: string, values: Record<string, unknown>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
}

declare module 'openfox/provider' {
  interface ProviderPluginRegistry {
    registerSettings?(spec: PluginSettingsSpec): void
    registerSettingsForPlugin?(packageName: string, spec: PluginSettingsSpec): void
    notify?(notification: PluginNotification): void
  }
}
