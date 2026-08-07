import { describe, expect, test } from "bun:test"
import { GatewayProvider, GATEWAY_PROVIDER_ID } from "./plugin.js"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/types"

const CATALOG: ModelV2Info[] = [
  {
    id: "deepseek-v4-flash",
    providerID: "opencode",
    name: "DeepSeek V4 Flash",
    family: "deepseek",
    api: { id: "deepseek-v4-flash", type: "native", settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: Date.parse("2026-01-01") },
    cost: [{ input: 0.2, output: 0.6, cache: { read: 0.05, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: 8192 },
  },
]

function pluginInput(onCatalogRequest?: (options: { url?: string }) => void): PluginInput {
  return {
    directory: "/tmp/project",
    client: {
      _client: {
        get: async (options: { url?: string }) => {
          onCatalogRequest?.(options)
          return { data: { location: { directory: "/tmp/project" }, data: CATALOG } }
        },
      },
    },
  } as unknown as PluginInput
}

describe("config hook", () => {
  test("fills /v1/models slugs using opencode's internal model API", async () => {
    const original = globalThis.fetch
    let catalogURL: string | undefined
    globalThis.fetch = (async (request: string | URL | Request) => {
      expect(String(request)).toBe("https://gateway.example.com/v1/models")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "mystery-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    try {
      process.env.GATEWAY_API_KEY = "sk-test"
      const hooks = await GatewayProvider(pluginInput((options) => (catalogURL = options.url)))
      const cfg = {
        provider: {
          [GATEWAY_PROVIDER_ID]: { options: { baseURL: "https://gateway.example.com/v1" } },
        },
      }
      await hooks.config?.(cfg as never)

      expect(catalogURL).toBe("/api/model")
      const models = cfg.provider[GATEWAY_PROVIDER_ID].models as Record<string, Record<string, unknown>>
      expect(Object.keys(models).sort()).toEqual(["deepseek-v4-flash", "mystery-model"])
      expect(models["deepseek-v4-flash"]).toMatchObject({
        name: "DeepSeek V4 Flash",
        family: "deepseek",
        cost: { input: 0.2, output: 0.6, cache_read: 0.05 },
        limit: { context: 128000, output: 8192 },
      })
      expect(models["mystery-model"]).toMatchObject({
        name: "mystery-model",
        reasoning: true,
        tool_call: true,
        limit: { context: 200000, output: 0 },
      })
    } finally {
      delete process.env.GATEWAY_API_KEY
      globalThis.fetch = original
    }
  })

  test("keeps explicitly declared models untouched", async () => {
    const hooks = await GatewayProvider(pluginInput())
    const declared = { "my-model": { name: "My Model", cost: { input: 1, output: 2 } } }
    const cfg = {
      provider: {
        [GATEWAY_PROVIDER_ID]: {
          options: { baseURL: "https://gateway.example.com/v1" },
          models: declared,
        },
      },
    }
    await hooks.config?.(cfg as never)
    expect(cfg.provider[GATEWAY_PROVIDER_ID].models).toBe(declared)
  })

  test("no-ops when baseURL is missing", async () => {
    const hooks = await GatewayProvider(pluginInput())
    const cfg = { provider: { [GATEWAY_PROVIDER_ID]: { options: {} } } }
    await hooks.config?.(cfg as never)
    expect(cfg.provider[GATEWAY_PROVIDER_ID].models).toBeUndefined()
  })

  test("discovers a generic provider id and uses its env key", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (_request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer litellm-key")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })
    }) as typeof fetch
    try {
      process.env.LITELLM_API_KEY = "litellm-key"
      const hooks = await GatewayProvider(pluginInput())
      const cfg = {
        provider: {
          litellm: {
            options: { baseURL: "https://gateway.example.com/v1" },
            env: ["LITELLM_API_KEY"],
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.litellm.models).toBeDefined()
      expect(cfg.provider.litellm.npm).toBe("@ai-sdk/openai-compatible")
    } finally {
      delete process.env.LITELLM_API_KEY
      globalThis.fetch = original
    }
  })

  test("options.apiKeyEnv takes precedence over provider env", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (_request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit-key")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })
    }) as typeof fetch
    try {
      process.env.EXPLICIT_GATEWAY_KEY = "explicit-key"
      process.env.LITELLM_API_KEY = "provider-key"
      const hooks = await GatewayProvider(pluginInput())
      const cfg = {
        provider: {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://gateway.example.com/v1", apiKeyEnv: "EXPLICIT_GATEWAY_KEY" },
            env: ["LITELLM_API_KEY"],
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.litellm.models).toBeDefined()
      expect(cfg.provider.litellm.env).toContain("EXPLICIT_GATEWAY_KEY")
      expect("apiKeyEnv" in cfg.provider.litellm.options).toBe(false)
    } finally {
      delete process.env.EXPLICIT_GATEWAY_KEY
      delete process.env.LITELLM_API_KEY
      globalThis.fetch = original
    }
  })


  test("an unset apiKeyEnv falls back to provider env", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (_request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-key")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })
    }) as typeof fetch
    try {
      delete process.env.MISSING_GATEWAY_KEY
      process.env.LITELLM_API_KEY = "provider-key"
      const hooks = await GatewayProvider(pluginInput())
      const cfg = {
        provider: {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://gateway.example.com/v1", apiKeyEnv: "MISSING_GATEWAY_KEY" },
            env: ["LITELLM_API_KEY"],
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.litellm.models).toBeDefined()
    } finally {
      delete process.env.LITELLM_API_KEY
      globalThis.fetch = original
    }
  })

  test("autoDiscover false wins over plugin provider scoping", async () => {
    const hooks = await GatewayProvider(pluginInput(), { providers: ["litellm"] })
    const cfg = {
      provider: {
        litellm: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://gateway.example.com/v1", autoDiscover: false },
        },
      },
    }
    await hooks.config?.(cfg as never)
    expect(cfg.provider.litellm.models).toBeUndefined()
    expect("autoDiscover" in cfg.provider.litellm.options).toBe(false)
  })

  test("autoDiscover false does not mutate provider env", async () => {
    process.env.LITELLM_API_KEY = "litellm-key"
    try {
      const hooks = await GatewayProvider(pluginInput())
      const cfg = {
        provider: {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://gateway.example.com/v1", autoDiscover: false },
            env: ["LITELLM_API_KEY"],
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.litellm.models).toBeUndefined()
      expect(cfg.provider.litellm.env).toEqual(["LITELLM_API_KEY"])
    } finally {
      delete process.env.LITELLM_API_KEY
    }
  })

  test("a dedicated-SDK provider without autoDiscover is left alone", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant"
    try {
      const hooks = await GatewayProvider(pluginInput())
      const cfg = {
        provider: {
          anthropic: {
            npm: "@ai-sdk/anthropic",
            options: { baseURL: "https://gateway.example.com/v1" },
            env: ["ANTHROPIC_API_KEY"],
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.anthropic.models).toBeUndefined()
      expect(cfg.provider.anthropic.env).toEqual(["ANTHROPIC_API_KEY"])
      expect(cfg.provider.anthropic.npm).toBe("@ai-sdk/anthropic")
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  test("logs internal Catalog failures without breaking config loading", async () => {
    const original = globalThis.fetch
    let logMessage = ""
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })) as typeof fetch
    const input = {
      directory: "/tmp/project",
      client: {
        _client: { get: async () => { throw new Error("Catalog unavailable") } },
        app: { log: async ({ body }: { body: { message: string } }) => { logMessage = body.message } },
      },
    } as unknown as PluginInput
    try {
      const hooks = await GatewayProvider(input)
      const cfg = {
        provider: {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://gateway.example.com/v1" },
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.litellm.models).toBeUndefined()
      expect(logMessage).toContain("Failed to discover models for provider litellm: Catalog unavailable")
    } finally {
      globalThis.fetch = original
    }
  })
})