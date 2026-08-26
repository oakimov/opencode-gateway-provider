import { describe, expect, test } from "bun:test"
import { buildModel } from "./model.js"
import type { ModelsDevHit, ModelsDevModel } from "./modelsdev.js"

const BASE_URL = "https://gateway.example.com/v1"

type CostOverride = {
  input: number
  output: number
  cache?: { read?: number; write?: number }
  tier?: { type: "context"; size: number }
}

function hit(overrides: Omit<Partial<ModelsDevModel>, "cost"> & { cost?: CostOverride[] } = {}, tier = ""): ModelsDevHit {
  const { cost, ...rest } = overrides
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
      status: "active",
      enabled: true,
      limit: { context: 200_000, output: 8192 },
      ...rest,
      cost: (cost ?? [
        { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        { tier: { type: "context", size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
      ]) as ModelsDevModel["cost"],
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
    expect(buildModel("mystery-model", undefined, BASE_URL).variants).toBeUndefined()
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
    expect(result.interleaved).toBeUndefined()
    expect(result.variants).toBeUndefined()
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

  test("emits translated labels without raw effort keys", () => {
    const result = buildModel(
      "claude-opus-4-6",
      hit({
        variants: [
          { id: "low", headers: {}, body: { reasoningEffort: "low" } },
          { id: "max", headers: {}, body: { reasoningEffort: "max" } },
          { id: "xhigh", headers: {}, body: { reasoningEffort: "xhigh" } },
        ],
      }),
      BASE_URL,
    )
    expect(result.variants).toMatchObject({
      none: { disabled: true },
      default: { disabled: true },
      minimal: { disabled: true },
      low: { disabled: true },
      Low: { reasoningEffort: "low" },
      medium: { disabled: true },
      high: { disabled: true },
      max: { disabled: true },
      Max: { reasoningEffort: "max" },
      xhigh: { disabled: true },
      "Extra High": { reasoningEffort: "xhigh" },
    })
    expect(result.reasoning).toBe(true)
  })

  test("keeps reasoning and disables raw keys so OpenCode's merge drops them", () => {
    const result = buildModel(
      "gpt-5.6-luna",
      hit({
        capabilities: { tools: true, input: ["text"], output: ["text"], reasoning: true } as ModelsDevModel["capabilities"],
        variants: [
          { id: "none", headers: {}, body: {} },
          { id: "low", headers: {}, body: {} },
          { id: "medium", headers: {}, body: {} },
          { id: "high", headers: {}, body: {} },
          { id: "xhigh", headers: {}, body: {} },
          { id: "max", headers: {}, body: {} },
        ],
      }),
      BASE_URL,
    )
    const generated: Record<string, Record<string, unknown>> = {
      none: { reasoningEffort: "none" },
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
      max: { reasoningEffort: "max" },
    }
    const merged = { ...generated, ...result.variants }
    const visible = Object.fromEntries(Object.entries(merged).filter(([, value]) => value.disabled !== true))
    expect(result.reasoning).toBe(true)
    expect(Object.keys(visible)).toEqual(["None", "Low", "Medium", "High", "Extra High", "Max"])
    expect(visible.none).toBeUndefined()
    expect(visible.None).toEqual({ reasoningEffort: "none" })
    expect(visible.xhigh).toBeUndefined()
    expect(visible["Extra High"]).toEqual({ reasoningEffort: "xhigh" })
  })

  test("does not add Responses-only fields for unknown effort tokens", () => {
    const result = buildModel(
      "odd-effort",
      hit({ variants: [{ id: "custom", headers: {}, body: {} }] }),
      BASE_URL,
      "@ai-sdk/openai",
    )
    expect(result.variants).toMatchObject({ custom: { reasoningEffort: "custom" } })
    expect(result.variants?.custom).toEqual({ reasoningEffort: "custom" })
  })

  test("does not inspect non-API reasoning option fields", () => {
    const result = buildModel(
      "toggle-reasoner",
      hit({
        variants: [],
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      } as Partial<ModelsDevModel>),
      BASE_URL,
    )
    expect(result.variants).toBeUndefined()
  })

  test("skips variants when Catalog marks the model non-reasoning", () => {
    const result = buildModel(
      "plain-chat",
      hit({
        capabilities: { tools: true, input: ["text"], output: ["text"], reasoning: false } as ModelsDevModel["capabilities"],
      }),
      BASE_URL,
    )
    expect(result.reasoning).toBe(false)
    expect(result.variants).toBeUndefined()
  })

  test("copies API variant IDs even when capability flags disagree", () => {
    const result = buildModel(
      "catalog-authoritative",
      hit({
        capabilities: { tools: true, input: ["text"], output: ["text"], reasoning: false } as ModelsDevModel["capabilities"],
        variants: [{ id: "high", headers: {}, body: { reasoningEffort: "high" } }],
      }),
      BASE_URL,
    )
    expect(result.variants).toMatchObject({
      high: { disabled: true },
      High: { reasoningEffort: "high" },
    })
    expect(result.reasoning).toBe(false)
  })

  test("omits catalog status unless it is alpha, beta, or deprecated", () => {
    expect(buildModel("ok", hit({ status: "active" }), BASE_URL).status).toBeUndefined()
    expect(buildModel("beta", hit({ status: "beta" }), BASE_URL).status).toBe("beta")
  })

  test("does not forward native-provider request headers or bodies", () => {
    const result = buildModel(
      "with-request",
      hit({
        request: {
          headers: { "X-Test": "1" },
          body: { store: false },
        },
      }),
      BASE_URL,
    )
    expect(result.headers).toBeUndefined()
    expect(result.options).toBeUndefined()
  })
})
