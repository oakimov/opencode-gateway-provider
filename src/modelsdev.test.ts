import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildIndex,
  catalogFile,
  catalogHost,
  getCatalog,
  lookup,
  lookupInIndex,
  parseModelsDevCatalog,
  type ModelsDevApi,
  type ModelsDevModel,
} from "./modelsdev.js"

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
  model("deepseek/deepseek-v4-flash", "openrouter"),
  model("deepseek-v4-flash", "deepseek", { name: "DeepSeek V4 Flash" }),
  model("TEE/kimi-k3", "nano-gpt", { name: "Kimi K3 TEE" }),
  model("moonshotai/kimi-k3", "opencode", { name: "Kimi K3" }),
  model("cline-pass/kimi-k3", "cline-pass", { name: "Kimi K3" }),
  model("kimi-k3", "greenpt", { name: "Kimi K3" }),
  model("kimi-k3", "moonshotai", {
    name: "Kimi K3",
    variants: [
      { id: "low", headers: {}, body: {} },
      { id: "high", headers: {}, body: {} },
      { id: "max", headers: {}, body: {} },
    ],
  }),
  model("nemotron-3-super-free", "opencode", { name: "Nemotron 3 Super Free" }),
  model("nemotron-3-ultra-free", "opencode", { name: "Nemotron 3 Ultra Free" }),
  model("deepseek-v4-flash-free", "opencode", { name: "DeepSeek V4 Flash Free" }),
  model("laguna-s-2.1-free", "opencode", { name: "Laguna S 2.1 Free" }),
  model("poolside/laguna-s-2.1-free", "vercel", { name: "Laguna S 2.1 Free" }),
  model("poolside/laguna-s-2.1:free", "openrouter", { name: "Laguna S 2.1 (free)" }),
]

describe("lookup", () => {
  test("uses a unique exact bare model match", () => {
    expect(lookup(FIXTURE, "claude-3-5-sonnet")?.row.providerID).toBe("anthropic")
  })

  test("uses a provider-qualified model ID only when that complete ID matches", () => {
    expect(lookup(FIXTURE, "moonshotai/kimi-k3")?.row.providerID).toBe("opencode")
  })

  test("resolves duplicate model IDs only through the native provider namespace", () => {
    expect(lookup(FIXTURE, "kimi-k3")?.row.providerID).toBe("moonshotai")
    expect(lookup(FIXTURE, "kimi-k3")?.row.name).toBe("Kimi K3")
    expect(lookup(FIXTURE, "kimi-k3")?.row.variants.map((variant) => variant.id)).toEqual(["low", "high", "max"])
  })

  test("does not select a TEE or reseller row for an ambiguous native model", () => {
    expect(lookup(FIXTURE, "kimi-k3")?.row.id).toBe("kimi-k3")
    expect(lookup(FIXTURE, "kimi-k3")?.row.providerID).not.toBe("nano-gpt")
    expect(lookup(FIXTURE, "kimi-k3")?.row.providerID).not.toBe("opencode")
  })

  test("uses the native provider with the strongest independent namespace evidence", () => {
    const luna = [
      model("gpt-5.6-luna", "openai", { name: "GPT-5.6 Luna (OpenAI)" }),
      model("gpt-5.6-luna", "azure", { name: "GPT-5.6 Luna (Azure)" }),
      model("openai/gpt-5.6-luna", "openrouter"),
      model("openai/gpt-5.6-luna", "nano-gpt"),
      model("azure/gpt-5.6-luna", "llmgateway-providers"),
    ]
    expect(lookup(luna, "gpt-5.6-luna")?.row.providerID).toBe("openai")
    expect(lookup(luna, "gpt-5.6-luna")?.row.name).toBe("GPT-5.6 Luna (OpenAI)")
  })

  test("does not select a native provider when namespace evidence is tied", () => {
    const tied = [
      model("gpt-5.6-luna", "openai"),
      model("gpt-5.6-luna", "azure"),
      model("openai/gpt-5.6-luna", "openrouter"),
      model("azure/gpt-5.6-luna", "llmgateway-providers"),
    ]
    expect(lookup(tied, "gpt-5.6-luna")).toBeUndefined()
  })

  test("does not collapse a qualified catalog ID onto a missing bare ID", () => {
    const apiOnlyQualified = [
      model("openai/gpt-5.6-luna-pro", "nano-gpt"),
      model("openai/gpt-5.6-luna-pro", "openrouter"),
    ]
    expect(lookup(apiOnlyQualified, "gpt-5.6-luna-pro")).toBeUndefined()
  })

  test("accepts an exact model ID exposed by only one provider", () => {
    expect(lookup(FIXTURE, "nemotron-3-super-free")?.row.providerID).toBe("opencode")
    expect(lookup(FIXTURE, "nemotron-3-ultra-free")?.row.providerID).toBe("opencode")
    expect(lookup(FIXTURE, "deepseek-v4-flash-free")?.row.providerID).toBe("opencode")
    expect(lookup(FIXTURE, "laguna-s-2.1-free")?.row.providerID).toBe("opencode")
  })

  test("returns no match when multiple providers have no unique native namespace", () => {
    const ambiguous = [
      model("orphan-model", "reseller-a"),
      model("reseller-a/orphan-model", "reseller-a"),
      model("orphan-model", "reseller-b"),
    ]
    expect(lookup(ambiguous, "orphan-model")).toBeUndefined()
  })

  test("does not perform substring or family fallback", () => {
    expect(lookup(FIXTURE, "vendor-claude-3-5-sonnet-preview")).toBeUndefined()
  })

  test("preserves the explicit -free suffix during lookup", () => {
    const hit = lookup(FIXTURE, "deepseek-v4-flash-free")
    expect(hit?.row.id).toBe("deepseek-v4-flash-free")
    expect(hit?.tier).toBe(" Free")
  })

  test("does not reuse a paid row when a -free ID is missing", () => {
    expect(lookup(FIXTURE, "kimi-k3-free")).toBeUndefined()
  })

  test("returns undefined for an unknown or empty model", () => {
    expect(lookup(FIXTURE, "definitely-not-real")).toBeUndefined()
    expect(lookup(FIXTURE, "")).toBeUndefined()
  })
})

