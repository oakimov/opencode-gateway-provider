/** Read and match the host's already-cached models.dev catalog. */

import type { PluginInput } from "@opencode-ai/plugin"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/types"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type ModelsDevModel = {
  id: string
  providerID: string
  family?: string
  name: string
  api: ModelV2Info["api"]
  capabilities: ModelV2Info["capabilities"] & {
    reasoning?: boolean
    temperature?: boolean
    attachment?: boolean
  }
  request: ModelV2Info["request"]
  variants: ModelV2Info["variants"]
  time: { released: number }
  cost: ModelV2Info["cost"]
  status: ModelV2Info["status"]
  enabled: boolean
  limit: ModelV2Info["limit"]
  interleaved?: true | { field: string } | boolean
}
export type ModelsDevApi = ModelsDevModel[]
export type ModelsDevHit = {
  row: ModelsDevModel
  /** " Free" when the gateway slug ends in "-free". */
  tier: string
}

export type CatalogHost = "opencode" | "kilo" | "mimo"

type NativeTransport = {
  getConfig?: () => { headers?: unknown }
}

type PluginClientWithTransport = { _client?: NativeTransport }

type HostDefinition = {
  app: string
  modelsPath: string
  modelsURL: string
  defaultURL: string
}

const HOSTS: Record<CatalogHost, HostDefinition> = {
  opencode: {
    app: "opencode",
    modelsPath: "OPENCODE_MODELS_PATH",
    modelsURL: "OPENCODE_MODELS_URL",
    defaultURL: "https://models.opencode.ai",
  },
  kilo: {
    app: "kilo",
    modelsPath: "KILO_MODELS_PATH",
    modelsURL: "KILO_MODELS_URL",
    defaultURL: "https://models.dev",
  },
  mimo: {
    app: "mimocode",
    modelsPath: "MIMOCODE_MODELS_PATH",
    modelsURL: "MIMOCODE_MODELS_URL",
    defaultURL: "https://models.dev",
  },
}

type RawReasoningOption = {
  type?: string
  values?: unknown[]
}

type RawCost = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tiers?: Array<{
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    tier?: { type?: string; size?: number }
  }>
  context_over_200k?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
}

type RawModel = {
  id?: string
  name?: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  release_date?: string
  status?: string
  interleaved?: ModelsDevModel["interleaved"] | string
  reasoning_options?: RawReasoningOption[]
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; input?: number; output?: number }
  cost?: RawCost
}

type RawProvider = {
  id?: string
  models?: Record<string, RawModel>
}

type RawCatalog = Record<string, RawProvider>

function environmentHas(env: NodeJS.ProcessEnv, name: string) {
  return Object.prototype.hasOwnProperty.call(env, name)
}

function headerNames(value: unknown): string[] {
  if (value instanceof Headers) return [...value.keys()].map((item) => item.toLowerCase())
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      Array.isArray(item) && typeof item[0] === "string" ? [item[0].toLowerCase()] : [],
    )
  }
  if (!value || typeof value !== "object") return []
  return Object.keys(value).map((item) => item.toLowerCase())
}

function hostFromClient(input: PluginInput): CatalogHost | undefined {
  const transport = (input.client as unknown as PluginClientWithTransport)._client
  const headers = headerNames(transport?.getConfig?.().headers)
  const hosts = [
    headers.includes("x-mimocode-directory") ? "mimo" : undefined,
    headers.includes("x-kilo-directory") ? "kilo" : undefined,
    headers.includes("x-opencode-directory") ? "opencode" : undefined,
  ].filter((item): item is CatalogHost => item !== undefined)
  if (hosts.length > 1) throw new Error(`Host client identifies multiple catalog owners: ${hosts.join(", ")}`)
  return hosts[0]
}

function hostFromEnvironment(env: NodeJS.ProcessEnv): CatalogHost | undefined {
  const evidence = new Set<CatalogHost>()
  if (
    environmentHas(env, "MIMOCODE_MODELS_PATH") ||
    env.MIMOCODE_MODELS_URL ||
    env.MIMOCODE_HOME
  ) evidence.add("mimo")
  if (environmentHas(env, "KILO_MODELS_PATH") || env.KILO_MODELS_URL) evidence.add("kilo")
  if (environmentHas(env, "OPENCODE_MODELS_PATH") || env.OPENCODE_MODELS_URL) evidence.add("opencode")

  if (evidence.size > 1) {
    throw new Error(`Host environment identifies multiple catalog owners: ${[...evidence].join(", ")}`)
  }
  return [...evidence][0]
}

