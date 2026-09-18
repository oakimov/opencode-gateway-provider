import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { GatewayProvider } from "./plugin.js"
import plugin from "./plugin-opencode2.js"
import index from "./index.js"
import { catalogFromKvValue, loadCatalog } from "./opencode2/catalog.js"
import { readConfiguredProviders } from "./opencode2/config.js"
import type { PluginContext, ProviderEditor } from "./opencode2/types.js"

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

let root = ""
let catalogFile = ""
const envKeys = [
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_MODELS_PATH",
  "OPENCODE_MODELS_URL",
  "OPENCODE_DB",
  "GATEWAY_MODEL_OVERRIDES",
  "LITELLM_API_KEY",
] as const
const saved = new Map<string, string | undefined>()

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-opencode2-"))
  catalogFile = path.join(root, "models.json")
  await writeFile(catalogFile, JSON.stringify(CATALOG))
  for (const key of envKeys) saved.set(key, process.env[key])
})

afterAll(async () => {
  for (const key of envKeys) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

afterEach(async () => {
  for (const key of envKeys) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function useFixtureEnv(configDir: string) {
  process.env.OPENCODE_CONFIG_DIR = configDir
  process.env.OPENCODE_MODELS_PATH = catalogFile
  process.env.GATEWAY_MODEL_OVERRIDES = path.join(root, "missing-overrides.json")
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_CONTENT
  delete process.env.OPENCODE_MODELS_URL
  delete process.env.OPENCODE_DB
}

type Harness = {
  ctx: PluginContext
  added: Array<{ info: { id: string; package: string; settings?: Record<string, unknown> }; models: Array<{ id: string; variants: Array<{ id: string; settings?: Record<string, unknown> }> }> }>
  hooks: Record<string, (event: any) => void>
  emit(event: { type?: string }): void
  nextReload(): Promise<void>
}

function harness(directory: string, options?: PluginContext["options"]): Harness {
  const added: Harness["added"] = []
  const hooks: Harness["hooks"] = {}
  let transform: ((editor: ProviderEditor) => void) | undefined
  let pending: ((value: { type?: string } | null) => void) | undefined
  const queued: Array<{ type?: string } | null> = []
  let reloadWait: (() => void) | undefined

  const deliver = () => {
    if (!pending) return
    const next = queued.shift()
    if (next === undefined) return
    const resolve = pending
    pending = undefined
    resolve(next)
  }

  const ctx: PluginContext = {
    options,
    location: { directory },
    provider: {
      transform: async (callback) => {
        transform = callback
        return { dispose: async () => undefined }
      },
      reload: async () => {
        transform?.({
          add(input) {
            added.push(input as Harness["added"][number])
          },
        })
        reloadWait?.()
        reloadWait = undefined
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback
        return { dispose: async () => undefined }
      },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (queued.length > 0) {
                const value = queued.shift()!
                if (value === null) return { value: undefined, done: true as const }
                return { value, done: false as const }
              }
              return new Promise((resolve) => {
                pending = (value) => {
                  if (value === null) resolve({ value: undefined, done: true })
                  else resolve({ value, done: false })
                }
              })
            },
          }
        },
      }),
    },
  }

  return {
    ctx,
    added,
    hooks,
    emit(event) {
      queued.push(event)
      deliver()
    },
    nextReload() {
      return new Promise((resolve) => {
        reloadWait = resolve
      })
    },
  }
}

