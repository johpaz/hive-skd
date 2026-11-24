#!/usr/bin/env bun
/**
 * Prueba de extremo a extremo de la línea de tiempo del historial CON MODELO REAL: ¿el modelo contesta bien
 * con el contexto que compila `compileContext`, con y sin HIVE_HISTORY_TIMELINE?
 *
 *   bun bench/history-timeline/e2e.ts --hive-credentials --provider gemini --model gemini-3.8-flash [--seeds 2]
 *       [--window 32000] [--tools]
 *
 * La clave se lee EN MEMORIA del almacén de secretos de hive (por defecto ~/.hive-dev, llave maestra en el
 * llavero del SO), con el código de hive; no se escribe en archivos ni en variables de entorno y no se imprime.
 * Con hive corriendo, o con otra corrida que tenga abierta esa base, la apertura falla por el bloqueo.
 *
 * El modelo recibe EXACTAMENTE lo que compila el SDK (system prompt + ventana reciente) y la pregunta. Sin
 * `--tools` no hay herramientas (mide solo el contexto); con `--tools` puede llamar a `conversation_read`
 * (la real, hasta 4 rondas), que es como el agente recupera lo que su contexto no trae. La respuesta se puntúa con `hasAll`
 * (determinista, sin juez). Dos estilos de pregunta: directa (la del escenario) e indirecta (con otras palabras).
 */

import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { writeFileSync } from "node:fs"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const provider = arg("provider") ?? "gemini"
const model = arg("model") ?? "gemini-3.8-flash"
const contextWindow = Number(arg("window") ?? 32_000)
const withTools = process.argv.includes("--tools")
const seeds = Array.from({ length: Number(arg("seeds") ?? 2) }, (_, i) => i + 1)
const hiveRepo = resolve(arg("hive-repo") ?? `${import.meta.dir}/../../../hive`)
if (!process.argv.includes("--hive-credentials")) throw new Error("Falta --hive-credentials (la clave sale del almacén de hive).")

// 1) La clave, ANTES de fijar HIVE_DB_PATH: el código de hive lo respeta y abriría una base vacía en memoria.
delete process.env.HIVE_DB_PATH
process.env.HIVE_HOME = process.env.HIVE_HOME ?? join(homedir(), ".hive-dev")
let apiKey = ""
{
  const storage = join(hiveRepo, "packages/core/src/storage")
  const crypto = await import(join(storage, "crypto.ts"))
  const hivedb = await import(join(storage, "hivedb.ts"))
  try { apiKey = await crypto.loadProviderApiKey(provider) } finally { hivedb.closeHiveDb() }
}
if (!apiKey) throw new Error(`hive no tiene clave para "${provider}" en ${process.env.HIVE_HOME}. ¿Hive o otra corrida tiene abierta la base?`)
console.log(`Clave de "${provider}" leída del almacén de hive (${apiKey.length} caracteres; no se imprime).`)

// 2) La base del SDK, en memoria. Este banco mide el mecanismo con cualquier ventana: sin la compuerta por tamaño.
process.env.HIVE_DB_PATH = ":memory:"
process.env.HIVE_HISTORY_TIMELINE_MIN_WINDOW = "0"
const { closeHiveDb } = await import("../../packages/core/src/storage/hivedb")
const { ensureHiveDb } = await import("../../packages/core/src/storage/bootstrap")
const { resetBootId } = await import("../../packages/core/src/storage/boot-id")
const { col, toIndexable } = await import("../../packages/core/src/storage/hive")
const { addMessage, getHistory } = await import("../../packages/core/src/agent/conversation-store")
const { indexThreadMessages } = await import("../../packages/core/src/agent/message-memory")
const { compileContext } = await import("../../packages/core/src/agent/context-compiler")
const { callLLM } = await import("../../packages/core/src/agent/llm-client")
const { conversationReadTool } = await import("../../packages/core/src/tools/core/index")
const { buildScenario } = await import("../compaction/scenario")
const { hasAll } = await import("../compaction/score")

const WINDOW = 15
/** `actual` = sin flag; el resto activa el flag con esa(s) pieza(s) (ablación). `--modes a,b` elige cuáles. */
type Mode = "actual" | "solo-recuperacion" | "solo-linea" | "ambas"
const ALL_MODES: Mode[] = ["actual", "solo-recuperacion", "solo-linea", "ambas"]
const PARTS: Record<Exclude<Mode, "actual">, string> = { "solo-recuperacion": "recall", "solo-linea": "timeline", ambas: "both" }
const MODES: Mode[] = (arg("modes")?.split(",") as Mode[] | undefined) ?? ["actual", "ambas"]
/** Mismas preguntas con otras palabras: la búsqueda léxica ya no las encuentra por coincidencia directa. */
const INDIRECT: Record<string, string> = {
  url: "¿A qué dirección web apunta el entorno de pruebas?",
  token: "¿Qué credencial usamos en el entorno de pruebas?",
  basic401: "¿Qué método para identificarnos ya intentamos sin éxito y qué código devolvió el servidor?",
  formal: "¿Cómo quiere el usuario que le escriba?",
  file: "¿Dónde está el código que hace las llamadas a la API?",
  queue: "¿Qué vamos a usar para reintentar los envíos fallidos?",
  limit: "¿Cuántas llamadas por minuto nos permiten?",
  sdk: "¿Qué librería hay que evitar?",
  credit: "¿Qué pendiente nos queda antes de salir a producción?",
}

