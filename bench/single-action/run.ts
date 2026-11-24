#!/usr/bin/env bun
/**
 * Evaluación de extremo a extremo del modo de una acción por contexto.
 *
 * Un worker REAL (modelo real, herramientas reales, el bucle completo del SDK) resuelve tareas con
 * resultado verificable por código, una vez con el historial acumulado de siempre y otra con el modo de
 * una acción (HIVE_SINGLE_ACTION). Se compara si acierta, cuántas llamadas y tokens gasta y cuán grande
 * es la petición más grande.
 *
 *   # Con la credencial que guarda hive (se lee en memoria con el código de hive):
 *   bun bench/single-action/run.ts --hive-credentials --provider gemini --model gemini-3.8-flash
 *
 *   # O con la clave en una variable de entorno (GEMINI_API_KEY); nunca se imprime:
 *   GEMINI_API_KEY=... bun bench/single-action/run.ts --provider gemini --model gemini-3.8-flash
 *
 * Opciones: --seeds 5 (cuántas semillas, o una lista 1,2,3) · --kinds chain,inventory,deploy
 *           --modes history,sac · --timeout 300 (segundos por corrida) · --out resultados.json
 *           --hive-repo RUTA (por defecto ../hive) · --max-iterations 25 · --retries 3 (si el proveedor falla)
 *
 * El proceso usa una base en memoria y un directorio de datos temporal: no toca ~/.hive ni ~/.hive-dev
 * (salvo, con --hive-credentials, para LEER la clave, y la base se cierra antes de empezar).
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ToolParameter } from "../../packages/core/src/tools/types"
import { type Mode, type RunRecord, compare, groupBy, summarize } from "./stats"
import { TASK_KINDS, type Task, type TaskKind, type ToolCallRecord, buildTask, repeatedFailures } from "./tasks"

interface Args {
  provider: string
  model: string
  seeds: number[]
  kinds: TaskKind[]
  modes: Mode[]
  timeoutS: number
  maxIterations: number
  retries: number
  hiveCredentials: boolean
  hiveRepo: string
  out?: string
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const seedsArg = get("seeds") ?? "5"
  const seeds = seedsArg.includes(",")
    ? seedsArg.split(",").map((s) => Number(s.trim()))
    : Array.from({ length: Number(seedsArg) }, (_, i) => i + 1)
  if (seeds.some((s) => !Number.isFinite(s))) throw new Error(`--seeds inválido: ${seedsArg}`)
  const kinds = (get("kinds")?.split(",").map((s) => s.trim()) ?? TASK_KINDS) as TaskKind[]
  const modes = (get("modes")?.split(",").map((s) => s.trim()) ?? ["history", "sac"]) as Mode[]
  if (kinds.some((k) => !TASK_KINDS.includes(k))) throw new Error(`--kinds inválido: ${kinds.join(",")}`)
  if (modes.some((m) => m !== "history" && m !== "sac")) throw new Error(`--modes inválido: ${modes.join(",")}`)
  return {
    provider: get("provider") ?? "gemini",
    model: get("model") ?? "gemini-3.8-flash",
    seeds,
    kinds,
    modes,
    timeoutS: Number(get("timeout") ?? 300),
    maxIterations: Number(get("max-iterations") ?? 25),
    retries: Number(get("retries") ?? 3),
    hiveCredentials: argv.includes("--hive-credentials"),
    hiveRepo: resolve(get("hive-repo") ?? `${import.meta.dir}/../../../hive`),
    out: get("out"),
  }
}

const STATE_MARKER = "conversation state compactor"

/** Mide las peticiones al modelo que salen por `fetch`: cuántas, de qué tipo y cuánto pesan. */
function installRequestMeter() {
  const realFetch = globalThis.fetch
  let requests: Array<{ state: boolean; bytes: number }> = []
  globalThis.fetch = (async (input: any, init?: any) => {
    try {
      let body = init?.body
      if (body === undefined && input instanceof Request) body = await input.clone().text()
      if (typeof body === "string" && body.length > 0) {
        requests.push({ state: body.includes(STATE_MARKER), bytes: Buffer.byteLength(body) })
      }
    } catch {
      /* medir nunca debe romper una llamada */
    }
    return realFetch(input, init)
  }) as typeof fetch
  return {
    reset: () => {
      requests = []
    },
    snapshot: () => requests,
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  process.env.HIVE_LLM_STREAM = "0"

  // 1) La clave, ANTES de abrir nada del SDK: con --hive-credentials hace falta la base real de hive.
  const envName = `${args.provider.toUpperCase()}_API_KEY`
  let apiKey = process.env[envName] ?? ""
  if (args.hiveCredentials) {
    try {
      const { hiveApiKey } = await import("../compaction/llm")
      apiKey = await hiveApiKey({ provider: args.provider, hiveRepo: args.hiveRepo })
      console.log(`Credencial de hive: ${args.provider}, clave presente (${apiKey.length} caracteres, no se muestra).`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      process.exit(2)
    }
  }
  if (!apiKey) {
    console.error(`Falta la clave: usa --hive-credentials o define ${envName} en el entorno (no se imprime ni se guarda).`)
    process.exit(2)
  }

  // 2) Entorno aislado: base en memoria, datos temporales y llave maestra por entorno.
  process.env.HIVE_DB_PATH = ":memory:"
  process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-eval-"))
  process.env.HIVE_MASTER_KEY = "e".repeat(32)
  process.env[envName] = apiKey

  const { createAgent } = await import("../../packages/core/src/api/index")
  const { runAgent } = await import("../../packages/core/src/agent/agent-loop")
  const { defineTool } = await import("../../packages/core/src/tools/ToolRegistry")
  const { closeHiveDb } = await import("../../packages/core/src/storage/hivedb")
  const { resetJevStatus } = await import("../../packages/core/src/agent/jev-decisions")

  // 3) Las herramientas leen la tarea en curso; un agente por tipo de tarea, con solo sus herramientas.
  const holder: { task: Task | null; calls: ToolCallRecord[] } = { task: null, calls: [] }
  const tool = (name: string, description: string, properties: Record<string, ToolParameter>, required: string[]) =>
    defineTool({
      name,
      description,
      parameters: { type: "object", properties, required },
      execute: async (a: Record<string, unknown>) => {
        const out = holder.task!.call(name, a)
        holder.calls.push({ tool: name, args: a, ok: out.ok })
        return out.result
      },
    })
  const toolsByKind: Record<TaskKind, ReturnType<typeof tool>[]> = {
    chain: [tool("siguiente", "Devuelve el valor de un nodo y la clave del nodo siguiente (null si es el último)", { clave: { type: "string" } }, ["clave"])],
    inventory: [tool("stock", "Devuelve las unidades disponibles de un artículo", { articulo: { type: "string" } }, ["articulo"])],
    deploy: [
      tool("metodos", "Lista los métodos de despliegue disponibles", {}, []),
      tool("desplegar", "Despliega la aplicación con un método en un entorno", { metodo: { type: "string" }, entorno: { type: "string" } }, ["metodo", "entorno"]),
    ],
  }
  const agentIds = {} as Record<TaskKind, string>
  for (const kind of args.kinds) {
    const name = `eval_${kind}`
    await createAgent({
      name,
      provider: args.provider as NonNullable<Parameters<typeof createAgent>[0]["provider"]>,
      model: args.model,
      tools: toolsByKind[kind],
      seed: "minimal",
      browser: false,
      oracle: false,
      maxIterations: args.maxIterations,
    })
    agentIds[kind] = name
  }

  const meter = installRequestMeter()
  const runs: RunRecord[] = []
  const total = args.seeds.length * args.kinds.length * args.modes.length
  console.log(`\nModelo: ${args.provider}/${args.model} · ${args.seeds.length} semillas × ${args.kinds.length} tareas × ${args.modes.length} modos = ${total} corridas\n`)

  for (const seed of args.seeds) {
    for (const kind of args.kinds) {
      for (const mode of args.modes) {
        const task = buildTask(kind, seed)
        holder.task = task
        process.env.HIVE_SINGLE_ACTION = mode === "sac" ? "true" : "false"

        let answer = ""
        let usage: any = null
        let error: string | undefined
        let inconclusive = false
        let attempts = 0
        let t0 = performance.now()
        // El proveedor puede fallar (503, 429): se reintenta con espera creciente antes de rendirse, y una corrida
        // que nunca llegó al modelo NO cuenta como fallo de la tarea.
        for (attempts = 1; attempts <= args.retries + 1; attempts++) {
          holder.calls = []
          meter.reset()
          resetJevStatus()
          answer = ""
          usage = null
          error = undefined
          const abort = new AbortController()
          const timer = setTimeout(() => abort.abort(), args.timeoutS * 1000)
          t0 = performance.now()
          try {
            for await (const chunk of runAgent({
              agentId: agentIds[kind],
              userMessage: task.prompt,
              taskContext: task.prompt,
              threadId: `eval-${mode}-${kind}-${seed}-${attempts}-${Math.random().toString(36).slice(2, 8)}`,
              isolated: true,
              signal: abort.signal,
            })) {
              if (chunk.agent?.messages?.[0]?.content) answer = String(chunk.agent.messages[0].content)
              if (chunk.usage) usage = chunk.usage
            }
          } catch (err) {
            error = err instanceof Error ? err.message : String(err)
          } finally {
            clearTimeout(timer)
          }
          if (abort.signal.aborted && !error) error = `superó el tiempo (${args.timeoutS} s)`
          inconclusive = answer.startsWith("[LLM Error]") || /\b(429|503|UNAVAILABLE|RESOURCE_EXHAUSTED)\b/.test(error ?? "")
          if (!inconclusive || attempts > args.retries) break
          const waitS = 20 * 2 ** (attempts - 1)
          console.log(`    el proveedor falló (intento ${attempts}); espero ${waitS} s`)
          await new Promise((r) => setTimeout(r, waitS * 1000))
        }
        if (inconclusive) error = (answer || error || "fallo del proveedor").slice(0, 160)

        const sent = meter.snapshot()
        const actionBytes = sent.filter((r) => !r.state).map((r) => r.bytes)
        const record: RunRecord = {
          kind,
          seed,
          mode,
          success: !inconclusive && !error && task.check(answer),
          answer: answer.slice(0, 300),
          error,
          iterations: usage?.iterations ?? 0,
          modelCalls: sent.length > 0 ? sent.length : null,
          toolCalls: holder.calls.length,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          elapsedMs: Math.round(performance.now() - t0),
          peakRequestKb: actionBytes.length ? Math.max(...actionBytes) / 1024 : null,
          repeatedFailures: repeatedFailures(holder.calls),
          inconclusive,
          attempts: Math.min(attempts, args.retries + 1),
        }
        runs.push(record)
        console.log(
          `  semilla ${seed} · ${kind.padEnd(9)} · ${mode.padEnd(7)} ${record.inconclusive ? "⚠" : record.success ? "✔" : "✘"} ` +
            `${record.toolCalls} herr · ${record.modelCalls ?? "?"} llamadas · ${record.inputTokens} tok · ${(record.elapsedMs / 1000).toFixed(1)} s` +
            (record.error ? ` · ${record.error.slice(0, 80)}` : ""),
        )
      }
    }
  }

  meter.restore()
  closeHiveDb()
  report(runs, args)
  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ args: { ...args, hiveRepo: undefined }, runs }, null, 2))
    console.log(`\nResultados guardados en ${args.out}`)
  }
  // El SDK deja temporizadores y servicios abiertos tras una corrida; sin esto el proceso no termina solo.
  process.exit(0)
}

