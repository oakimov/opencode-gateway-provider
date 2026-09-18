/**
 * Read gateway provider blocks from on-disk OpenCode config.
 *
 * OpenCode 2 migrates `provider` to `providers` in memory and does not give
 * user plugins `Config.Service`, so this reads the same files the host loads.
 * Later documents overlay earlier ones. A provider that already lists models
 * is left for the host.
 */

import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENAI_COMPATIBLE_NPM, OPENAI_ELIGIBLE_NPMS, OPENAI_NPM } from "../model.js"
import { parseJsonc } from "./jsonc.js"

const DEFAULT_API_KEY_ENV = "GATEWAY_API_KEY"
const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"] as const
const NESTED_DIRS = [".opencode", ".claude", ".agents"] as const

export type ConfiguredProvider = {
  id: string
  name?: string
  package?: string
  env: string[]
  baseURL?: string
  apiKeyEnv?: string
  autoDiscover?: boolean
  /** Set when at least one config document declares a non-empty models map. */
  models?: Record<string, unknown>
  settings: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

type ParsedProvider = ConfiguredProvider & {
  nameSpecified: boolean
  packageSpecified: boolean
  envSpecified: boolean
  baseURLSpecified: boolean
  apiKeyEnvSpecified: boolean
  autoDiscoverSpecified: boolean
  modelsSpecified: boolean
  headersSpecified: boolean
  bodySpecified: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function optionString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function unwrapPackage(pkg?: string) {
  if (!pkg) return undefined
  return pkg.startsWith("aisdk:") ? pkg.slice("aisdk:".length) : pkg
}

/** Map a native or `aisdk:` package back to the npm id eligibility understands. */
export function eligibilityNpm(pkg?: string) {
  const name = unwrapPackage(pkg)
  if (!name) return undefined
  if (name === "@opencode/ai/providers/openai" || name === OPENAI_NPM) return OPENAI_NPM
  if (name === "@opencode/ai/providers/openai-compatible" || name === OPENAI_COMPATIBLE_NPM) {
    return OPENAI_COMPATIBLE_NPM
  }
  return name
}

export function isEligible(provider: ConfiguredProvider, scoped?: readonly string[]) {
  if (scoped && !scoped.includes(provider.id)) return false
  if (!provider.baseURL) return false
  if (provider.autoDiscover === false) return false
  if (provider.autoDiscover === true) return true
  const npm = eligibilityNpm(provider.package)
  return !npm || OPENAI_ELIGIBLE_NPMS.has(npm)
}

export function resolveApiKey(provider: ConfiguredProvider, env: NodeJS.ProcessEnv = process.env) {
  const names = [provider.apiKeyEnv, ...provider.env, DEFAULT_API_KEY_ENV].filter(
    (name): name is string => Boolean(name),
  )
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const value = env[name]
    if (value) return { name, value }
  }
  return {}
}

function configDirectory(env: NodeJS.ProcessEnv, home: string) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
}

