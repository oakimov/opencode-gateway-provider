import { describe, expect, test } from "bun:test"
import { buildIndex, getCatalog, lookup, lookupInIndex, type ModelsDevApi, type ModelsDevModel } from "./modelsdev.js"
import type { PluginInput } from "@opencode-ai/plugin"

function model(id: string, providerID: string, overrides: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return {
    id,
    providerID,
    name: id,
    api: { id, type: "native", settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: 8192 },
    ...overrides,
  }
}

const FIXTURE: ModelsDevApi = [
  model("claude-3-5-sonnet", "anthropic", { name: "Claude 3.5 Sonnet", family: "claude" }),
  model("claude-3-5-sonnet-20241022", "anthropic", { name: "Claude 3.5 Sonnet" }),
  model("deepseek-v4-flash", "openrouter", {
    name: "DeepSeek V4 Flash",
    cost: [{ input: 0.25, output: 0.75, cache: { read: 0, write: 0 } }],
  }),
  model("deepseek-v4-flash", "opencode", {
    name: "DeepSeek V4 Flash",
    family: "deepseek",
    cost: [{ input: 0.2, output: 0.6, cache: { read: 0.05, write: 0 } }],
  }),
  model("auto", "openrouter", { name: "Auto Router", family: "auto" }),
]

describe("lookup", () => {
  test("maps exact bare model slug", () => {
    expect(lookup(FIXTURE, "claude-3-5-sonnet")?.row.name).toBe("Claude 3.5 Sonnet")
  })

  test("strips a provider prefix from the gateway slug", () => {
    expect(lookup(FIXTURE, "anthropic/claude-3-5-sonnet")?.row.id).toBe("claude-3-5-sonnet")
  })

  test("prefers the configured catalog provider for duplicate slugs", () => {
    expect(lookup(FIXTURE, "deepseek-v4-flash")?.row.providerID).toBe("opencode")
  })

  test("uses the reference substring matching order", () => {
    expect(lookup(FIXTURE, "claude-3-5-sonnet-20241022")?.row.id).toBe("claude-3-5-sonnet-20241022")
    expect(lookup(FIXTURE, "vendor-claude-3-5-sonnet-preview")?.row.id).toBe("claude-3-5-sonnet")
  })

  test("does not let a short generic slug capture a longer gateway id", () => {
    expect(lookup(FIXTURE, "cursor-auto")).toBeUndefined()
    expect(lookup(FIXTURE, "codex-auto-review")).toBeUndefined()
  })

  test("preserves a -free gateway tier", () => {
    const hit = lookup(FIXTURE, "deepseek-v4-flash-free")
    expect(hit?.row.id).toBe("deepseek-v4-flash")
    expect(hit?.tier).toBe(" Free")
  })

  test("miss returns undefined", () => {
    expect(lookup(FIXTURE, "definitely-not-a-real-model-xyz")).toBeUndefined()
  })
})

describe("lookupInIndex", () => {
  const index = buildIndex(FIXTURE)

  test("produces the same result as lookup for an exact match", () => {
    expect(lookupInIndex(index, "claude-3-5-sonnet")?.row.name).toBe("Claude 3.5 Sonnet")
  })

  test("produces the same result as lookup for a -free tier", () => {
    const hit = lookupInIndex(index, "deepseek-v4-flash-free")
    expect(hit?.row.id).toBe("deepseek-v4-flash")
    expect(hit?.tier).toBe(" Free")
  })

  test("returns undefined for empty modelID", () => {
    expect(lookupInIndex(index, "")).toBeUndefined()
  })

  test("returns undefined for a miss", () => {
    expect(lookupInIndex(index, "no-such-model")).toBeUndefined()
  })
})

describe("getCatalog", () => {
  function inputWith(getResult: unknown): PluginInput {
    return {
      directory: "/tmp/project",
      client: { _client: { get: async () => getResult } },
    } as unknown as PluginInput
  }

  test("returns the data array on a well-formed response", async () => {
    const data: ModelsDevApi = [model("test-model", "opencode")]
    const result = await getCatalog(
      inputWith({ data: { location: { directory: "/tmp/project" }, data } }),
    )
    expect(result).toBe(data)
  })

  test("returns an empty array when data.data is missing", async () => {
    const result = await getCatalog(inputWith({ data: {} }))
    expect(result).toEqual([])
  })

  test("returns an empty array when the response shape is unexpected", async () => {
    const result = await getCatalog(inputWith({}))
    expect(result).toEqual([])
  })
})