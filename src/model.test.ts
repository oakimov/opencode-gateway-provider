import { describe, expect, test } from "bun:test"
import { buildModel } from "./model.js"
import type { ModelsDevHit, ModelsDevModel } from "./modelsdev.js"

const BASE_URL = "https://gateway.example.com/v1"

function hit(overrides: Partial<ModelsDevModel> = {}, tier = ""): ModelsDevHit {
  return {
    tier,
    row: {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      family: "claude",
      api: { id: "claude-3-5-sonnet", type: "native", settings: {} },
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      request: { headers: {}, body: {} },
      variants: [],
      time: { released: Date.parse("2024-06-20") },
      cost: [
        { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        { tier: { type: "context", size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
      ],
      status: "active",
      enabled: true,
      limit: { context: 200_000, output: 8192 },
      ...overrides,
    },
  }
}

describe("buildModel", () => {
  test("unknown model gets generous defaults", () => {
    expect(buildModel("mystery-model", undefined, BASE_URL)).toMatchObject({
      name: "mystery-model",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      cost: { input: 0, output: 0 },
      limit: { context: 200000, output: 0 },
      provider: { npm: "@ai-sdk/openai-compatible", api: BASE_URL },
    })
  })

  test("maps Catalog metadata to config metadata", () => {
    expect(buildModel("claude-3-5-sonnet", hit(), BASE_URL)).toMatchObject({
      name: "Claude 3.5 Sonnet",
      family: "claude",
      release_date: "2024-06-20",
      attachment: true,
      tool_call: true,
      cost: {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_write: 3.75,
        context_over_200k: { input: 6, output: 22.5, cache_read: 0.6, cache_write: 7.5 },
      },
      limit: { context: 200000, output: 8192 },
      modalities: { input: ["text", "image"], output: ["text"] },
    })
  })

  test("Catalog capability negatives are honored", () => {
    const result = buildModel(
      "tiny",
      hit({ capabilities: { tools: false, input: ["text"], output: ["text"] } }),
      BASE_URL,
    )
    expect(result.tool_call).toBe(false)
    expect(result.attachment).toBe(false)
  })

  test("-free tier appends Free once and never inherits paid cost", () => {
    const result = buildModel("deepseek-v4-flash-free", hit({ name: "DeepSeek V4 Flash" }, " Free"), BASE_URL)
    expect(result.name).toBe("DeepSeek V4 Flash Free")
    expect(result.cost).toEqual({ input: 0, output: 0 })
  })

  test("does not duplicate Free when Catalog name already includes it", () => {
    const result = buildModel("mimo-v2.5-free", hit({ name: "MiMo V2.5 Free" }, " Free"), BASE_URL)
    expect(result.name).toBe("MiMo V2.5 Free")
  })

  test("tolerates a cost entry without a cache field", () => {
    const result = buildModel(
      "no-cache-model",
      hit({ cost: [{ input: 1, output: 2 }] }),
      BASE_URL,
    )
    expect(result.cost).toMatchObject({ input: 1, output: 2 })
    expect(result.cost?.cache_read).toBeUndefined()
    expect(result.cost?.cache_write).toBeUndefined()
  })

  test("tolerates a context-tier cost entry without a cache field", () => {
    const result = buildModel(
      "no-cache-model",
      hit({
        cost: [
          { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
          { tier: { type: "context", size: 200_000 }, input: 5, output: 10 },
        ],
      }),
      BASE_URL,
    )
    expect(result.cost?.context_over_200k).toMatchObject({ input: 5, output: 10 })
    expect(result.cost?.context_over_200k?.cache_read).toBeUndefined()
    expect(result.cost?.context_over_200k?.cache_write).toBeUndefined()
  })
})