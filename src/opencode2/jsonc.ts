/** Parse JSONC without a dependency. Strings are preserved; comments and trailing commas are not. */

export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(stripJsonc(text))
  }
}

export function stripJsonc(text: string): string {
  let out = ""
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2
          continue
        }
        if (text[index] === '"') {
          index += 1
          break
        }
        index += 1
      }
      out += text.slice(start, index)
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2
      while (index < text.length && text[index] !== "\n") index += 1
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index = Math.min(index + 2, text.length)
      continue
    }
    out += char
    index += 1
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}
