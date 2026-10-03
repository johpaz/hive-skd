/**
 * Llamadas a tools escritas como texto, en forma de llamada a función.
 *
 * Qwen a veces no emite la tool de forma estructurada y escribe
 * `buscar_conocimiento_sitio(query="cómo evita un agente repetirse")` como
 * respuesta. Sin parsearlo, el loop lo toma como respuesta final: el visitante
 * lee el nombre de una función. Medido contra el laboratorio: 2 de 12 preguntas
 * con Jev activo, y en una el modelo además inventó el nombre del argumento
 * (`query` en lugar de `consulta`).
 *
 * Solo se reconoce una llamada a una tool **ofrecida en esa petición**, al
 * principio de la respuesta: un texto que mencione una función en una frase no
 * se toca.
 */

import type { LLMToolCall } from "./interface"

export interface KnownTool {
  parameters?: Record<string, unknown>
}

export interface ParsedTextCalls {
  /** What is left of the response after the call. */
  content: string
  tool_calls: LLMToolCall[]
}

const START = /^\s*([A-Za-z_][\w.-]*)\s*\(/

/** Index of the `)` that closes the call opened at `open`, skipping quoted text. `-1` if it never closes. */
function findClose(text: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    else if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--
      if (depth === 0) return ch === ")" ? i : -1
    }
  }
  return -1
}

/** Splits `a="x, y", b=2` on the commas that are not inside quotes or brackets. */
function splitArgs(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ""
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (quote) {
      current += ch
      if (ch === "\\" && i + 1 < inner.length) current += inner[++i]!
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    else if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts
}

function parseValue(raw: string): unknown {
  const text = raw.trim()
  if (/^(["'`])[\s\S]*\1$/.test(text)) {
    const body = text.slice(1, -1)
    if (text[0] === '"') {
      try { return JSON.parse(text) } catch { /* fall through to a plain unescape */ }
    }
    return body.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n")
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text === "true") return true
  if (text === "false") return false
  if (text === "null") return null
  if (/^[[{]/.test(text)) {
    try { return JSON.parse(text) } catch { /* keep the raw text */ }
  }
  return text
}

/** `{ a: 1 }`-style object literal or `key=value` pairs → arguments. `null` when it is neither. */
function parseArgs(inner: string): Record<string, unknown> | null {
  const text = inner.trim()
  if (text === "") return {}
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text)
      return json && typeof json === "object" && !Array.isArray(json) ? json : null
    } catch {
      return null
    }
  }
  const args: Record<string, unknown> = {}
  for (const part of splitArgs(text)) {
    const eq = part.match(/^\s*([A-Za-z_][\w]*)\s*[=:]\s*([\s\S]+)$/)
    if (!eq) return null
    args[eq[1]!] = parseValue(eq[2]!)
  }
  return args
}

/**
 * If the model invented the argument name but the tool takes exactly one, the
 * value is clearly meant for it.
 */
function alignToSchema(args: Record<string, unknown>, parameters?: Record<string, unknown>): Record<string, unknown> {
  const properties = Object.keys((parameters?.properties as Record<string, unknown> | undefined) ?? {})
  const keys = Object.keys(args)
  if (properties.length !== 1 || keys.length !== 1 || keys[0] === properties[0]) return args
  return { [properties[0]!]: args[keys[0]!] }
}

export function extractFunctionStyleCall(content: string, known: Map<string, KnownTool>): ParsedTextCalls {
  const start = START.exec(content)
  const name = start?.[1]
  if (!start || !name || !known.has(name)) return { content, tool_calls: [] }

  const open = start[0].length - 1
  const close = findClose(content, open)
  if (close === -1) return { content, tool_calls: [] }

  const parsed = parseArgs(content.slice(open + 1, close))
  if (!parsed) return { content, tool_calls: [] }

  const args = alignToSchema(parsed, known.get(name)?.parameters)
  return {
    content: content.slice(close + 1).trim(),
    tool_calls: [{ id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
  }
}
