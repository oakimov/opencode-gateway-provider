import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildModel } from "./model.js"
import {
  applyModelOverride,
  getOverrides,
  overrideFile,
  overrideFor,
  parseOverrides,
} from "./overrides.js"

function inputWith(headers: Record<string, string>): PluginInput {
  return {
    directory: "/tmp/project",
    client: {
      _client: {
        getConfig() {
          return { headers }
        },
      },
    },
  } as unknown as PluginInput
}

describe("overrides", () => {
  test("defaults to the host cache file", () => {
    expect(overrideFile(inputWith({ "x-opencode-directory": "/tmp" }), {}, "/Users/test")).toBe(
      "/Users/test/.cache/opencode/gateway-model-overrides.json",
    )
    expect(overrideFile(inputWith({ "x-kilo-directory": "/tmp" }), { XDG_CACHE_HOME: "/mapped/cache" }, "/Users/test")).toBe(
      "/mapped/cache/kilo/gateway-model-overrides.json",
    )
    expect(overrideFile(inputWith({ "x-mimocode-directory": "/tmp" }), { MIMOCODE_HOME: "/profiles/mimo" }, "/Users/test")).toBe(
      "/profiles/mimo/cache/gateway-model-overrides.json",
    )
  })

  test("honors GATEWAY_MODEL_OVERRIDES before the host cache", () => {
    expect(overrideFile(
      inputWith({ "x-opencode-directory": "/tmp" }),
      { GATEWAY_MODEL_OVERRIDES: "/tmp/custom.json" },
    )).toBe("/tmp/custom.json")
  })

  test("parses a models map and ignores unknown fields", () => {
    expect(parseOverrides({
      models: {
        "gpt-5.6-luna": {
          name: "Luna",
          context_size: 1000,
          provider: "OpenAI",
          pricing: { input: 1, output: 2, cache_read: 0.1 },
          extra: true,
        },
      },
    })).toEqual({
      "gpt-5.6-luna": {
        name: "Luna",
        context_size: 1000,
        provider: "openai",
        pricing: { input: 1, output: 2, cache_read: 0.1 },
      },
    })
  })

  test("matches an exact id before an effort-suffixed base id", () => {
    const overrides = parseOverrides({
      "gpt-5.6-luna": { name: "Base" },
      "gpt-5.6-luna-high": { name: "High" },
    })
    expect(overrideFor(overrides, "gpt-5.6-luna-high")?.name).toBe("High")
    expect(overrideFor(overrides, "gpt-5.6-luna-max")?.name).toBe("Base")
  })

  test("applies metadata patches after model construction", () => {
    const entry = applyModelOverride(
      buildModel("gpt-5.6-luna", undefined, "https://gateway.example.com/v1"),
      {
        name: "Luna",
        context_size: 50_000,
        pricing: { input: 0.2, output: 1.2 },
        variants: ["low", "high"],
      },
    )
    expect(entry.name).toBe("Luna")
    expect(entry.limit?.context).toBe(50_000)
    expect(entry.cost).toMatchObject({ input: 0.2, output: 1.2 })
    expect(entry.variants).toMatchObject({
      low: { disabled: true },
      Low: { reasoningEffort: "low" },
      high: { disabled: true },
      High: { reasoningEffort: "high" },
    })
  })

  test("treats a missing override file as empty", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-overrides-"))
    try {
      const result = await getOverrides(
        inputWith({ "x-opencode-directory": "/tmp/project" }),
        { GATEWAY_MODEL_OVERRIDES: path.join(directory, "missing.json") },
      )
      expect(result).toEqual({})
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects invalid override JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-overrides-"))
    const filename = path.join(directory, "gateway-model-overrides.json")
    try {
      await writeFile(filename, "{")
      await expect(getOverrides(
        inputWith({ "x-opencode-directory": "/tmp/project" }),
        { GATEWAY_MODEL_OVERRIDES: filename },
      )).rejects.toThrow("invalid")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
