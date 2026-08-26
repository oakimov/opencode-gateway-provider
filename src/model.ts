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
  variants?: Record<string, ConfigVariant>
}

export const OPENAI_NPM = "@ai-sdk/openai"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
export const OPENAI_ELIGIBLE_NPMS = new Set([OPENAI_NPM, OPENAI_COMPATIBLE_NPM])
const DEFAULT_NPM = OPENAI_COMPATIBLE_NPM
const DEFAULTS = {
  attachment: true,
  reasoning: true,
  temperature: true,
  tool_call: true,
  context: 200_000,
}

type CatalogExtras = { interleaved?: ConfigModel["interleaved"] }

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

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  default: "Default",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
}

function isEffortGreaterThanLow(effort: string): boolean {
  const rank = (EFFORT_ORDER as readonly string[]).indexOf(effort.toLowerCase())
  const lowRank = (EFFORT_ORDER as readonly string[]).indexOf("low")
  return rank !== -1 && rank > lowRank
}

function variantLabel(effort: string): string {
  return EFFORT_LABELS[effort.toLowerCase()] ?? effort
}

export function buildVariantEntries(ids: string[], providerNpm?: string): Record<string, ConfigVariant> {
  const isOpenAI = providerNpm === OPENAI_NPM
  const entries: Record<string, ConfigVariant> = {}
  for (const raw of Object.keys(EFFORT_LABELS)) entries[raw] = { disabled: true }
  for (const rawId of ids) {
    const id = rawId.toLowerCase() === "null" ? "none" : rawId
    const base: ConfigVariant = { reasoningEffort: id }
    const displayKey = variantLabel(id)
    if (isOpenAI && isEffortGreaterThanLow(id)) {
      base.reasoningSummary = "auto"
      base.include = ["reasoning.encrypted_content"]
    }
    entries[displayKey] = base
  }
  return entries
}

function catalogVariantEntries(row: ModelsDevModel, providerNpm?: string): Record<string, ConfigVariant> {
  if (row.variants.length === 0) return {}
  return buildVariantEntries(
    row.variants.map((variant) => variant.id),
    providerNpm,
  )
}

function interleavedFor(row: ModelsDevModel | undefined): ConfigModel["interleaved"] {
  const fromCatalog = (row as (ModelsDevModel & CatalogExtras) | undefined)?.interleaved
  if (fromCatalog === true || (fromCatalog && typeof fromCatalog === "object" && "field" in fromCatalog)) {
    return fromCatalog
  }
  return undefined
}

export function buildModel(id: string, hit: ModelsDevHit | undefined, baseURL: string, providerNpm?: string): ConfigModel {
  const npm = providerNpm && OPENAI_ELIGIBLE_NPMS.has(providerNpm) ? providerNpm : DEFAULT_NPM
  const entry: ConfigModel = {
    name: id,
    attachment: DEFAULTS.attachment,
    reasoning: DEFAULTS.reasoning,
    temperature: DEFAULTS.temperature,
    tool_call: DEFAULTS.tool_call,
    cost: { input: 0, output: 0 },
    limit: { context: DEFAULTS.context, output: 0 },
    provider: { npm, api: baseURL },
  }

  if (!hit) {
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
  if (row.status === "alpha" || row.status === "beta" || row.status === "deprecated") entry.status = row.status

  const interleaved = interleavedFor(row)
  if (interleaved) entry.interleaved = interleaved

  const variants = catalogVariantEntries(row, npm)
  if (Object.keys(variants).length > 0) entry.variants = variants

  return entry
}
