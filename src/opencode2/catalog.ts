/**
 * OpenCode 2 stores the models.dev catalog in the global SQLite `kv` table,
 * not in the 1.x `models.json` cache. `OPENCODE_MODELS_PATH` still wins so
 * tests and explicit file overrides keep working. This never downloads a catalog.
 */

import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { PluginInput } from "@opencode-ai/plugin"
import { getCatalog, parseModelsDevCatalog, type ModelsDevApi } from "../modelsdev.js"
import { getOverrides, type ModelOverrides } from "../overrides.js"

const DEFAULT_SOURCE = "https://models.opencode.ai"

function environmentHas(env: NodeJS.ProcessEnv, name: string) {
  return Object.prototype.hasOwnProperty.call(env, name)
}

export function catalogCacheKey(source = DEFAULT_SOURCE) {
  if (source === DEFAULT_SOURCE) return "models-dev:catalog"
  return `models-dev:catalog:${createHash("sha1").update(source).digest("hex")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Decode a `kv.value` cell. The stored shape is `{ updatedAt, body }` and `body` is raw catalog JSON. */
export function catalogFromKvValue(value: unknown): unknown | undefined {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return catalogFromKvValue(value.toString("utf8"))
  let parsed = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return undefined
    }
  }
  if (!isRecord(parsed)) return undefined
  const body = "body" in parsed ? parsed.body : parsed
  if (typeof body === "string") {
    try {
      const inner = JSON.parse(body)
      return isRecord(inner) ? inner : undefined
    } catch {
      return undefined
    }
  }
  return isRecord(body) ? body : undefined
}

function dataDirectory(env: NodeJS.ProcessEnv, home: string) {
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode")
}

export async function databaseCandidates(env: NodeJS.ProcessEnv, home: string): Promise<string[]> {
  const dir = dataDirectory(env, home)
  const explicit = env.OPENCODE_DB?.trim()
  if (explicit) {
    if (explicit === ":memory:") return []
    return [path.isAbsolute(explicit) ? explicit : path.join(dir, explicit)]
  }
  const names = ["opencode.db"]
  const channelDisabled = env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  if (!channelDisabled) {
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      entries = []
    }
    const extras = entries.filter((name) => name.startsWith("opencode-") && name.endsWith(".db"))
    extras.sort((left, right) => {
      if (left === "opencode-local.db") return -1
      if (right === "opencode-local.db") return 1
      return left.localeCompare(right)
    })
    names.push(...extras)
  }
  return names.map((name) => path.join(dir, name))
}

async function readKv(filename: string, key: string): Promise<unknown> {
  let db: DatabaseSync | undefined
  try {
    const { DatabaseSync } = await import("node:sqlite")
    db = new DatabaseSync(filename, { readOnly: true })
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value?: unknown } | undefined
    return row?.value
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function hostStub(): PluginInput {
  return {
    client: {
      _client: {
        getConfig: () => ({ headers: { "x-opencode-directory": "/" } }),
      },
    },
  } as unknown as PluginInput
}

export async function loadCatalog(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<ModelsDevApi> {
  if (environmentHas(env, "OPENCODE_MODELS_PATH")) return getCatalog(hostStub(), env, home)

  const key = catalogCacheKey(env.OPENCODE_MODELS_URL || DEFAULT_SOURCE)
  for (const filename of await databaseCandidates(env, home)) {
    const value = await readKv(filename, key)
    if (value === undefined) continue
    const body = catalogFromKvValue(value)
    if (!body) continue
    try {
      return parseModelsDevCatalog(body)
    } catch {
      continue
    }
  }
  throw new Error("OpenCode 2 models.dev catalog is not cached")
}

export async function loadOverrides(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<ModelOverrides> {
  return getOverrides(hostStub(), env, home)
}