const pct = (x: number) => `${(x * 100).toFixed(0)} %`
const num = (x: number | null, d = 0) => (x === null ? "—" : x.toFixed(d))
const times = (x: number | null) => (x === null ? "—" : `${x.toFixed(2)}×`)

function report(runs: RunRecord[], args: Args) {
  const byMode = groupBy(runs, (r) => r.mode)
  console.log("\n## Resultado global\n")
  console.log("| modo | corridas (excluidas) | éxito | llamadas al modelo | herramientas | tokens de entrada | tokens de salida | pico de petición (KB) | segundos | fallos repetidos |")
  console.log("|---|---|---|---|---|---|---|---|---|---|")
  for (const mode of args.modes) {
    const s = summarize(byMode[mode] ?? [])
    console.log(`| ${mode} | ${s.runs} (${s.excluded}) | ${pct(s.successRate)} | ${num(s.avgModelCalls, 1)} | ${num(s.avgToolCalls, 1)} | ${num(s.avgInputTokens)} | ${num(s.avgOutputTokens)} | ${num(s.avgPeakRequestKb, 1)} | ${num(s.avgElapsedS, 1)} | ${num(s.avgRepeatedFailures, 2)} |`)
  }

  if (args.modes.includes("history") && args.modes.includes("sac")) {
    console.log("\n## Por tipo de tarea (sac frente a history)\n")
    console.log("| tarea | éxito history | éxito sac | Δ éxito | tokens de entrada sac/history | pico de petición sac/history | llamadas sac/history |")
    console.log("|---|---|---|---|---|---|---|")
    for (const kind of args.kinds) {
      const h = summarize(runs.filter((r) => r.kind === kind && r.mode === "history"))
      const s = summarize(runs.filter((r) => r.kind === kind && r.mode === "sac"))
      const c = compare(h, s)
      console.log(`| ${kind} | ${pct(h.successRate)} | ${pct(s.successRate)} | ${c.successDeltaPp >= 0 ? "+" : ""}${c.successDeltaPp.toFixed(0)} pp | ${times(c.inputTokensRatio)} | ${times(c.peakRequestRatio)} | ${times(c.modelCallsRatio)} |`)
    }
    const all = compare(summarize(byMode.history ?? []), summarize(byMode.sac ?? []))
    console.log(`\nGlobal: éxito ${all.successDeltaPp >= 0 ? "+" : ""}${all.successDeltaPp.toFixed(0)} pp · tokens de entrada ${times(all.inputTokensRatio)} · pico de petición ${times(all.peakRequestRatio)} · llamadas ${times(all.modelCallsRatio)}`)
  }

  const excluded = runs.filter((r) => r.inconclusive)
  if (excluded.length > 0) {
    console.log(`\n⚠ ${excluded.length} de ${runs.length} corridas no se pudieron evaluar por fallos del proveedor y quedan fuera de los porcentajes.`)
    if (excluded.length === runs.length) console.log("  Ninguna llegó al modelo: no hay resultados que interpretar. Espera a que se libere la cuota o cambia de modelo.")
  }
  const failed = runs.filter((r) => !r.success && !r.inconclusive)
  if (failed.length > 0) {
    console.log("\n## Corridas fallidas\n")
    for (const r of failed.slice(0, 20)) {
      console.log(`- ${r.kind} · semilla ${r.seed} · ${r.mode}: ${r.error ?? `respuesta «${r.answer.replace(/\s+/g, " ").slice(0, 120)}»`}`)
    }
    if (failed.length > 20) console.log(`- … y ${failed.length - 20} más (están en --out)`)
  }
  console.log(
    "\nQué mide: si un worker real resuelve cada tarea con el historial acumulado o con el modo de una acción. " +
      "Las tareas son sintéticas y pequeñas; pocas semillas dan una señal, no una prueba. " +
      "El «pico de petición» es el tamaño del cuerpo de la petición más grande (incluye la definición de herramientas, igual en ambos modos).",
  )
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