function ancestors(start: string) {
  const result: string[] = []
  let current = path.resolve(start)
  for (;;) {
    result.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return result.reverse()
}

function configFiles(directory: string, env: NodeJS.ProcessEnv, home: string) {
  const files: string[] = []
  const seen = new Set<string>()
  const add = (filename: string) => {
    const resolved = path.resolve(filename)
    if (seen.has(resolved)) return
    seen.add(resolved)
    files.push(resolved)
  }
  const globalDir = path.resolve(configDirectory(env, home))
  for (const name of CONFIG_NAMES) add(path.join(globalDir, name))
  if (env.OPENCODE_CONFIG) add(env.OPENCODE_CONFIG)

  const projectDirs = ancestors(directory).filter((dir) => dir !== globalDir)
  for (const dir of projectDirs) {
    for (const name of CONFIG_NAMES) add(path.join(dir, name))
  }
  // `.opencode` (and the compatibility dirs) outrank a sibling opencode.json,
  // matching the host: project directories are applied after direct files.
  for (const dir of projectDirs) {
    for (const folder of NESTED_DIRS) {
      for (const name of CONFIG_NAMES) add(path.join(dir, folder, name))
    }
  }
  return files
}

async function readDocument(filename: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(filename, "utf8")
  } catch {
    return undefined
  }
  if (!text.trim()) return undefined
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    const parsed = parseJsonc(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function takeSettings(source: Record<string, unknown>, specified: boolean) {
  const settings = specified ? { ...source } : {}
  let baseURL: string | undefined
  let apiKeyEnv: string | undefined
  let autoDiscover: boolean | undefined
  let baseURLSpecified = false
  let apiKeyEnvSpecified = false
  let autoDiscoverSpecified = false
  if ("baseURL" in settings) {
    baseURLSpecified = true
    baseURL = optionString(settings.baseURL)
    delete settings.baseURL
  }
  if ("apiKeyEnv" in settings) {
    apiKeyEnvSpecified = true
    apiKeyEnv = optionString(settings.apiKeyEnv)
    delete settings.apiKeyEnv
  }
  if ("autoDiscover" in settings) {
    autoDiscoverSpecified = true
    autoDiscover = typeof settings.autoDiscover === "boolean" ? settings.autoDiscover : undefined
    delete settings.autoDiscover
  }
  const headersSpecified = "headers" in settings
  const bodySpecified = "body" in settings
  const headers = headersSpecified ? stringMap(settings.headers) : undefined
  const body = bodySpecified && isRecord(settings.body) ? { ...settings.body } : undefined
  delete settings.headers
  delete settings.body
  return {
    settings,
    baseURL,
    apiKeyEnv,
    autoDiscover,
    baseURLSpecified,
    apiKeyEnvSpecified,
    autoDiscoverSpecified,
    headers,
    body,
    headersSpecified,
    bodySpecified,
  }
}

function parseProvider(id: string, value: unknown, version: "v1" | "v2"): ParsedProvider | undefined {
  if (!id || !isRecord(value)) return undefined
  const fromSettings = version === "v2" ? (isRecord(value.settings) ? value.settings : {}) : isRecord(value.options) ? value.options : {}
  const settingsSpecified = version === "v2" ? "settings" in value : "options" in value
  const taken = takeSettings(fromSettings, settingsSpecified)
  const packageName = optionString(value.package) ?? optionString(value.npm)
  const directHeaders = "headers" in value
  const directBody = "body" in value
  const headers = directHeaders ? stringMap(value.headers) : taken.headers
  const body = directBody && isRecord(value.body) ? { ...value.body } : taken.body
  let baseURL = taken.baseURL
  let baseURLSpecified = taken.baseURLSpecified
  if (!baseURLSpecified && optionString(value.api)) {
    baseURL = optionString(value.api)
    baseURLSpecified = true
  }
  const models = isRecord(value.models) ? value.models : undefined
  return {
    id,
    name: typeof value.name === "string" && value.name ? value.name : undefined,
    nameSpecified: typeof value.name === "string" && value.name.length > 0,
    package: packageName,
    packageSpecified: packageName !== undefined,
    env: stringList(value.env),
    envSpecified: "env" in value,
    baseURL,
    baseURLSpecified,
    apiKeyEnv: taken.apiKeyEnv,
    apiKeyEnvSpecified: taken.apiKeyEnvSpecified,
    autoDiscover: taken.autoDiscover,
    autoDiscoverSpecified: taken.autoDiscoverSpecified,
    models: models && Object.keys(models).length > 0 ? models : undefined,
    modelsSpecified: "models" in value && isRecord(value.models),
    settings: taken.settings,
    headers,
    headersSpecified: directHeaders || taken.headersSpecified,
    body,
    bodySpecified: directBody || taken.bodySpecified,
  }
}

function providersIn(doc: Record<string, unknown>) {
  const map = new Map<string, ParsedProvider>()
  const apply = (id: string, value: unknown, version: "v1" | "v2") => {
    const parsed = parseProvider(id, value, version)
    if (!parsed) return
    const previous = map.get(id)
    map.set(id, previous ? overlay(previous, parsed) : parsed)
  }
  if (isRecord(doc.provider)) {
    for (const [id, value] of Object.entries(doc.provider)) apply(id, value, "v1")
  }
  if (isRecord(doc.providers)) {
    for (const [id, value] of Object.entries(doc.providers)) apply(id, value, "v2")
  }
  return [...map.values()]
}

function overlay(base: ParsedProvider, next: ParsedProvider): ParsedProvider {
  const models = next.modelsSpecified ? { ...(base.models ?? {}), ...(next.models ?? {}) } : base.models
  return {
    ...base,
    name: next.nameSpecified ? next.name : base.name,
    nameSpecified: base.nameSpecified || next.nameSpecified,
    package: next.packageSpecified ? next.package : base.package,
    packageSpecified: base.packageSpecified || next.packageSpecified,
    env: next.envSpecified ? next.env : base.env,
    envSpecified: base.envSpecified || next.envSpecified,
    baseURL: next.baseURLSpecified ? next.baseURL : base.baseURL,
    baseURLSpecified: base.baseURLSpecified || next.baseURLSpecified,
    apiKeyEnv: next.apiKeyEnvSpecified ? next.apiKeyEnv : base.apiKeyEnv,
    apiKeyEnvSpecified: base.apiKeyEnvSpecified || next.apiKeyEnvSpecified,
    autoDiscover: next.autoDiscoverSpecified ? next.autoDiscover : base.autoDiscover,
    autoDiscoverSpecified: base.autoDiscoverSpecified || next.autoDiscoverSpecified,
    models: models && Object.keys(models).length > 0 ? models : undefined,
    modelsSpecified: base.modelsSpecified || next.modelsSpecified,
    settings: { ...base.settings, ...next.settings },
    headers: next.headersSpecified ? next.headers : base.headers,
    headersSpecified: base.headersSpecified || next.headersSpecified,
    body: next.bodySpecified ? next.body : base.body,
    bodySpecified: base.bodySpecified || next.bodySpecified,
  }
}

function publish(provider: ParsedProvider): ConfiguredProvider {
  return {
    id: provider.id,
    name: provider.name,
    package: provider.package,
    env: provider.env,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    autoDiscover: provider.autoDiscover,
    models: provider.models,
    settings: provider.settings,
    headers: provider.headers,
    body: provider.body,
  }
}

export async function readConfiguredProviders(input: {
  directory: string
  env?: NodeJS.ProcessEnv
  home?: string
}): Promise<ConfiguredProvider[]> {
  const env = input.env ?? process.env
  const home = input.home ?? os.homedir()
  const map = new Map<string, ParsedProvider>()
  const apply = (provider: ParsedProvider) => {
    const previous = map.get(provider.id)
    map.set(provider.id, previous ? overlay(previous, provider) : provider)
  }
  for (const filename of configFiles(input.directory, env, home)) {
    const doc = await readDocument(filename)
    if (!doc) continue
    for (const provider of providersIn(doc)) apply(provider)
  }
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      const parsed = parseJsonc(env.OPENCODE_CONFIG_CONTENT)
      if (isRecord(parsed)) {
        for (const provider of providersIn(parsed)) apply(provider)
      }
    } catch {
      // Invalid inline config is ignored; file documents still apply.
    }
  }
  return [...map.values()].map(publish)
}
