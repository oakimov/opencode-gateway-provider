/**
 * Model id discovery from an OpenAI-compatible gateway.
 *
 * The gateway's model list is fetched from `{baseURL}/v1/models` (or
 * `{baseURL}/models` when the configured baseURL already ends in `/v1`),
 * authenticated with the bearer key, and reduced to the ordered id list. The
 * gateway slug is kept verbatim — it is what the gateway expects on chat
 * requests.
 */

export type GatewayModelEntry = {
  id?: unknown
  [key: string]: unknown
}

export type GatewayModelsResponse = {
  data?: Array<string | GatewayModelEntry>
}

export function modelsEndpoint(baseURL: string) {
  const base = baseURL.replace(/\/+$/, "")
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`
}

export function parseModelIds(data: GatewayModelsResponse | string[]): string[] {
  if (Array.isArray(data)) {
    return data.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  }
  const list = data?.data
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    if (typeof entry === "string") return entry.length > 0 ? [entry] : []
    const id = entry?.id
    return typeof id === "string" && id.length > 0 ? [id] : []
  })
}

export async function listModelIds(baseURL: string, apiKey?: string): Promise<string[]> {
  const url = modelsEndpoint(baseURL)
  const headers: Record<string, string> = { accept: "application/json" }
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Failed to fetch model list from ${url}: ${res.status}`)
  const ids = parseModelIds((await res.json()) as GatewayModelsResponse | string[])
  if (ids.length === 0) throw new Error(`Empty model list from ${url}`)
  return ids
}