describe("OpenCode 2 plugin", () => {
  test("keeps the 1.x default export and exposes the 2.0 entry on server", () => {
    expect(typeof index).toBe("function")
    expect(index).toBe(GatewayProvider)
    expect(plugin.id).toBe("gateway.provider")
    expect(plugin.server).toBe(GatewayProvider)
  })

  test("publishes discovered models with native package and raw effort variants", async () => {
    const configDir = path.join(root, "config-publish")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        providers: {
          litellm: {
            package: "@ai-sdk/openai-compatible",
            settings: {
              baseURL: "https://gateway.example.com/v1",
              apiKeyEnv: "LITELLM_API_KEY",
              autoDiscover: true,
            },
            env: ["LITELLM_API_KEY"],
          },
        },
      }),
    )
    useFixtureEnv(configDir)
    process.env.LITELLM_API_KEY = "test-key"
    const original = globalThis.fetch
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      expect(String(request)).toBe("https://gateway.example.com/v1/models")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key")
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "mystery-model" }] }), {
        status: 200,
      })
    }) as typeof fetch
    const host = harness(path.join(root, "project-publish"))
    const cleanup = await plugin.setup(host.ctx)
    try {
      expect(host.added).toHaveLength(1)
      const entry = host.added[0]!
      expect(entry.info.package).toBe("@opencode/ai/providers/openai-compatible")
      expect(entry.info.settings).toMatchObject({
        baseURL: "https://gateway.example.com/v1",
        provider: "litellm",
        apiKey: "test-key",
      })
      expect(entry.info.settings).not.toHaveProperty("apiKeyEnv")
      expect(entry.info.settings).not.toHaveProperty("autoDiscover")
      const flash = entry.models.find((model) => model.id === "deepseek-v4-flash")
      expect(flash).toMatchObject({
        name: "DeepSeek V4 Flash",
        family: "deepseek",
        providerID: "litellm",
        modelID: "deepseek-v4-flash",
        status: "active",
        enabled: true,
        limit: { context: 128_000, output: 8192 },
        time: { released: Date.parse("2026-01-01") },
      })
      expect(flash?.variants.map((variant) => variant.id)).toEqual(["low", "high", "max"])
      expect(JSON.stringify(flash?.variants)).not.toContain("disabled")
      expect(JSON.stringify(flash?.variants)).not.toContain("Extra High")
      expect(entry.models.find((model) => model.id === "mystery-model")?.variants).toEqual([])
      host.hooks["model.request"]?.({
        sessionID: "ses_test",
        model: { providerID: "litellm" },
        headers: {},
      })
      const headers: Record<string, string> = {}
      host.hooks["model.request"]?.({ sessionID: "ses_test", model: { providerID: "litellm" }, headers })
      expect(headers).toEqual({ "x-litellm-session-id": "ses_test" })
      const other: Record<string, string> = {}
      host.hooks["model.request"]?.({ sessionID: "ses_test", model: { providerID: "other" }, headers: other })
      expect(other).toEqual({})
    } finally {
      globalThis.fetch = original
      await cleanup?.()
    }
  })

  test("skips providers that already declare models and does not replace an empty fetch", async () => {
    const configDir = path.join(root, "config-skip")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, "opencode.jsonc"),
      `{
        // gateway
        "provider": {
          "litellm": {
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "https://gateway.example.com/v1", "autoDiscover": false, },
          },
          "declared": {
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "https://declared.example/v1" },
            "models": { "kept": { "name": "Kept" } },
          },
          "empty": {
            "options": { "baseURL": "https://empty.example/v1" },
          },
        },
      }`,
    )
    useFixtureEnv(configDir)
    const original = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (request: string | URL | Request) => {
      urls.push(String(request))
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch
    const host = harness(path.join(root, "project-skip"))
    const cleanup = await plugin.setup(host.ctx)
    try {
      expect(urls).toEqual(["https://empty.example/v1/models"])
      expect(host.added).toEqual([])
    } finally {
      globalThis.fetch = original
      await cleanup?.()
    }
  })

  test("keeps the last good inventory when a later discovery fails", async () => {
    const configDir = path.join(root, "config-retain")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        providers: {
          litellm: {
            settings: { baseURL: "https://gateway.example.com/v1" },
          },
        },
      }),
    )
    useFixtureEnv(configDir)
    const original = globalThis.fetch
    let fail = false
    globalThis.fetch = (async () => {
      if (fail) return new Response("nope", { status: 500 })
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })
    }) as typeof fetch
    const host = harness(path.join(root, "project-retain"))
    const cleanup = await plugin.setup(host.ctx)
    try {
      expect(host.added.at(-1)?.models.map((model) => model.id)).toEqual(["deepseek-v4-flash"])
      fail = true
      host.added.length = 0
      const reloaded = host.nextReload()
      host.emit({ type: "config.updated" })
      await reloaded
      expect(host.added.at(-1)?.models.map((model) => model.id)).toEqual(["deepseek-v4-flash"])
    } finally {
      globalThis.fetch = original
      await cleanup?.()
    }
  })

  test("scopes discovery and maps a forced non-openai package onto aisdk", async () => {
    const configDir = path.join(root, "config-scope")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        providers: {
          litellm: { settings: { baseURL: "https://gateway.example.com/v1" } },
          forced: {
            package: "@ai-sdk/anthropic",
            settings: { baseURL: "https://forced.example/v1", autoDiscover: true },
          },
        },
      }),
    )
    useFixtureEnv(configDir)
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })) as typeof fetch
    const host = harness(path.join(root, "project-scope"), { providers: ["forced"] })
    const cleanup = await plugin.setup(host.ctx)
    try {
      expect(host.added).toHaveLength(1)
      expect(host.added[0]?.info.id).toBe("forced")
      expect(host.added[0]?.info.package).toBe("aisdk:@ai-sdk/anthropic")
    } finally {
      globalThis.fetch = original
      await cleanup?.()
    }
  })

  test("uses reasoning summary variants for the openai package", async () => {
    const configDir = path.join(root, "config-openai")
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        providers: {
          openai: {
            package: "@ai-sdk/openai",
            settings: { baseURL: "https://gateway.example.com/v1" },
          },
        },
      }),
    )
    useFixtureEnv(configDir)
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), { status: 200 })) as typeof fetch
    const host = harness(path.join(root, "project-openai"))
    const cleanup = await plugin.setup(host.ctx)
    try {
      expect(host.added[0]?.info.package).toBe("@opencode/ai/providers/openai")
      const variants = host.added[0]?.models[0]?.variants ?? []
      expect(variants.find((variant) => variant.id === "low")?.settings).toEqual({ reasoningEffort: "low" })
      expect(variants.find((variant) => variant.id === "high")?.settings).toEqual({
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    } finally {
      globalThis.fetch = original
      await cleanup?.()
    }
  })
})

