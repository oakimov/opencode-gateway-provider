import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GatewayProvider, GATEWAY_PROVIDER_ID } from "./plugin.js"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const CATALOG = {
  deepseek: {
    id: "deepseek",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        family: "deepseek",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        tool_call: true,
        temperature: false,
        release_date: "2026-01-01",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128_000, output: 8192 },
        cost: { input: 0.2, output: 0.6, cache_read: 0.05 },
      },
    },
  },
}

let catalogDirectory = ""
let catalogFile = ""
let originalCatalogPath: string | undefined
let originalOverridePath: string | undefined

beforeAll(async () => {
  catalogDirectory = await mkdtemp(path.join(os.tmpdir(), "gateway-plugin-models-"))
  catalogFile = path.join(catalogDirectory, "models.json")
  await writeFile(catalogFile, JSON.stringify(CATALOG))
  originalCatalogPath = process.env.OPENCODE_MODELS_PATH
  originalOverridePath = process.env.GATEWAY_MODEL_OVERRIDES
  process.env.OPENCODE_MODELS_PATH = catalogFile
  process.env.GATEWAY_MODEL_OVERRIDES = path.join(catalogDirectory, "missing-overrides.json")
})

afterAll(async () => {
  if (originalCatalogPath === undefined) delete process.env.OPENCODE_MODELS_PATH
  else process.env.OPENCODE_MODELS_PATH = originalCatalogPath
  if (originalOverridePath === undefined) delete process.env.GATEWAY_MODEL_OVERRIDES
  else process.env.GATEWAY_MODEL_OVERRIDES = originalOverridePath
  await rm(catalogDirectory, { recursive: true, force: true })
})

function pluginInput(): PluginInput {
  return {
    directory: "/tmp/project",
    client: {
      _client: {
        getConfig: () => ({
          headers: { "x-opencode-directory": "/tmp/project" },
        }),
        get: () => {
          throw new Error("catalog discovery must not call a host route")
        },
      },
      app: { log: async () => undefined },
    },
  } as unknown as PluginInput
}

