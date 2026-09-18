/**
 * Translate 1.x config-shaped models into OpenCode 2 provider inventory.
 *
 * Variants are raw effort ids (`low`, `high`) with `settings.reasoningEffort`.
 * Labeled 1.x keys and disabled tombstones are not published. `editor.add`
 * replaces a provider, so callers must skip an empty model list.
 *
 * `apiKeyEnv` and `autoDiscover` are discovery-only. ConfigProviderPlugin runs
 * after this transform and may copy them back onto `provider.settings`; the
 * native OpenAI options builder drops unknown keys before the request body.
 */

import { OPENAI_COMPATIBLE_NPM, OPENAI_NPM, type ConfigModel } from "../model.js"
import { eligibilityNpm, unwrapPackage, type ConfiguredProvider } from "./config.js"
import type { ModelInfo2, ProviderEditor, ProviderInfo } from "./types.js"

const NATIVE_OPENAI = "@opencode/ai/providers/openai"
const NATIVE_COMPATIBLE = "@opencode/ai/providers/openai-compatible"

export type PublishedProvider = {
  id: string
  info: ProviderInfo
  models: ModelInfo2[]
}

export function publishPackage(pkg: string | undefined, forced: boolean) {
  const name = unwrapPackage(pkg)
  if (!name || name === OPENAI_COMPATIBLE_NPM || name === NATIVE_COMPATIBLE) return NATIVE_COMPATIBLE
  if (name === OPENAI_NPM || name === NATIVE_OPENAI) return NATIVE_OPENAI
  if (name.startsWith("@opencode/ai/")) return name
  if (forced) return pkg?.startsWith("aisdk:") ? pkg : `aisdk:${name}`
  return NATIVE_COMPATIBLE
}

export function variantNpm(pkg?: string) {
  const name = eligibilityNpm(pkg)
  if (name === OPENAI_NPM || name === OPENAI_COMPATIBLE_NPM) return name
  return undefined
}

export function publishSettings(provider: ConfiguredProvider, apiKey?: string) {
  const settings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(provider.settings)) {
    if (key === "apiKeyEnv" || key === "autoDiscover" || value === undefined) continue
    settings[key] = value
  }
  if (provider.baseURL) settings.baseURL = provider.baseURL
  const pkg = publishPackage(provider.package, provider.autoDiscover === true)
  if (pkg.startsWith("@opencode/ai/")) settings.provider = provider.id
  if (apiKey) settings.apiKey = apiKey
  return settings
}

function providerInfo(provider: ConfiguredProvider, apiKey?: string): ProviderInfo {
  const info: ProviderInfo = {
    id: provider.id,
    name: provider.name ?? provider.id,
    package: publishPackage(provider.package, provider.autoDiscover === true),
    activation: "enabled",
    integrationID: provider.id,
    settings: publishSettings(provider, apiKey),
  }
  if (provider.headers) info.headers = provider.headers
  if (provider.body) info.body = provider.body
  return info
}

function toVariants(variants: ConfigModel["variants"]): ModelInfo2["variants"] {
  if (!variants) return []
  const result: ModelInfo2["variants"] = []
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(variants)) {
    if (!value || typeof value !== "object" || value.disabled === true) continue
    const effort =
      typeof value.reasoningEffort === "string" && value.reasoningEffort ? value.reasoningEffort : key.toLowerCase()
    if (seen.has(effort)) continue
    seen.add(effort)
    const settings: Record<string, unknown> = { reasoningEffort: effort }
    if (value.reasoningSummary !== undefined) settings.reasoningSummary = value.reasoningSummary
    if (value.include !== undefined) settings.include = value.include
    result.push({ id: effort, settings })
  }
  return result
}

function toCost(cost: ConfigModel["cost"]): ModelInfo2["cost"] {
  if (!cost) return []
  const base = {
    input: cost.input,
    output: cost.output,
    cache: { read: cost.cache_read ?? 0, write: cost.cache_write ?? 0 },
  }
  if (!cost.context_over_200k) return [base]
  return [
    base,
    {
      tier: { type: "context", size: 200_000 },
      input: cost.context_over_200k.input,
      output: cost.context_over_200k.output,
      cache: {
        read: cost.context_over_200k.cache_read ?? 0,
        write: cost.context_over_200k.cache_write ?? 0,
      },
    },
  ]
}

function released(value?: string) {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function status(value: ConfigModel["status"]): ModelInfo2["status"] {
  if (value === "alpha" || value === "beta" || value === "deprecated") return value
  return "active"
}

function compatibility(value: ConfigModel["interleaved"]): ModelInfo2["compatibility"] {
  if (value === true) return { reasoningField: "reasoning_content" }
  if (typeof value === "string" && value) return { reasoningField: value }
  if (value && typeof value === "object" && typeof value.field === "string") return { reasoningField: value.field }
  return undefined
}

export function toOpenCode2Model(providerID: string, id: string, model: ConfigModel): ModelInfo2 {
  const modelStatus = status(model.status)
  const input = model.modalities?.input?.length
    ? [...model.modalities.input]
    : model.attachment
      ? ["text", "image"]
      : ["text"]
  const output = model.modalities?.output?.length ? [...model.modalities.output] : ["text"]
  const info: ModelInfo2 = {
    id,
    modelID: id,
    providerID,
    name: model.name || id,
    capabilities: {
      tools: model.tool_call !== false,
      input,
      output,
    },
    variants: toVariants(model.variants),
    time: { released: released(model.release_date) },
    cost: toCost(model.cost),
    status: modelStatus,
    enabled: modelStatus !== "deprecated",
    limit: {
      context: Math.trunc(model.limit?.context ?? 0),
      ...(model.limit?.input !== undefined ? { input: Math.trunc(model.limit.input) } : {}),
      output: Math.trunc(model.limit?.output ?? 0),
    },
  }
  if (model.family) info.family = model.family
  const compat = compatibility(model.interleaved)
  if (compat) info.compatibility = compat
  if (model.headers && Object.keys(model.headers).length > 0) info.headers = { ...model.headers }
  return info
}

export function toPublished(
  provider: ConfiguredProvider,
  models: Record<string, ConfigModel>,
  apiKey?: string,
): PublishedProvider | undefined {
  const list = Object.entries(models).map(([id, model]) => toOpenCode2Model(provider.id, id, model))
  if (list.length === 0) return undefined
  return { id: provider.id, info: providerInfo(provider, apiKey), models: list }
}

/** Keep the last good model list, but refresh credentials and endpoint settings. */
export function retarget(entry: PublishedProvider, provider: ConfiguredProvider, apiKey?: string): PublishedProvider {
  return { ...entry, info: providerInfo(provider, apiKey) }
}

export function applyInventory(editor: ProviderEditor, entries: readonly PublishedProvider[]) {
  for (const entry of entries) {
    if (entry.models.length === 0) continue
    editor.add({ info: entry.info, models: entry.models })
  }
}
