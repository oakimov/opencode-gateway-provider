/** Build opencode config-shape model entries for a discovered gateway slug. */

import type { ModelsDevHit, ModelsDevModel } from "./modelsdev.js"

export type ConfigVariant = Record<string, unknown>

export type ConfigModel = {
  id?: string
  name: string
  family?: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  interleaved?: true | { field: "reasoning" | "reasoning_content" | "reasoning_details" }
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
    context_over_200k?: {
      input: number
      output: number
      cache_read?: number
      cache_write?: number
    }
  }
  limit?: { context: number; input?: number; output: number }
  modalities?: { input?: string[]; output?: string[] }
  status?: "alpha" | "beta" | "deprecated" | "active"
  provider?: { npm?: string; api?: string }
  options?: Record<string, unknown>
  headers?: Record<string, string>
  /** Variant → provider option overrides copied verbatim from the Catalog. */
  variants?: Record<string, ConfigVariant>
}

const DEFAULT_NPM = "@ai-sdk/openai-compatible"
const DEFAULTS = {
  attachment: true,
  reasoning: true,
  temperature: true,
  tool_call: true,
  context: 200_000,
}

type CatalogExtras = {
  interleaved?: ConfigModel["interleaved"]
}

function releaseDate(timestamp: number) {
  if (!timestamp) return undefined
  const date = new Date(timestamp)
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString().slice(0, 10)
}

function costs(row: ModelsDevModel, free: boolean): ConfigModel["cost"] {
  if (free) return { input: 0, output: 0 }
  const base = row.cost.find((item) => !item.tier) ?? row.cost[0]
  if (!base) return { input: 0, output: 0 }
  const over200k = row.cost.find((item) => item.tier?.type === "context" && item.tier.size === 200_000)
  return {
    input: base.input,
    output: base.output,
    cache_read: base.cache?.read,
    cache_write: base.cache?.write,
    context_over_200k: over200k
      ? {
          input: over200k.input,
          output: over200k.output,
          cache_read: over200k.cache?.read,
          cache_write: over200k.cache?.write,
        }
      : undefined,
  }
}

function capabilityFlag(capabilities: ModelsDevModel["capabilities"], key: string): boolean | undefined {
  const value = (capabilities as Record<string, unknown>)[key]
  return typeof value === "boolean" ? value : undefined
}

function catalogVariantEntries(row: ModelsDevModel): Record<string, ConfigVariant> {
  return Object.fromEntries(row.variants.map((variant) => [variant.id, { ...variant.body }]))
}

function interleavedFor(modelID: string, row: ModelsDevModel | undefined): ConfigModel["interleaved"] {
  const fromCatalog = (row as (ModelsDevModel & CatalogExtras) | undefined)?.interleaved
  if (fromCatalog === true || (fromCatalog && typeof fromCatalog === "object" && "field" in fromCatalog)) {
    return fromCatalog
  }
  // DeepSeek reasoners expose unsigned reasoning via reasoning_content on
  // OpenAI-compatible gateways; hosts also special-case this.
  if (modelID.toLowerCase().includes("deepseek")) return { field: "reasoning_content" }
  return undefined
}

function nonEmptyRecord(value: Record<string, unknown> | undefined) {
  if (!value) return undefined
  return Object.keys(value).length > 0 ? value : undefined
}

export function buildModel(id: string, hit: ModelsDevHit | undefined, baseURL: string): ConfigModel {
  const entry: ConfigModel = {
    name: id,
    attachment: DEFAULTS.attachment,
    reasoning: DEFAULTS.reasoning,
    temperature: DEFAULTS.temperature,
    tool_call: DEFAULTS.tool_call,
    cost: { input: 0, output: 0 },
    limit: { context: DEFAULTS.context, output: 0 },
    provider: { npm: DEFAULT_NPM, api: baseURL },
  }

  if (!hit) {
    const interleaved = interleavedFor(id, undefined)
    if (interleaved) entry.interleaved = interleaved
    return entry
  }

  const { row, tier } = hit
  entry.name = row.name + (tier && !row.name.toLowerCase().endsWith(tier.toLowerCase()) ? tier : "")
  entry.family = row.family
  entry.release_date = releaseDate(row.time.released)
  entry.tool_call = row.capabilities.tools
  entry.attachment = row.capabilities.input.some((item) => item === "image" || item === "pdf")
  entry.reasoning = capabilityFlag(row.capabilities, "reasoning") ?? DEFAULTS.reasoning
  entry.temperature = capabilityFlag(row.capabilities, "temperature") ?? DEFAULTS.temperature
  entry.modalities = {
    input: [...row.capabilities.input],
    output: [...row.capabilities.output],
  }
  entry.limit = { ...row.limit }
  entry.cost = costs(row, Boolean(tier))
  entry.status = row.status

  const headers = nonEmptyRecord(row.request?.headers) as Record<string, string> | undefined
  if (headers) entry.headers = headers
  const options = nonEmptyRecord(row.request?.body)
  if (options) entry.options = options

  const interleaved = interleavedFor(id, row)
  if (interleaved) entry.interleaved = interleaved

  if (row.variants.length > 0) {
    entry.variants = catalogVariantEntries(row)
  }

  return entry
}
