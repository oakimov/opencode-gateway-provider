/**
 * OpenCode 2 plugin.
 *
 * OpenCode 2's Host.resolve loads `./server` before the package root. The root
 * export stays the 1.x function, so this module is the 2.0 entry
 * (`./server` and `./plugin/opencode2`). `server` is the 1.x plugin so a host
 * that calls `mod.server()` still gets the classic hooks.
 *
 * Models are published in memory with `ctx.provider.transform` + `editor.add`
 * + `reload()`. Nothing is written to opencode.json. An empty discovery does
 * not replace the last good list.
 */

import type { ModelOverrides } from "./overrides.js"
import type { ModelsDevApi } from "./modelsdev.js"
import { GatewayProvider } from "./plugin.js"
import { loadCatalog, loadOverrides } from "./opencode2/catalog.js"
import { isEligible, readConfiguredProviders, resolveApiKey, type ConfiguredProvider } from "./opencode2/config.js"
import { discoverGatewayModels } from "./opencode2/discover.js"
import { applyInventory, retarget, toPublished, variantNpm, type PublishedProvider } from "./opencode2/inventory.js"
import type { Cleanup, Plugin2, PluginContext, Registration } from "./opencode2/types.js"

const PLUGIN_ID = "gateway.provider"

function scopedProviders(options: PluginContext["options"]) {
  const providers = options?.providers
  if (!providers?.length) return undefined
  const ids = providers.filter((id) => id.length > 0)
  return ids.length > 0 ? ids : undefined
}

function watchConfig(ctx: PluginContext, onChange: () => void) {
  try {
    const stream = ctx.event?.subscribe?.()
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return () => undefined
    let stopped = false
    void (async () => {
      for await (const event of stream) {
        if (stopped) break
        if (event?.type === "config.updated") onChange()
      }
    })().catch(() => undefined)
    return () => {
      stopped = true
    }
  } catch {
    return () => undefined
  }
}

async function buildInventory(
  directory: string,
  scoped: readonly string[] | undefined,
  previous: ReadonlyMap<string, PublishedProvider>,
  catalog: ModelsDevApi,
  overrides: ModelOverrides,
): Promise<PublishedProvider[]> {
  const providers = await readConfiguredProviders({ directory })
  const next: PublishedProvider[] = []
  for (const provider of providers) {
    if (!isEligible(provider, scoped)) continue
    if (provider.models && Object.keys(provider.models).length > 0) continue
    const credential = resolveApiKey(provider)
    const kept = retain(previous.get(provider.id), provider, credential.value)
    try {
      const models = await discoverGatewayModels({
        baseURL: provider.baseURL!,
        apiKey: credential.value,
        providerNpm: variantNpm(provider.package),
        catalog,
        overrides,
      })
      const published = toPublished(provider, models, credential.value)
      if (published) next.push(published)
      else if (kept) next.push(kept)
    } catch {
      if (kept) next.push(kept)
    }
  }
  return next
}

function retain(
  previous: PublishedProvider | undefined,
  provider: ConfiguredProvider,
  apiKey: string | undefined,
) {
  if (!previous || previous.models.length === 0) return undefined
  return retarget(previous, provider, apiKey)
}

const plugin: Plugin2 & { server: typeof GatewayProvider } = {
  id: PLUGIN_ID,
  server: GatewayProvider,

  setup: async (ctx: PluginContext): Promise<Cleanup> => {
    if (typeof ctx.provider?.transform !== "function" || typeof ctx.provider.reload !== "function") {
      throw new Error("OpenCode 2 provider API is unavailable")
    }

    const directory = ctx.location?.directory || process.cwd()
    const scoped = scopedProviders(ctx.options)
    const registrations: Registration[] = []
    const track = async (value: Promise<Registration> | Registration) => {
      registrations.push(await value)
    }

    let published: PublishedProvider[] = []
    await track(
      ctx.provider.transform((editor) => {
        applyInventory(editor, published)
      }),
    )

    if (typeof ctx.session?.hook === "function") {
      await track(
        ctx.session.hook("model.request", (event) => {
          if (event.model?.providerID !== "litellm") return
          event.headers["x-litellm-session-id"] = event.sessionID
        }),
      )
    }

    let running = false
    let pending = false
    const refresh = async () => {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        do {
          pending = false
          const previous = new Map(published.map((entry) => [entry.id, entry]))
          let catalog: ModelsDevApi = []
          try {
            catalog = await loadCatalog()
          } catch {
            catalog = []
          }
          let overrides: ModelOverrides = {}
          try {
            overrides = await loadOverrides()
          } catch {
            overrides = {}
          }
          const next = await buildInventory(directory, scoped, previous, catalog, overrides)
          const snapshot = published
          published = next
          try {
            await ctx.provider.reload()
          } catch {
            published = snapshot
          }
        } while (pending)
      } finally {
        running = false
      }
    }

    const stopEvents = watchConfig(ctx, () => {
      void refresh()
    })
    await refresh()

    return async () => {
      stopEvents()
      for (const registration of registrations.reverse()) {
        await registration.dispose?.()
      }
    }
  },
}

export default plugin