/** Identify the native host without making a re-entrant host API request. */
export function catalogHost(
  input: PluginInput,
  env: NodeJS.ProcessEnv = process.env,
): CatalogHost {
  const forced = env.OPENCODE_COMPAT_HOST?.trim().toLowerCase()
  if (forced) {
    if (forced === "opencode" || forced === "kilo" || forced === "mimo") return forced
    throw new Error(`Unsupported OPENCODE_COMPAT_HOST: ${forced}`)
  }

  const client = hostFromClient(input)
  if (client) return client
  const environment = hostFromEnvironment(env)
  if (environment) return environment
  throw new Error("Cannot identify the native host catalog")
}

export function cacheDirectory(host: CatalogHost, env: NodeJS.ProcessEnv, home: string) {
  if (host === "mimo" && env.MIMOCODE_HOME) {
    if (!path.isAbsolute(env.MIMOCODE_HOME)) {
      throw new Error(`MIMOCODE_HOME must be absolute: ${env.MIMOCODE_HOME}`)
    }
    return path.join(env.MIMOCODE_HOME, "cache")
  }
  const xdg = env.XDG_CACHE_HOME || path.join(home, ".cache")
  // Kilo applies this cleanup to xdg-basedir output before constructing
  // Global.Path.cache; OpenCode and MiMo use the value verbatim.
  const root = host === "kilo" ? xdg.replace(/[\r\n]+/g, "") : xdg
  return path.join(root, HOSTS[host].app)
}

/** Resolve the exact file the native host's models service reads. */
export function catalogFile(
  host: CatalogHost,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
) {
  const definition = HOSTS[host]
  if (environmentHas(env, definition.modelsPath)) return env[definition.modelsPath] ?? ""

  const source = env[definition.modelsURL] || definition.defaultURL
  const filename = source === definition.defaultURL
    ? "models.json"
    : `models-${createHash("sha1").update(source).digest("hex")}.json`
  return path.join(cacheDirectory(host, env, home), filename)
}

