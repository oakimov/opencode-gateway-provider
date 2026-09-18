/**
 * Runtime duck types for the OpenCode 2 host surface this plugin uses.
 * Do not import `@opencode/plugin` — it is not a package this plugin can pin,
 * and OpenCode 2 loads this entry without the 1.x plugin dependency.
 */

export type Registration = {
  readonly dispose?: () => Promise<void> | void
}

export type ProviderInfo = {
  id: string
  name: string
  package: string
  activation: "auto" | "enabled" | "disabled"
  integrationID?: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

export type ModelVariantInfo = {
  id: string
  settings?: Record<string, unknown>
}

export type ModelInfo2 = {
  id: string
  modelID: string
  providerID: string
  name: string
  family?: string
  compatibility?: { reasoningField: string }
  capabilities: { tools: boolean; input: string[]; output: string[] }
  variants: ModelVariantInfo[]
  time: { released: number }
  cost: {
    tier?: { type: "context"; size: number }
    input: number
    output: number
    cache: { read: number; write: number }
  }[]
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; input?: number; output: number }
  settings?: Record<string, unknown>
  headers?: Record<string, string>
}

export type ProviderEditor = {
  add(input: { info: ProviderInfo; models: readonly ModelInfo2[] }): void
}

export type ProviderDomain = {
  readonly transform: (callback: (editor: ProviderEditor) => void) => Promise<Registration> | Registration
  readonly reload: () => Promise<void>
}

export type SessionModelRequest = {
  readonly sessionID: string
  readonly model: { readonly providerID: string }
  headers: Record<string, string>
}

export type PluginContext = {
  readonly options?: { readonly providers?: readonly string[] }
  readonly location?: { readonly directory?: string }
  readonly provider: ProviderDomain
  readonly session: {
    readonly hook: (
      name: "model.request",
      callback: (event: SessionModelRequest) => void,
    ) => Promise<Registration> | Registration
  }
  readonly event?: {
    readonly subscribe: () => AsyncIterable<{ readonly type?: string }>
  }
}

export type Cleanup = () => Promise<void> | void

export type Plugin2 = {
  readonly id: string
  readonly setup: (context: PluginContext) => Promise<Cleanup | void> | Cleanup | void
}
