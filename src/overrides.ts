import type { PluginInput } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildVariantEntries } from "./model.js"
import type { ConfigModel } from "./model.js"
import { cacheDirectory, catalogHost } from "./modelsdev.js"

const OVERRIDE_FILE = "gateway-model-overrides.json"
const OVERRIDE_PATH_ENV = "GATEWAY_MODEL_OVERRIDES"
const EFFORT_SUFFIXES = ["-xhigh", "-medium", "-low", "-high", "-max", "-minimal", "-none"]
const PRICING_KEYS = ["input", "output", "cache_read", "cache_write"] as const

export type ModelOverride = {
  name?: string
  family?: string
  provider?: string
  context_size?: number
  pricing?: Partial<Record<(typeof PRICING_KEYS)[number], number>>
  reasoning?: boolean
  temperature?: boolean
  attachment?: boolean
  tool_call?: boolean
  variants?: string[]
}

export type ModelOverrides = Record<string, ModelOverride>

export function overrideFile(
  input: PluginInput,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
) {
  const explicit = env[OVERRIDE_PATH_ENV]?.trim()
  if (explicit) return explicit
  try {
    return path.join(cacheDirectory(catalogHost(input, env), env, home), OVERRIDE_FILE)
  } catch {
    return ""
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function parseOverride(value: unknown): ModelOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const item: ModelOverride = {}
  if (typeof raw.name === "string" && raw.name) item.name = raw.name
  if (typeof raw.family === "string" && raw.family) item.family = raw.family
  if (typeof raw.provider === "string" && raw.provider.trim()) item.provider = raw.provider.trim().toLowerCase()
  const context = finiteNumber(raw.context_size)
  if (context && context > 0) item.context_size = context
  if (typeof raw.reasoning === "boolean") item.reasoning = raw.reasoning
  if (typeof raw.temperature === "boolean") item.temperature = raw.temperature
  if (typeof raw.attachment === "boolean") item.attachment = raw.attachment
  if (typeof raw.tool_call === "boolean") item.tool_call = raw.tool_call
  if (Array.isArray(raw.variants)) {
    const variants = raw.variants.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    if (variants.length > 0) item.variants = variants
  }
  if (raw.pricing && typeof raw.pricing === "object" && !Array.isArray(raw.pricing)) {
    const pricing: NonNullable<ModelOverride["pricing"]> = {}
    for (const key of PRICING_KEYS) {
      const amount = finiteNumber((raw.pricing as Record<string, unknown>)[key])
      if (amount !== undefined) pricing[key] = amount
    }
    if (Object.keys(pricing).length > 0) item.pricing = pricing
  }
  return Object.keys(item).length > 0 ? item : undefined
}

export function parseOverrides(body: unknown): ModelOverrides {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {}
  const hasWrapper = "models" in body && body.models && typeof body.models === "object" && !Array.isArray(body.models)
  const models = hasWrapper ? body.models as Record<string, unknown> : body as Record<string, unknown>
  if (!hasWrapper && "models" in body) {
    const stray = (body as Record<string, unknown>).models
    if (stray && typeof stray === "object" && !Array.isArray(stray)) {
      // Ambiguous shape: top-level is flat plus a wrapper key — treat as flat and keep the wrapper key's entry
      // via the flat path, not as a separate namespace. The flat entry for "models" is already skipped below.
    }
  }
  const result: ModelOverrides = {}
  for (const [id, value] of Object.entries(models)) {
    if (!id.trim()) continue
    const parsed = parseOverride(value)
    if (parsed) result[id.toLowerCase()] = parsed
  }
  return result
}

export async function getOverrides(
  input: PluginInput,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<ModelOverrides> {
  const filename = overrideFile(input, env, home)
  if (!filename) return {}
  try {
    const content = await readFile(filename, "utf8")
    if (!content) return {}
    return parseOverrides(JSON.parse(content))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {}
    throw new Error(`Gateway model overrides are invalid: ${filename}`)
  }
}

function baseModelID(modelID: string) {
  const lower = modelID.toLowerCase()
  for (const suffix of EFFORT_SUFFIXES) {
    if (lower.endsWith(suffix)) return modelID.slice(0, -suffix.length)
  }
  return modelID
}

export function overrideFor(overrides: ModelOverrides, modelID: string): ModelOverride | undefined {
  return overrides[modelID.toLowerCase()] ?? overrides[baseModelID(modelID).toLowerCase()]
}

export function applyModelOverride(
  entry: ConfigModel,
  override: ModelOverride | undefined,
  gatewayID?: string,
): ConfigModel {
  if (!override) return entry
  if (override.name) entry.name = override.name
  if (override.family) entry.family = override.family
  if (override.context_size) {
    entry.limit = { ...(entry.limit ?? { context: 0, output: 0 }), context: override.context_size }
  }
  const isFree = gatewayID?.toLowerCase().endsWith("-free") ?? false
  if (override.pricing && !isFree) {
    entry.cost = {
      input: override.pricing.input ?? entry.cost?.input ?? 0,
      output: override.pricing.output ?? entry.cost?.output ?? 0,
      cache_read: override.pricing.cache_read ?? entry.cost?.cache_read,
      cache_write: override.pricing.cache_write ?? entry.cost?.cache_write,
      context_over_200k: entry.cost?.context_over_200k,
    }
  }
  if (override.reasoning !== undefined) entry.reasoning = override.reasoning
  if (override.temperature !== undefined) entry.temperature = override.temperature
  if (override.attachment !== undefined) entry.attachment = override.attachment
  if (override.tool_call !== undefined) entry.tool_call = override.tool_call
  if (override.variants) {
    entry.variants = buildVariantEntries(override.variants)
  }
  return entry
}