/** Read the native host's existing catalog without a download or nested instance bootstrap. */
export async function getCatalog(
  input: PluginInput,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<ModelsDevApi> {
  const host = catalogHost(input, env)
  const filename = catalogFile(host, env, home)
  if (!filename) throw new Error(`${HOSTS[host].modelsPath} is empty`)
  const content = await readFile(filename, "utf8")
  if (!content) throw new Error(`Host models.dev cache is empty: ${filename}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`Host models.dev cache is not valid JSON: ${filename}`)
  }
  return parseModelsDevCatalog(parsed)
}

function released(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : 0
  return Number.isFinite(timestamp) ? timestamp : 0
}

function status(value: string | undefined): ModelsDevModel["status"] {
  if (value === "alpha" || value === "beta" || value === "deprecated" || value === "active") return value
  return "active"
}

function interleaved(value: RawModel["interleaved"]): ModelsDevModel["interleaved"] {
  if (typeof value === "string") return { field: value }
  return value
}

function variants(options: RawReasoningOption[] | undefined): ModelsDevModel["variants"] {
  const values = options?.find((option) => option.type === "effort")?.values ?? []
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const id = value === null ? "none" : value
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) return []
    seen.add(id)
    return [{ id, headers: {}, body: {} }]
  })
}

function costs(value: RawCost | undefined): ModelsDevModel["cost"] {
  const base = {
    input: value?.input ?? 0,
    output: value?.output ?? 0,
    cache: {
      read: value?.cache_read ?? 0,
      write: value?.cache_write ?? 0,
    },
  }
  const tiers = (value?.tiers ?? []).flatMap((item) => {
    if (item.tier?.type !== "context" || typeof item.tier.size !== "number") return []
    return [{
      tier: { type: "context" as const, size: item.tier.size },
      input: item.input ?? 0,
      output: item.output ?? 0,
      cache: {
        read: item.cache_read ?? 0,
        write: item.cache_write ?? 0,
      },
    }]
  })
  const over200k = value?.context_over_200k
    ? [{
        tier: { type: "context" as const, size: 200_000 },
        input: value.context_over_200k.input ?? 0,
        output: value.context_over_200k.output ?? 0,
        cache: {
          read: value.context_over_200k.cache_read ?? 0,
          write: value.context_over_200k.cache_write ?? 0,
        },
      }]
    : []
  return [base, ...tiers, ...over200k]
}

function fromRawModel(
  providerID: string,
  key: string,
  model: RawModel,
): ModelsDevModel {
  const id = model.id ?? key
  const input = model.modalities?.input?.length
    ? [...model.modalities.input]
    : model.attachment
      ? ["text", "image"]
      : ["text"]
  const output = model.modalities?.output?.length ? [...model.modalities.output] : ["text"]

  return {
    id,
    providerID,
    name: model.name ?? id,
    family: model.family,
    api: { id, type: "native", settings: {} },
    capabilities: {
      tools: model.tool_call !== false,
      input,
      output,
      reasoning: model.reasoning === true,
      temperature: model.temperature === true,
      attachment: model.attachment === true,
    },
    request: { headers: {}, body: {} },
    variants: variants(model.reasoning_options),
    interleaved: interleaved(model.interleaved),
    time: { released: released(model.release_date) },
    cost: costs(model.cost),
    status: status(model.status),
    enabled: true,
    limit: {
      context: model.limit?.context ?? 0,
      input: model.limit?.input,
      output: model.limit?.output ?? 0,
    },
  }
}

export function parseModelsDevCatalog(body: unknown): ModelsDevApi {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Host models.dev cache has an invalid shape")
  }

  const rows: ModelsDevApi = []
  for (const [providerKey, provider] of Object.entries(body as RawCatalog)) {
    if (!provider || typeof provider !== "object") continue
    const providerID = provider.id ?? providerKey
    for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
      if (!model || typeof model !== "object") continue
      rows.push(fromRawModel(providerID, modelKey, model))
    }
  }
  if (rows.length === 0) throw new Error("Host models.dev cache contains no models")
  return rows
}

function bareModelName(value: string) {
  const slash = value.lastIndexOf("/")
  return slash === -1 ? value : value.slice(slash + 1)
}

type IndexRow = { model: ModelsDevModel }
export type ModelsDevIndex = Record<string, IndexRow[]>

export function buildIndex(data: ModelsDevApi): ModelsDevIndex {
  const index: ModelsDevIndex = {}
  for (const model of data) {
    const key = bareModelName(model.id).toLowerCase()
    ;(index[key] ??= []).push({ model })
  }
  return index
}

function modelNamespace(value: string) {
  const slash = value.indexOf("/")
  return slash === -1 ? undefined : value.slice(0, slash).toLowerCase()
}

function rowForProvider(rows: IndexRow[], providerID: string, modelID: string) {
  const providerRows = rows.filter(({ model }) => model.providerID.toLowerCase() === providerID)
  if (providerRows.length === 1) return providerRows[0].model

  const requested = modelID.toLowerCase()
  const exact = providerRows.filter(({ model }) => model.id.toLowerCase() === requested)
  return exact.length === 1 ? exact[0].model : undefined
}

function nativeEvidence(rows: IndexRow[]) {
  const evidence = new Map<string, Set<string>>()
  for (const { model } of rows) {
    const namespace = modelNamespace(model.id)
    const reseller = model.providerID.toLowerCase()
    if (!namespace || namespace === reseller) continue
    ;(evidence.get(namespace) ?? evidence.set(namespace, new Set()).get(namespace)!).add(reseller)
  }
  return evidence
}

function resolvedRow(rows: IndexRow[], modelID: string): ModelsDevModel | undefined {
  const requested = modelID.toLowerCase()
  const exact = rows.filter(({ model }) => model.id.toLowerCase() === requested)
  if (exact.length === 0) return undefined

  const providers = new Set(exact.map(({ model }) => model.providerID.toLowerCase()))
  if (providers.size === 1) return rowForProvider(exact, [...providers][0], modelID)

  const evidence = nativeEvidence(rows)
  const ranked = [...providers]
    .map((providerID) => ({ providerID, count: evidence.get(providerID)?.size ?? 0 }))
    .filter(({ count }) => count > 0)
    .sort((left, right) => right.count - left.count)
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0].count === ranked[1].count)) return undefined
  return rowForProvider(exact, ranked[0].providerID, modelID)
}

/** Match only the exact model name represented in models.dev. */
export function lookupInIndex(index: ModelsDevIndex, modelID: string, providerID?: string): ModelsDevHit | undefined {
  if (!modelID) return undefined
  const free = modelID.toLowerCase().endsWith("-free")
  const key = bareModelName(modelID).toLowerCase()
  const rows = index[key] ?? []
  const row = providerID ? rowForProvider(rows, providerID.toLowerCase(), modelID) : resolvedRow(rows, modelID)
  return row ? { row, tier: free ? " Free" : "" } : undefined
}

export function lookup(data: ModelsDevApi, modelID: string): ModelsDevHit | undefined {
  return lookupInIndex(buildIndex(data), modelID)
}
