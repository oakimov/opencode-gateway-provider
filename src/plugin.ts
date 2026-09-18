/**
 * Gateway provider plugin for opencode.
 *
 * Registers via the `config` hook (the same mechanism cursor-opencode-provider
 * uses): the hook runs before opencode builds its provider registry, so
 * injecting `provider.<id>.models` lets any custom OpenAI-compatible gateway
 * get its model list auto-discovered from `{baseURL}/v1/models` and enriched
 * with models.dev metadata.
 *
 * A provider is eligible for discovery when its block in opencode.json has a
 * `options.baseURL` and no explicitly declared `models`. To avoid hijacking
 * providers whose models come from the models.dev catalog, discovery applies
 * only to OpenAI-compatible npm packages (`@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or an
 * unset `npm`), unless explicitly forced:
 *
 *   "provider": {
 *     "litellm": {
 *       "npm": "@ai-sdk/openai-compatible",
 *       "options": { "baseURL": "https://gateway.example.com/v1" },
 *       "env": ["LITELLM_API_KEY"]
 *     }
 *   }
 *
 * Per-provider overrides:
 *   - `options.autoDiscover: true`  force discovery regardless of npm package
 *   - `options.autoDiscover: false` opt a baseURL provider out
 *   - `options.apiKeyEnv`           env var holding the API key (falls back to
 *                                   the provider's `env` names, then
 *                                   `GATEWAY_API_KEY`)
 *
 * The plugin can also be scoped to specific provider ids via plugin options:
 *
 *   "plugin": [["opencode-gateway-provider", { "providers": ["litellm"] }]]
 */

import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import { listModelIds } from "./gateway.js"
import { buildModel, type ConfigModel } from "./model.js"
import {
  buildIndex,
  getCatalog,
  lookupInIndex,
} from "./modelsdev.js"
import { applyModelOverride, getOverrides, overrideFor } from "./overrides.js"

/** @deprecated Kept for backwards compatibility; discovery now applies to any eligible provider id. */
export const GATEWAY_PROVIDER_ID = "gateway"
const DEFAULT_API_KEY_ENV = "GATEWAY_API_KEY"
const OPENAI_NPM = "@ai-sdk/openai"
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
const OPENAI_ELIGIBLE_NPMS = new Set([OPENAI_NPM, OPENAI_COMPATIBLE_NPM])

export type GatewayPluginOptions = {
  /** When set, only these provider ids are considered for discovery. */
  providers?: string[]
}

type ProviderOptions = { baseURL?: unknown; apiKeyEnv?: unknown; autoDiscover?: unknown; [key: string]: unknown }

type ProviderConfig = {
  npm?: string
  env?: string[]
  models?: Record<string, ConfigModel>
  options?: ProviderOptions
  [key: string]: unknown
}

type GatewayConfig = Config & {
  provider?: Record<string, ProviderConfig | undefined>
}
type ChatHeadersHook = NonNullable<Hooks["chat.headers"]>

function optionString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

async function logError(input: PluginInput, message: string) {
  await input.client.app
    .log({
      body: {
        service: "opencode-gateway-provider",
        level: "error",
        message,
      },
    })
    .catch(() => undefined)
}

async function discoverModels(input: PluginInput, baseURL: string, apiKey: string | undefined, providerNpm?: string): Promise<Record<string, ConfigModel>> {
  const ids = await listModelIds(baseURL, apiKey)
  const catalog = await getCatalog(input).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    await logError(input, `Failed to read the host model catalog; using defaults: ${message}`)
    return []
  })
  const index = buildIndex(catalog)
  const overrides = await getOverrides(input).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    await logError(input, message)
    return {}
  })
  const models: Record<string, ConfigModel> = {}
  for (const id of ids) {
    const override = overrideFor(overrides, id)
    const hit = lookupInIndex(index, id, override?.provider)
    models[id] = applyModelOverride(buildModel(id, hit, baseURL, providerNpm), override, id)
  }
  return models
}

function isEligible(
  providerID: string,
  provider: ProviderConfig,
  options: ProviderOptions | undefined,
  scoped: string[] | undefined,
): boolean {
  if (scoped && !scoped.includes(providerID)) return false
  // An OpenAI-compatible npm (or an unset npm) with a baseURL is treated as a
  // gateway. Providers using dedicated SDKs (e.g. "@ai-sdk/anthropic") are
  // only discovered when explicitly forced with autoDiscover: true.
  if (options?.autoDiscover === false) return false
  if (options?.autoDiscover === true) return true
  const npm = optionString(provider.npm)
  return !npm || OPENAI_ELIGIBLE_NPMS.has(npm)
}

function resolveApiKey(provider: ProviderConfig, options: ProviderOptions | undefined) {
  const explicit = optionString(options?.apiKeyEnv)
  if (explicit) {
    const value = process.env[explicit]
    if (value) return { name: explicit, value }
  }
  for (const name of provider.env ?? []) {
    const value = process.env[name]
    if (value) return { name, value }
  }
  const value = process.env[DEFAULT_API_KEY_ENV]
  return value ? { name: DEFAULT_API_KEY_ENV, value } : {}
}

export async function GatewayProvider(input: PluginInput, options?: GatewayPluginOptions): Promise<Hooks> {
  const scoped = options?.providers?.length ? [...options.providers] : undefined
  return {
    async "chat.headers"(
      request: Parameters<ChatHeadersHook>[0],
      output: Parameters<ChatHeadersHook>[1],
    ) {
      if (request.model.providerID !== "litellm") return
      // LiteLLM records this recognized header as the request's session/trace id.
      output.headers["x-litellm-session-id"] = request.sessionID
    },
    async config(cfg: Config) {
      const config = cfg as GatewayConfig
      config.provider ??= {}
      for (const [providerID, value] of Object.entries(config.provider)) {
        const provider = value as ProviderConfig | undefined
        if (!provider) continue
        const opts = provider.options
        const baseURL = optionString(opts?.baseURL)
        const eligible = Boolean(baseURL) && isEligible(providerID, provider, opts, scoped)
        // Resolve the key while apiKeyEnv is still on opts (consumed below).
        const credential = resolveApiKey(provider, opts)

        // These control discovery only. OpenCode forwards provider.options to
        // the AI SDK, so consume them before provider construction.
        if (opts) {
          delete opts.apiKeyEnv
          delete opts.autoDiscover
        }

        if (!baseURL || !eligible) continue

        // Wire the resolved API key into the provider's env so opencode can
        // inject it. Runs for every eligible provider (even when models are
        // declared explicitly) but skips opted-out / dedicated-SDK providers.
        if (credential.name && !provider.env?.includes(credential.name)) {
          provider.env = [...(provider.env ?? []), credential.name]
        }

        // Respect models the user declared explicitly; only fill the gap.
        if (provider.models && Object.keys(provider.models).length > 0) continue

        provider.npm ??= OPENAI_COMPATIBLE_NPM
        try {
          const models = await discoverModels(input, baseURL, credential.value, provider.npm)
          if (Object.keys(models).length > 0) {
            provider.models = models
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await logError(input, `Failed to discover models for provider ${providerID}: ${message}`)
        }
      }
    },
  }
}

export default GatewayProvider
