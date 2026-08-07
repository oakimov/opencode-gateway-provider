import { describe, expect, test } from "bun:test"
import { listModelIds, modelsEndpoint, parseModelIds } from "./gateway.js"

describe("modelsEndpoint", () => {
  test("appends /v1/models to a bare host", () => {
    expect(modelsEndpoint("https://gateway.example.com")).toBe("https://gateway.example.com/v1/models")
  })

  test("appends /v1/models to a host with a trailing slash", () => {
    expect(modelsEndpoint("https://gateway.example.com/")).toBe("https://gateway.example.com/v1/models")
  })

  test("appends /models when baseURL already ends in /v1", () => {
    expect(modelsEndpoint("https://gateway.example.com/v1")).toBe("https://gateway.example.com/v1/models")
  })

  test("keeps a nested /v1 path", () => {
    expect(modelsEndpoint("https://gateway.example.com/proxy/v1")).toBe("https://gateway.example.com/proxy/v1/models")
  })
})

describe("parseModelIds", () => {
  test("object entries with id", () => {
    expect(parseModelIds({ data: [{ id: "a" }, { id: "b" }, { id: "" }] })).toEqual(["a", "b"])
  })

  test("bare string array", () => {
    expect(parseModelIds(["a", "b"])).toEqual(["a", "b"])
  })

  test("drops entries without a usable id", () => {
    expect(parseModelIds({ data: [{ id: "a" }, { name: "no-id" }, 42] } as never)).toEqual(["a"])
  })

  test("empty or missing data", () => {
    expect(parseModelIds({})).toEqual([])
    expect(parseModelIds({ data: [] })).toEqual([])
  })
})

describe("listModelIds", () => {
  test("sends bearer key and returns ids", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe("https://gateway.example.com/v1/models")
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer sk-test")
      return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    try {
      expect(await listModelIds("https://gateway.example.com", "sk-test")).toEqual(["a", "b"])
    } finally {
      globalThis.fetch = original
    }
  })

  test("throws on non-ok response", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch
    try {
      await expect(listModelIds("https://gateway.example.com", "sk-test")).rejects.toThrow(/401/)
    } finally {
      globalThis.fetch = original
    }
  })
})
