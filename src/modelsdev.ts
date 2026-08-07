/**
 * Access and search opencode's models.dev-backed v2 Catalog.
 *
 * The plugin input carries the classic SDK client. Its generated wrapper owns
 * the authenticated transport opencode configured for plugins, including the
 * in-process fetch implementation used when no HTTP server is listening. SDK
 * 1.18.15's v2 client is constructed over that same transport, then
 * `model.list()` calls the typed `/api/model` endpoint.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { OpencodeClient as OpencodeV2Client } from "@opencode-ai/sdk/v2/client"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/types"
import type { Client as V2Transport } from "@opencode-ai/sdk/v2/gen/client"

const PROVIDER_PREFERENCE = ["opencode", "opencode-go", "deepseek", "openrouter"]

export type ModelsDevModel = ModelV2Info
export type ModelsDevApi = ModelV2Info[]
export type ModelsDevHit = {
  row: ModelsDevModel
  /** " Free" when the gateway slug ends in "-free". */
  tier: string
}

type ClassicClientWithTransport = {
  _client?: V2Transport
}

function v2Client(input: PluginInput) {
  const transport = (input.client as unknown as ClassicClientWithTransport)._client
  if (!transport) throw new Error("opencode plugin client transport is unavailable")
  return new OpencodeV2Client({ client: transport })
}

export async function getCatalog(input: PluginInput): Promise<ModelsDevApi> {
  const result = await v2Client(input).v2.model.list(
    { location: { directory: input.directory } },
    { throwOnError: true },
  )
  return Array.isArray(result.data?.data) ? result.data.data : []
}

function bareId(key: string) {
  const slash = key.indexOf("/")
  return slash === -1 ? key : key.slice(slash + 1)
}

type IndexRow = { provider: string; model: ModelsDevModel }

export type ModelsDevIndex = Record<string, IndexRow[]>

export function buildIndex(data: ModelsDevApi): ModelsDevIndex {
  const index: ModelsDevIndex = {}
  for (const model of data) {
    const bare = bareId(model.id).toLowerCase()
    ;(index[bare] ??= []).push({ provider: model.providerID, model })
  }
  return index
}

function pickRow(rows: IndexRow[]): IndexRow | undefined {
  if (rows.length === 0) return undefined
  const byProvider = new Map(rows.map((row) => [row.provider, row]))
  for (const preferred of PROVIDER_PREFERENCE) {
    const hit = byProvider.get(preferred)
    if (hit) return hit
  }
  return rows[0]
}

function substringSearch(index: ModelsDevIndex, needle: string): IndexRow[] | undefined {
  const nl = needle.toLowerCase()
  let best: IndexRow[] | undefined
  let bestLen = Number.POSITIVE_INFINITY
  for (const [bare, rows] of Object.entries(index)) {
    if (bare.includes(nl) && bare.length < bestLen) {
      best = rows
      bestLen = bare.length
    }
  }
  if (best) return best

  let longest: IndexRow[] | undefined
  let longestLen = 0
  for (const [bare, rows] of Object.entries(index)) {
    // Reject tiny generic ids inside a much longer gateway slug. Without the
    // coverage check, Catalog's `auto` row incorrectly captures ids such as
    // `cursor-auto` and `codex-auto-review`.
    if (nl.includes(bare) && bare.length * 2 >= nl.length && bare.length > longestLen) {
      longest = rows
      longestLen = bare.length
    }
  }
  return longest
}

function lookupOnce(index: ModelsDevIndex, modelID: string): IndexRow[] | undefined {
  const bare = bareId(modelID).toLowerCase()
  return index[bare] ?? substringSearch(index, bare)
}

/**
 * Look up a gateway model slug in a prebuilt index. Provider prefixes on
 * gateway ids are stripped; provider preference is only a deterministic
 * tie-break when Catalog providers expose the same slug.
 */
export function lookupInIndex(index: ModelsDevIndex, modelID: string): ModelsDevHit | undefined {
  if (!modelID) return undefined
  const tier = modelID.toLowerCase().endsWith("-free") ? " Free" : ""

  const hit = lookupOnce(index, modelID)
  const row = hit ? pickRow(hit) : undefined
  if (row) return { row: row.model, tier }

  if (tier) {
    const bare = bareId(modelID).toLowerCase().slice(0, -"-free".length)
    const fallback = index[bare] ?? substringSearch(index, bare)
    const fallbackRow = fallback ? pickRow(fallback) : undefined
    if (fallbackRow) return { row: fallbackRow.model, tier }
  }
  return undefined
}

/**
 * Convenience wrapper that builds the index on each call. Prefer
 * `buildIndex` + `lookupInIndex` when looking up many ids against the same
 * catalog.
 */
export function lookup(data: ModelsDevApi, modelID: string): ModelsDevHit | undefined {
  return lookupInIndex(buildIndex(data), modelID)
}