describe("lookupInIndex", () => {
  const index = buildIndex(FIXTURE)

  test("has the same exact-match behavior as lookup", () => {
    expect(lookupInIndex(index, "claude-3-5-sonnet")?.row.name).toBe("Claude 3.5 Sonnet")
    expect(lookupInIndex(index, "kimi-k3")?.row.providerID).toBe("moonshotai")
  })
})

describe("getCatalog", () => {
  function inputWith(headers: Record<string, string>): PluginInput {
    return {
      directory: "/tmp/project",
      client: {
        _client: {
          getConfig() {
            return { headers }
          },
          get() {
            throw new Error("getCatalog must not call a host route")
          },
        },
      },
    } as unknown as PluginInput
  }

  test("identifies the native host from its client directory header", () => {
    expect(catalogHost(inputWith({ "x-opencode-directory": "/tmp/project" }), {})).toBe("opencode")
    expect(catalogHost(inputWith({ "x-kilo-directory": "/tmp/project" }), {})).toBe("kilo")
    expect(catalogHost(inputWith({ "x-mimocode-directory": "/tmp/project" }), {})).toBe("mimo")
  })

  test("honors OCP's explicit host configuration before native client hints", () => {
    expect(catalogHost(
      inputWith({ "x-opencode-directory": "/tmp/project" }),
      { OPENCODE_COMPAT_HOST: "mimo" },
    )).toBe("mimo")
  })

  test("uses only unambiguous host configuration when client config is unavailable", () => {
    const input = { directory: "/tmp/project", client: {} } as unknown as PluginInput
    expect(catalogHost(input, { KILO_MODELS_PATH: "/cache/models.json" })).toBe("kilo")
    expect(() => catalogHost(input, {
      KILO_MODELS_PATH: "/cache/kilo.json",
      MIMOCODE_HOME: "/tmp/mimo",
    })).toThrow(
      "multiple catalog owners",
    )
    expect(() => catalogHost(input, {})).toThrow("Cannot identify")
  })

  test("mirrors each host's default and configured cache rules", () => {
    expect(catalogFile("opencode", {}, "/Users/test")).toBe("/Users/test/.cache/opencode/models.json")
    expect(catalogFile("kilo", { XDG_CACHE_HOME: "/mapped/cache" }, "/Users/test")).toBe(
      "/mapped/cache/kilo/models.json",
    )
    expect(catalogFile("kilo", { XDG_CACHE_HOME: "/mapped/cache\n" }, "/Users/test")).toBe(
      "/mapped/cache/kilo/models.json",
    )
    expect(catalogFile("mimo", { MIMOCODE_HOME: "/profiles/mimo" }, "/Users/test")).toBe(
      "/profiles/mimo/cache/models.json",
    )
  })

  test("honors the exact per-host models path before cache conventions", () => {
    expect(catalogFile("opencode", { OPENCODE_MODELS_PATH: "/catalog/open.json" })).toBe("/catalog/open.json")
    expect(catalogFile("kilo", { KILO_MODELS_PATH: "relative/kilo.json" })).toBe("relative/kilo.json")
    expect(catalogFile("mimo", { MIMOCODE_MODELS_PATH: "/catalog/mimo.json" })).toBe("/catalog/mimo.json")
  })

  test("uses the host's SHA-1 cache filename for a custom models URL", () => {
    expect(catalogFile(
      "opencode",
      { OPENCODE_MODELS_URL: "https://catalog.example", XDG_CACHE_HOME: "/cache" },
      "/Users/test",
    )).toBe("/cache/opencode/models-871608c17971dbac7e10503763c16cb91f1a52f7.json")
  })

  test("rejects the same relative MIMOCODE_HOME that the native host rejects", () => {
    expect(() => catalogFile("mimo", { MIMOCODE_HOME: "relative/profile" }, "/Users/test")).toThrow(
      "MIMOCODE_HOME must be absolute",
    )
  })

  test("reads the exact host-owned file directly without calling a host route", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-models-"))
    const filename = path.join(directory, "models.json")
    try {
      await writeFile(filename, JSON.stringify(RAW_CATALOG))
      const result = await getCatalog(
        inputWith({ "x-mimocode-directory": "/tmp/project" }),
        { MIMOCODE_MODELS_PATH: filename },
      )
      expect(lookup(result, "kimi-k3")?.row.providerID).toBe("moonshotai")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects invalid JSON instead of treating it as an empty catalog", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-models-"))
    const filename = path.join(directory, "models.json")
    try {
      await writeFile(filename, "{")
      await expect(getCatalog(
        inputWith({ "x-opencode-directory": "/tmp/project" }),
        { OPENCODE_MODELS_PATH: filename },
      )).rejects.toThrow("not valid JSON")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects an explicitly empty models path instead of falling back", async () => {
    await expect(getCatalog(
      inputWith({ "x-kilo-directory": "/tmp/project" }),
      { KILO_MODELS_PATH: "" },
    )).rejects.toThrow(
      "KILO_MODELS_PATH is empty",
    )
  })
})