describe("OpenCode 2 config and catalog", () => {
  test("project jsonc overlays the global provider block", async () => {
    const configDir = path.join(root, "config-merge")
    const project = path.join(root, "project-merge")
    await mkdir(configDir, { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        provider: {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://global.example/v1", apiKeyEnv: "GLOBAL_KEY" },
          },
        },
      }),
    )
    await writeFile(
      path.join(project, "opencode.jsonc"),
      `{
        "providers": {
          "litellm": { "settings": { "baseURL": "https://project.example/v1" } }
        }
      }`,
    )
    const providers = await readConfiguredProviders({
      directory: project,
      env: {
        OPENCODE_CONFIG_DIR: configDir,
        HOME: root,
      },
      home: root,
    })
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({
      id: "litellm",
      baseURL: "https://project.example/v1",
      apiKeyEnv: "GLOBAL_KEY",
      package: "@ai-sdk/openai-compatible",
    })
  })

  test("reads the models.dev catalog from the OpenCode 2 kv row", async () => {
    expect(catalogFromKvValue(JSON.stringify({ updatedAt: 1, body: JSON.stringify(CATALOG) }))).toMatchObject({
      deepseek: { id: "deepseek" },
    })
    const dataHome = path.join(root, "data-home")
    const dir = path.join(dataHome, "opencode")
    await mkdir(dir, { recursive: true })
    const db = new DatabaseSync(path.join(dir, "opencode-local.db"))
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(
      "models-dev:catalog",
      JSON.stringify({ updatedAt: 1, body: JSON.stringify(CATALOG) }),
    )
    db.close()
    const catalog = await loadCatalog({ XDG_DATA_HOME: dataHome, HOME: root }, root)
    expect(catalog.find((row) => row.id === "deepseek-v4-flash")?.name).toBe("DeepSeek V4 Flash")
  })
})