describe("config hook", () => {
  test("fills /v1/models slugs using the host's cached models.dev catalog", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (request: string | URL | Request) => {
      expect(String(request)).toBe("https://gateway.example.com/v1/models")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "mystery-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    try {
      process.env.GATEWAY_API_KEY = "sk-test"
      const hooks = await GatewayProvider(pluginInput())
      const cfg: any = {
        provider: {
          [GATEWAY_PROVIDER_ID]: { options: { baseURL: "https://gateway.example.com/v1" } },
        },
      }
      await hooks.config?.(cfg as never)

      const models = cfg.provider[GATEWAY_PROVIDER_ID].models as Record<string, Record<string, unknown>>
      expect(Object.keys(models).sort()).toEqual(["deepseek-v4-flash", "mystery-model"])
      expect(models["deepseek-v4-flash"]).toMatchObject({
        name: "DeepSeek V4 Flash",
        family: "deepseek",
        reasoning: true,
        cost: { input: 0.2, output: 0.6, cache_read: 0.05 },
        limit: { context: 128000, output: 8192 },
        variants: {
          none: { disabled: true },
          low: { disabled: true },
          Low: { reasoningEffort: "low" },
          high: { disabled: true },
          High: { reasoningEffort: "high" },
          max: { disabled: true },
          Max: { reasoningEffort: "max" },
        },
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
    const cfg: any = {
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
    const cfg: any = { provider: { [GATEWAY_PROVIDER_ID]: { options: {} } } }
    await hooks.config?.(cfg as never)
    expect(cfg.provider[GATEWAY_PROVIDER_ID].models).toBeUndefined()
  })

  test("discovers a generic provider id and uses its env key", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer litellm-key")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })
    }) as typeof fetch
    try {
      process.env.LITELLM_API_KEY = "litellm-key"
      const hooks = await GatewayProvider(pluginInput())
      const cfg: any = {
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
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit-key")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })
    }) as typeof fetch
    try {
      process.env.EXPLICIT_GATEWAY_KEY = "explicit-key"
      process.env.LITELLM_API_KEY = "provider-key"
      const hooks = await GatewayProvider(pluginInput())
      const cfg: any = {
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
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-key")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })
    }) as typeof fetch
    try {
      delete process.env.MISSING_GATEWAY_KEY
      process.env.LITELLM_API_KEY = "provider-key"
      const hooks = await GatewayProvider(pluginInput())
      const cfg: any = {
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
    const cfg: any = {
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
      const cfg: any = {
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
      const cfg: any = {
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

  test("override provider steers catalog lookup and variant translation", async () => {
    const original = globalThis.fetch
    const overrideFile = path.join(catalogDirectory, "gateway-model-overrides.json")
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })) as unknown as typeof fetch
    await writeFile(
      overrideFile,
      JSON.stringify({
        models: {
          "deepseek-v4-flash": {
            provider: "deepseek",
            variants: ["low", "xhigh"],
          },
        },
      }),
    )
    const previousOverride = process.env.GATEWAY_MODEL_OVERRIDES
    process.env.GATEWAY_MODEL_OVERRIDES = overrideFile
    try {
      const hooks = await GatewayProvider(pluginInput())
      const cfg: any = {
        provider: {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://gateway.example.com/v1" },
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.litellm.models?.["deepseek-v4-flash"]).toMatchObject({
        name: "DeepSeek V4 Flash",
        variants: {
          Low: { reasoningEffort: "low" },
          "Extra High": { reasoningEffort: "xhigh" },
        },
      })
      expect(cfg.provider.litellm.models?.["deepseek-v4-flash"]?.variants?.xhigh).toEqual({ disabled: true })
    } finally {
      if (previousOverride === undefined) delete process.env.GATEWAY_MODEL_OVERRIDES
      else process.env.GATEWAY_MODEL_OVERRIDES = previousOverride
      await rm(overrideFile, { force: true })
      globalThis.fetch = original
    }
  })

  test("override pricing does not apply to -free slugs", async () => {
    const original = globalThis.fetch
    const overrideFile = path.join(catalogDirectory, "gateway-model-overrides.json")
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash-free" }] }), { status: 200 })) as unknown as typeof fetch
    await writeFile(
      overrideFile,
      JSON.stringify({
        models: {
          "deepseek-v4-flash": { pricing: { input: 9, output: 9 } },
        },
      }),
    )
    const previousOverride = process.env.GATEWAY_MODEL_OVERRIDES
    process.env.GATEWAY_MODEL_OVERRIDES = overrideFile
    try {
      const hooks = await GatewayProvider(pluginInput())
      const cfg: any = {
        provider: {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://gateway.example.com/v1" },
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.litellm.models?.["deepseek-v4-flash-free"]).toMatchObject({
        cost: { input: 0, output: 0 },
      })
    } finally {
      if (previousOverride === undefined) delete process.env.GATEWAY_MODEL_OVERRIDES
      else process.env.GATEWAY_MODEL_OVERRIDES = previousOverride
      await rm(overrideFile, { force: true })
      globalThis.fetch = original
    }
  })

  test("logs catalog failures and still emits discovered models with defaults", async () => {
    const original = globalThis.fetch
    const configuredCatalog = process.env.OPENCODE_MODELS_PATH
    let logMessage = ""
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })) as unknown as typeof fetch
    process.env.OPENCODE_MODELS_PATH = path.join(catalogDirectory, "missing.json")
    const input = {
      directory: "/tmp/project",
      client: {
        _client: {
          getConfig: () => ({ headers: { "x-opencode-directory": "/tmp/project" } }),
        },
        app: { log: async ({ body }: { body: { message: string } }) => { logMessage = body.message } },
      },
    } as unknown as PluginInput
    try {
      const hooks = await GatewayProvider(input)
      const cfg: any = {
        provider: {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://gateway.example.com/v1" },
          },
        },
      }
      await hooks.config?.(cfg as never)
      expect(cfg.provider.litellm.models?.["deepseek-v4-flash"]).toMatchObject({
        name: "deepseek-v4-flash",
        reasoning: true,
        tool_call: true,
      })
      expect(logMessage).toContain("Failed to read the host model catalog; using defaults:")
      expect(logMessage).toContain("missing.json")
    } finally {
      if (configuredCatalog === undefined) delete process.env.OPENCODE_MODELS_PATH
      else process.env.OPENCODE_MODELS_PATH = configuredCatalog
      globalThis.fetch = original
    }
  })
})