const KIMI = {
  id: "kimi-k3",
  name: "Kimi K3",
  family: "kimi-k3",
  attachment: true,
  reasoning: true,
  reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
  tool_call: true,
  temperature: false,
  interleaved: { field: "reasoning_content" },
  release_date: "2026-07-16",
  modalities: { input: ["text", "image", "video"], output: ["text"] },
  limit: { context: 1_048_576, output: 131_072 },
  cost: { input: 3, output: 15, cache_read: 0.3 },
}

const RAW_CATALOG = {
  opencode: {
    id: "opencode",
    npm: "@ai-sdk/openai-compatible",
    models: { "moonshotai/kimi-k3": { ...KIMI, id: "moonshotai/kimi-k3", reasoning_options: [] } },
  },
  greenpt: {
    id: "greenpt",
    npm: "@ai-sdk/openai-compatible",
    models: { "kimi-k3": { ...KIMI, reasoning_options: [{ type: "effort", values: ["none", "high"] }] } },
  },
  moonshotai: {
    id: "moonshotai",
    npm: "@ai-sdk/openai-compatible",
    models: { "kimi-k3": KIMI },
  },
}

describe("models.dev cache", () => {
  test("parses raw metadata and preserves only explicit effort values", () => {
    const rows = parseModelsDevCatalog(RAW_CATALOG)
    expect(lookup(rows, "kimi-k3")?.row).toMatchObject({
      id: "kimi-k3",
      providerID: "moonshotai",
      name: "Kimi K3",
      family: "kimi-k3",
      variants: [{ id: "low" }, { id: "high" }, { id: "max" }],
      limit: { context: 1_048_576, output: 131_072 },
      interleaved: { field: "reasoning_content" },
    })
  })

  test("does not invent variant names for toggle or token-budget options", () => {
    const rows = parseModelsDevCatalog({
      native: {
        id: "native",
        models: {
          toggle: { ...KIMI, id: "toggle", reasoning_options: [{ type: "toggle" }] },
          budget: { ...KIMI, id: "budget", reasoning_options: [{ type: "budget_tokens", min: 1024 }] },
        },
      },
    })
    expect(lookup(rows, "toggle")?.row.variants).toEqual([])
    expect(lookup(rows, "budget")?.row.variants).toEqual([])
  })

  test("treats missing temperature as false", () => {
    const rows = parseModelsDevCatalog({
      native: { id: "native", models: { plain: { id: "plain", name: "Plain" } } },
    })
    expect(lookup(rows, "plain")?.row.capabilities.temperature).toBe(false)
  })
})