async function seedAgent() {
  await (await col<any>("users")).put("u", {
    id: "u", name: "U", language: "es", timezone: null, occupation: null, notes: null, master_key_hash: null,
    email: null, password_hash: null, preferred_cron_channel: "webchat", created_at: Date.now(),
  })
  await (await col<any>("agents")).put("a", {
    id: "a", user_id: "u", name: "A", description: null, system_prompt: "Eres un asistente que continúa una tarea.",
    tone: null, role: "coordinator", status: "idle", enabled: true, provider_id: toIndexable("p"), model_id: toIndexable("m"),
    tools_json: null, skills_json: null, parent_id: toIndexable(null), max_iterations: 10, workspace: null,
    lastTraceAt: null, created_at: Date.now(), updated_at: Date.now(),
  })
  await (await col<any>("providers")).put("p", {
    id: "p", name: "P", enabled: true, active: true, base_url: "https://fake.invalid/v1", category: "llm",
    num_ctx: null, num_gpu: 0, created_at: Date.now(),
  })
  await (await col<any>("models")).put("m", {
    id: "m", provider_id: "p", name: "M", model_type: "llm", active: true, enabled: true,
    context_window: contextWindow, capabilities: null,
  })
}

type Style = "directa" | "indirecta"
interface Row { seed: number; mode: string; style: Style; item: string; inContext: boolean; answered: boolean; toolCalls: number; error?: string }
const rows: Row[] = []
let firstCall = true

for (const seed of seeds) {
  for (const mode of MODES) {
    if (mode !== "actual") { process.env.HIVE_HISTORY_TIMELINE = "true"; process.env.HIVE_HISTORY_TIMELINE_PARTS = PARTS[mode] }
    else { delete process.env.HIVE_HISTORY_TIMELINE; delete process.env.HIVE_HISTORY_TIMELINE_PARTS }
    closeHiveDb(); resetBootId(); await ensureHiveDb(); await seedAgent()
    const scenario = buildScenario(seed)
    const threadId = `e2e-${seed}-${mode}`
    for (const m of scenario.messages) await addMessage(threadId, m.role, m.content)
    await indexThreadMessages(threadId, await getHistory(threadId, 10_000))
    const outside = scenario.items.filter((it) => it.messageIndex < scenario.messages.length - WINDOW)

    for (const style of ["directa", "indirecta"] as Style[]) {
      for (const item of outside) {
        const question = style === "directa" ? item.question : INDIRECT[item.id] ?? item.question
        const ctx = await compileContext({ agentId: "a", threadId, userMessage: question })
        const row: Row = { seed, mode, style, item: item.id, inContext: hasAll(ctx.systemPrompt, item.expect), answered: false, toolCalls: 0 }
        try {
          const toolDefs = withTools
            ? [{ type: "function" as const, function: { name: conversationReadTool.name, description: conversationReadTool.description, parameters: conversationReadTool.parameters as Record<string, unknown> } }]
            : undefined
          const convo: any[] = [
            { role: "system", content: ctx.systemPrompt },
            ...ctx.messages,
            { role: "user", content: `${question} Responde breve y exacto, copiando los valores; si no lo sabes, responde "desconocido".` },
          ]
          let answer = ""
          for (let round = 0; round < 4; round++) {
            const res = await callLLM({ provider, model, apiKey, temperature: 0, messages: convo, ...(toolDefs ? { tools: toolDefs } : {}) })
            if (res.stop_reason === "error") throw new Error(res.error?.message ?? "LLM error")
            answer = res.content
            if (!res.tool_calls?.length || !toolDefs) break
            convo.push({ role: "assistant", content: res.content, tool_calls: res.tool_calls, reasoning_content: res.reasoning_content, thinking_blocks: res.thinking_blocks })
            for (const tc of res.tool_calls) {
              row.toolCalls++
              let args: Record<string, unknown> = {}
              try { args = JSON.parse(tc.function.arguments || "{}") } catch { /* argumentos inválidos: la tool responderá con error */ }
              const out = await conversationReadTool.execute(args, { configurable: { thread_id: threadId } } as any)
              convo.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(out) })
            }
          }
          row.answered = hasAll(answer, item.expect)
        } catch (err) {
          row.error = (err as Error).message.slice(0, 160)
          if (firstCall) { console.error(`La primera llamada falló, paro para no gastar: ${row.error}`); process.exit(1) }
        }
        firstCall = false
        rows.push(row)
      }
    }
    console.error(`semilla ${seed} · ${mode} listo`)
  }
}

console.log(`\nModelo ${provider}/${model} · ventana ${contextWindow} · semillas ${seeds.join(",")} · ${withTools ? "con conversation_read" : "sin tools"}\n`)
console.log(`${"estilo".padEnd(10)} ${"modo".padEnd(18)} ${"en contexto".padStart(12)} ${"respondió bien".padStart(15)} ${"usó la tool".padStart(12)} ${"errores".padStart(8)}`)
for (const style of ["directa", "indirecta"] as Style[]) {
  for (const mode of MODES) {
    const set = rows.filter((r) => r.style === style && r.mode === mode)
    const ok = set.filter((r) => !r.error)
    const pct = (n: number) => `${n}/${ok.length} ${ok.length ? `(${Math.round((100 * n) / ok.length)}%)` : ""}`
    console.log(`${style.padEnd(10)} ${mode.padEnd(18)} ${pct(ok.filter((r) => r.inContext).length).padStart(12)} ${pct(ok.filter((r) => r.answered).length).padStart(15)} ${String(ok.filter((r) => r.toolCalls > 0).length).padStart(12)} ${String(set.length - ok.length).padStart(8)}`)
  }
}
const out = arg("out")
if (out) writeFileSync(out, JSON.stringify(rows, null, 2))
closeHiveDb()
process.exit(0)
