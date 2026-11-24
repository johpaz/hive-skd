/**
 * Modo de una acción por contexto (SAC) — experimental, apagado por defecto.
 *
 * En vez de acumular el historial de un turno (cada llamada del modelo vuelve a leer todas las
 * herramientas y resultados anteriores, y la ventana crece), tras cada acción se destila un estado de
 * tarea —el traspaso de seis campos de handoff.ts— y la conversación se reinicia con SOLO la tarea y
 * ese estado. Así cada llamada ve un contexto corto y de tamaño casi constante.
 *
 * Es el patrón de «You don't need long context» (arXiv 2611.05306, §5). Cuesta una llamada más al
 * modelo por acción (la que actualiza el estado), a cambio de un contexto que no crece. Si la
 * actualización falla, el historial NO se recorta: no se pierde nada.
 *
 * Aquí no hay bucle ni acceso a la base: el modelo entra como función, para poder probarlo sin red.
 */

import type { LLMMessage, LLMResponse, ContentPart } from "./llm-client"
import { HANDOFF_SYSTEM_PROMPT, buildHandoffPrompt, parseHandoff, renderHandoff, type Handoff } from "./handoff"

/** Un resultado de herramienta más largo se recorta (cabeza y cola) antes de pedir el estado. */
export const MAX_RESULT_CHARS = 3_000
/** Tope de lo que se le da al modelo para actualizar el estado (~4K tokens). */
export const MAX_TRANSCRIPT_CHARS = 16_000
const MAX_ARGS_CHARS = 600
const MAX_TASK_CHARS = 4_000

/** Solo en workers (contexto aislado, una tarea): en un chat el historial es la conversación con una persona. */
export function singleActionEnabled(
  opts: { isolated?: boolean },
  config: { agent?: { context?: { singleActionMode?: boolean } } },
): boolean {
  return !!opts.isolated && config.agent?.context?.singleActionMode === true
}

function textOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content
  return content
    .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
    .join("\n")
}

/** Cabeza y cola: en una salida larga, el principio da el contexto y el final suele traer el error o el resultado. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n[… ${text.length - max} caracteres omitidos …]\n${text.slice(text.length - tail)}`
}

/**
 * Lo ocurrido en las últimas acciones, en texto: lo que el modelo decidió, las herramientas que llamó
 * y lo que devolvieron. Los avisos del sistema (correcciones, intervenciones) se rotulan aparte para
 * que no se confundan con lo que dijo la persona.
 */
export function renderActionTranscript(delta: LLMMessage[]): string {
  const lines: string[] = []
  for (const m of delta) {
    if (m.role === "assistant") {
      const said = textOf(m.content).trim()
      if (said) lines.push(`[ASISTENTE]: ${clip(said, MAX_RESULT_CHARS)}`)
      for (const call of m.tool_calls ?? []) {
        lines.push(`[LLAMADA ${call.function.name}]: ${clip(String(call.function.arguments), MAX_ARGS_CHARS)}`)
      }
    } else if (m.role === "tool") {
      lines.push(`[RESULTADO]: ${clip(textOf(m.content), MAX_RESULT_CHARS)}`)
    } else if (m.role === "user") {
      lines.push(`[AVISO DEL SISTEMA]: ${clip(textOf(m.content), 800)}`)
    }
  }
  const text = lines.join("\n\n")
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(text.length - MAX_TRANSCRIPT_CHARS) : text
}

/** El estado como mensaje de usuario: es lo único, junto con la tarea, que verá el modelo en la siguiente llamada. */
export function stateMessage(state: Handoff): LLMMessage {
  return {
    role: "user",
    content:
      "# ESTADO ACTUAL DE LA TAREA\n" +
      "Esto resume lo que ya hiciste y averiguaste. No repitas lo ya hecho ni los callejones sin salida; " +
      "continúa con el primer paso del plan. Si la tarea ya está completa, responde con el resultado final.\n\n" +
      renderHandoff(state),
  }
}

/** La conversación reiniciada: lo de partida (sistema + tarea) más el estado. */
export function collapseMessages(base: LLMMessage[], state: Handoff): LLMMessage[] {
  return [...base, stateMessage(state)]
}

export interface StateUpdate {
  state: Handoff
  inputTokens: number
  outputTokens: number
}

/**
 * Pide al modelo el estado nuevo, incorporando lo que pasó en `delta` al estado anterior. Devuelve
 * `null` si la llamada falla o la respuesta no es un traspaso válido: quien llama conserva entonces
 * el historial completo, porque recortarlo sin estado sería perder información.
 */
export async function updateTaskState(input: {
  /** La tarea original, tal como la recibió el worker. */
  task: string
  previous: Handoff | null
  /** Los mensajes nuevos desde el último estado: la acción, sus resultados y los avisos. */
  delta: LLMMessage[]
  call: (messages: LLMMessage[]) => Promise<LLMResponse>
}): Promise<StateUpdate | null> {
  const transcript = renderActionTranscript(input.delta)
  if (!transcript) return null
  const task = input.task.trim().slice(0, MAX_TASK_CHARS)
  const previous = input.previous ? renderHandoff(input.previous) : `Tarea original:\n${task}`
  let response: LLMResponse
  try {
    response = await input.call([
      { role: "system", content: HANDOFF_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildHandoffPrompt({
          transcript,
          messageCount: input.delta.length,
          previous,
        }),
      },
    ])
  } catch {
    return null
  }
  if (response.stop_reason === "error") return null
  const parsed = parseHandoff(response.content ?? "")
  if (!parsed) return null
  // Si el modelo dejó el objetivo vacío, el de la tarea manda: nunca se pierde el rumbo.
  const state = parsed.objective ? parsed : { ...parsed, objective: task.replace(/\s+/g, " ").slice(0, 400) }
  return {
    state,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  }
}
