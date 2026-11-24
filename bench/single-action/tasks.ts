/**
 * Tareas de la evaluación de extremo a extremo del modo de una acción por contexto.
 *
 * Cada tarea es un problema pequeño con herramientas y un resultado que se verifica por código (no por
 * un juez). Están elegidas para exigir justo lo que el modo podría romper: conservar datos exactos entre
 * pasos —una suma parcial, un máximo, qué métodos ya fallaron— cuando el historial ya no está.
 *
 *  - chain:     seguir una cadena de consultas y sumar los valores (arrastrar una suma).
 *  - inventory: consultar varios artículos y decir cuál tiene más unidades (arrastrar un máximo).
 *  - deploy:    probar métodos hasta dar con el que funciona, sin repetir los que fallan (callejones sin salida).
 *
 * Todo es determinista por semilla y puro: sin modelo, sin red.
 */

export type TaskKind = "chain" | "inventory" | "deploy"
export const TASK_KINDS: TaskKind[] = ["chain", "inventory", "deploy"]

/** Una llamada de herramienta tal como la ve la tarea, para contar errores y repeticiones. */
export interface ToolCallRecord {
  tool: string
  args: Record<string, unknown>
  ok: boolean
}

export interface Task {
  kind: TaskKind
  seed: number
  /** Lo que recibe el worker. */
  prompt: string
  /** Responde a una llamada de herramienta; es la "base de datos" de la tarea. */
  call(tool: string, args: Record<string, unknown>): { ok: boolean; result: unknown }
  /** ¿Es correcta la respuesta final? */
  check(answer: string): boolean
  /** Lo esperado, para mostrarlo en el informe. */
  expected: string
}

/** PRNG pequeño y determinista (mulberry32). */
function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Los números de la respuesta, sin separadores de miles: «1.234», «1,234» y «1234» son el mismo. */
export function numbersIn(text: string): number[] {
  return (text.match(/\d[\d.,]*/g) ?? [])
    .map((raw) => Number(raw.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(",", ".")))
    .filter((n) => Number.isFinite(n))
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()

function chain(seed: number): Task {
  const rand = rng(seed)
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const length = 8
  const keys = Array.from({ length }, (_, i) => `nodo-${String.fromCharCode(97 + i)}${int(10, 99)}`)
  const values = keys.map(() => int(17, 940))
  const total = values.reduce((a, b) => a + b, 0)
  const index = new Map(keys.map((k, i) => [k, i]))
  return {
    kind: "chain",
    seed,
    prompt:
      `Empieza en el nodo "${keys[0]}". Consulta cada nodo con la herramienta "siguiente": te devuelve su valor y el nodo siguiente ` +
      `(o null si es el último). Sigue la cadena hasta el final y respóndeme con la SUMA de los valores de todos los nodos, incluido el primero.`,
    call(tool, args) {
      const i = index.get(String(args.clave))
      if (tool !== "siguiente" || i === undefined) return { ok: false, result: { error: "nodo desconocido" } }
      return { ok: true, result: { clave: keys[i], valor: values[i], siguiente: keys[i + 1] ?? null } }
    },
    check: (answer) => numbersIn(answer).includes(total),
    expected: String(total),
  }
}

function inventory(seed: number): Task {
  const rand = rng(seed + 1000)
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const names = ["tornillo", "arandela", "tuerca", "remache", "perno", "clavija", "bisagra", "soporte", "abrazadera", "pasador"]
  const items = names.slice(0, 8).map((name, i) => `${name}-${String.fromCharCode(65 + i)}${int(1, 9)}`)
  // Unidades únicas: el máximo no admite empates.
  const pool = new Set<number>()
  while (pool.size < items.length) pool.add(int(120, 9800))
  const units = [...pool]
  const best = units.indexOf(Math.max(...units))
  const stock = new Map(items.map((it, i) => [it, units[i]!]))
  return {
    kind: "inventory",
    seed,
    prompt:
      `Con la herramienta "stock" consulta las unidades disponibles de estos artículos: ${items.join(", ")}. ` +
      `Dime cuál tiene MÁS unidades y cuántas son.`,
    call(tool, args) {
      const n = stock.get(String(args.articulo))
      if (tool !== "stock" || n === undefined) return { ok: false, result: { error: "artículo desconocido" } }
      return { ok: true, result: { articulo: args.articulo, unidades: n } }
    },
    check: (answer) => norm(answer).includes(norm(items[best]!)) && numbersIn(answer).includes(units[best]!),
    expected: `${items[best]} (${units[best]})`,
  }
}

function deploy(seed: number): Task {
  const rand = rng(seed + 2000)
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const methods = shuffle(["rsync", "scp", "api"], rand)
  // Solo uno funciona; los otros fallan con un error que no es transitorio (reintentar no sirve).
  const works = methods[int(0, 2)]!
  const env = pickEnv(rand)
  const code = `DEP-${int(1000, 9999)}-${env.slice(0, 3).toUpperCase()}`
  const errors: Record<string, string> = {
    rsync: "permiso denegado en /srv/app (no se puede reintentar)",
    scp: "conexión rechazada por el host de destino (no se puede reintentar)",
    api: "el endpoint de despliegue devolvió 403 (no se puede reintentar)",
  }
  return {
    kind: "deploy",
    seed,
    prompt:
      `Despliega la aplicación en el entorno "${env}". Primero consulta con "metodos" qué métodos de despliegue hay, y prueba con ` +
      `"desplegar" hasta que uno funcione. Si un método falla, no sirve reintentarlo: pasa a otro. Dame el código de confirmación.`,
    call(tool, args) {
      if (tool === "metodos") return { ok: true, result: { metodos: methods } }
      if (tool !== "desplegar") return { ok: false, result: { error: "herramienta desconocida" } }
      const m = String(args.metodo)
      if (!methods.includes(m)) return { ok: false, result: { error: "método desconocido" } }
      if (args.entorno !== env) return { ok: false, result: { error: `entorno inválido, debe ser "${env}"` } }
      return m === works ? { ok: true, result: { estado: "desplegado", codigo: code } } : { ok: false, result: { error: errors[m] } }
    },
    check: (answer) => answer.includes(code),
    expected: code,
  }
}

/** Fisher–Yates: determinista por semilla, a diferencia de un `sort` con comparador aleatorio. */
function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function pickEnv(rand: () => number): string {
  return ["produccion", "staging", "preproduccion", "qa"][Math.floor(rand() * 4)]!
}

export function buildTask(kind: TaskKind, seed: number): Task {
  return kind === "chain" ? chain(seed) : kind === "inventory" ? inventory(seed) : deploy(seed)
}

/** Llamadas fallidas que se repiten idénticas: lo que el estado destilado debería evitar. */
export function repeatedFailures(calls: ToolCallRecord[]): number {
  const failed = new Set<string>()
  let repeats = 0
  for (const c of calls) {
    if (c.ok) continue
    const key = `${c.tool}:${JSON.stringify(c.args)}`
    if (failed.has(key)) repeats++
    else failed.add(key)
  }
  return repeats
}
