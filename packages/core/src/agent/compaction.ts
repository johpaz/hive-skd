/**
 * Compaction — Fase 6.
 *
 * Compresses conversation history when token count exceeds threshold.
 * Uses the active LLM to summarize old messages, preserving:
 *   - User data and preferences
 *   - Decisions made
 *   - Tool results
 *   - Context needed to continue
 *
 * Saves summary to `summaries` table. Original messages are kept (audit trail)
 * but the Context Compiler uses the summary instead of old messages.
 *
 * Also implements "tool result clearing": replaces old tool results with
 * short summaries in the in-memory message array before model calls.
 */

import { logger } from "../utils/logger"
import {
  getTotalTokens,
  getHistory,
  getSummary,
  saveSummary,
  getMessageCount,
  isInternalSource,
  type StoredMessage,
} from "./conversation-store"
import { indexThreadSummary } from "./summary-memory"
import { estimateTokens } from "../utils/toon"
import {
  callLLM, resolveProviderConfig, getDefaultLLM,
  type ContentPart, type ProviderCredentials,
} from "./llm-client"
import { col, fromIndexable } from "../storage/hive"
import type { AgentDoc, ModelDoc } from "../storage/collections"
import { loadConfig } from "../config/loader"
import { runBeforeCompaction } from "../hooks/index"

const log = logger.child("compaction")

// Token budget: compress when stored tokens exceed this threshold
// Will be overridden by model's context_window at runtime if available
const COMPACT_TOKEN_THRESHOLD = 32000  // ~25% of 128K default context window
const KEEP_LAST_N_MESSAGES = 5         // always keep most recent N messages
const TOOL_RESULT_MAX_CHARS = 200      // max chars for old tool results after clearing
const MAX_TRANSCRIPT_MSGS = 30         // cap messages sent to summarizer (avoids OOM on small models)
const MAX_MSG_CHARS = 300              // chars per message in transcript
/** Ventana asumida cuando no se conoce la del modelo: `COMPACT_TOKEN_THRESHOLD` es su 25 %. */
const ASSUMED_CONTEXT_WINDOW = 128_000
const DEFAULT_CONTEXT_RATIO = 0.25

/**
 * El modelo con el que se pide el resumen: el del turno que disparó la
 * compactación, con SUS credenciales.
 */
export interface CompactionLLM {
  provider?: string
  model?: string
  /** En multi-inquilino, la llave del cliente. Sin esto se usaría una global. */
  credentials?: ProviderCredentials
  /** La ventana del modelo, si quien llama ya la resolvió. */
  contextWindow?: number
}

/**
 * A partir de cuántos tokens de historial se compacta.
 *
 * `agent.context.compactionThreshold` es una PROPORCIÓN de la ventana del
 * modelo —su valor por defecto es 0.8, o sea el 80 %—, pero se leía como si
 * fueran tokens. Con la configuración por defecto el umbral quedaba en 0.8
 * tokens: cualquier hilo con más de cinco mensajes se resumía en cada turno,
 * pagando una llamada extra al modelo y reemplazando el historial por un
 * resumen desde el primer intercambio. Un valor mayor que 1 se sigue leyendo
 * como tokens, que es lo que espera quien fijó un número absoluto.
 */
export function resolveCompactionThreshold(configured: number | undefined, contextWindow?: number): number {
  const known = contextWindow && contextWindow > 0 ? contextWindow : undefined
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return configured <= 1
      ? Math.floor((known ?? ASSUMED_CONTEXT_WINDOW) * configured)
      : Math.floor(configured)
  }
  return known ? Math.floor(known * DEFAULT_CONTEXT_RATIO) : COMPACT_TOKEN_THRESHOLD
}

/** La ventana del modelo del turno; si no se sabe cuál es, la del coordinador. */
async function modelContextWindow(modelId?: string): Promise<number | undefined> {
  try {
    const modelsCol = await col<ModelDoc>("models")
    if (modelId) return (await modelsCol.get(modelId))?.doc.context_window || undefined
    const agentsCol = await col<AgentDoc>("agents")
    const coordinators = await agentsCol.findBy("role", "coordinator", { limit: 1 })
    // El id se busca completo: recortar el primer segmento rompía cualquier
    // modelo cuyo nombre lleve barra (meta/llama-3.3-70b-instruct buscaba
    // "llama-3.3-70b-instruct", no encontraba nada y caía al default).
    const id = fromIndexable(coordinators[0]?.doc.model_id ?? null)
    if (!id) return undefined
    return (await modelsCol.get(id))?.doc.context_window || undefined
  } catch {
    return undefined
  }
}

/**
 * Check if compaction is needed and run it if so.
 * Called at the start of each agent loop iteration.
 */
export async function maybeCompact(
  threadId: string,
  notify?: { channel: string; userId: string },
  llm?: CompactionLLM
): Promise<void> {
  try {
    const totalTokens = await getTotalTokens(threadId)
    const contextWindow = llm?.contextWindow ?? (await modelContextWindow(llm?.model))
    const effectiveThreshold = resolveCompactionThreshold(
      loadConfig().agent?.context?.compactionThreshold,
      contextWindow,
    )

    if (totalTokens < effectiveThreshold) return

    // Avisar antes de comprimir: es la última oportunidad de que alguien
    // conserve algo del historial que está por resumirse.
    await runBeforeCompaction({
      threadId,
      messageCount: await getMessageCount(threadId),
      totalTokens,
    }).catch(() => {})

    const summary = await getSummary(threadId)
    const totalMessages = await getMessageCount(threadId)

    // Already summarized up to near the current state
    if (summary && summary.last_message_id > totalMessages - KEEP_LAST_N_MESSAGES) return

    log.info(`[compaction] Compacting thread=${threadId} tokens=${totalTokens} threshold=${effectiveThreshold}`)
    await compactThread(threadId, notify, llm)
  } catch (err) {
    log.warn("[compaction] Error during compaction check:", err)
  }
}

/**
 * Find a clean cut point: the "keep" side must begin with a user turn so we
 * never leave orphaned tool messages at the start of the visible window.
 * Internal events (delegation fan-in) are persisted as role:"user", so they
 * are valid boundaries here same as human turns.
 * Returns 0 when no clean boundary exists (caller should skip compaction).
 */
export function findCompactionCutIndex(rows: StoredMessage[], keepLastN = KEEP_LAST_N_MESSAGES): number {
  let cutIndex = rows.length - keepLastN
  while (cutIndex > 0 && rows[cutIndex]?.role !== "user") {
    cutIndex--
  }
  return cutIndex
}

/**
 * Render a transcript for the summarizer LLM. Internal events (delegation
 * fan-in notices) are labeled distinctly — they are persisted as
 * role:"user" so the LLM treats them as input, but labeling them [USER] here
 * would make the summarizer attribute system-generated task outcomes to the
 * human, baking that misattribution into the durable summary.
 */
export function renderTranscript(rows: StoredMessage[], maxMsgChars = MAX_MSG_CHARS): string {
  return rows
    .map((r) => {
      const label = isInternalSource(r.source) ? "EVENTO INTERNO" : r.role.toUpperCase()
      return `[${label}]: ${r.content.substring(0, maxMsgChars)}`
    })
    .join("\n\n")
}

/**
 * Compress a thread's history into a summary.
 */
export async function compactThread(
  threadId: string,
  notify?: { channel: string; userId: string },
  llm?: CompactionLLM
): Promise<void> {
  const allMessages = await getHistory(threadId)
  if (allMessages.length <= KEEP_LAST_N_MESSAGES) return

  const cutIndex = findCompactionCutIndex(allMessages)
  if (cutIndex <= 0) {
    log.info(`[compaction] No clean user-turn boundary found — skipping`)
    return
  }

  const toSummarize = allMessages.slice(0, cutIndex)
  if (toSummarize.length === 0) return

  const lastSummarizedId = toSummarize[toSummarize.length - 1]!.id

  const existingSummary = await getSummary(threadId)
  if (existingSummary && existingSummary.last_message_id >= lastSummarizedId) return

  // Cap transcript to avoid overflowing small model contexts
  const capped = toSummarize.slice(-MAX_TRANSCRIPT_MSGS)
  const transcript = renderTranscript(capped)

  // El modelo del turno y SUS credenciales. Antes el resumen se pedía siempre
  // con `getDefaultLLM()` y sin credenciales, así que `resolveProviderConfig`
  // caía al secret store, al llavero del sistema o al entorno: en una
  // instalación multi-inquilino eso resume la conversación de un cliente con
  // la llave de la plataforma (o de otro cliente). Sin `llm` se comporta como
  // antes, que es lo que necesita una instalación de un solo usuario.
  const target = llm?.provider && llm.model
    ? { provider: llm.provider, model: llm.model }
    : await getDefaultLLM()
  if (!target) throw new Error("No active LLM providers/models configured in the database")

  const providerCfg = await resolveProviderConfig(target.provider, target.model, llm?.credentials)

  const summaryResponse = await callLLM({
    ...providerCfg,
    messages: [
      {
        role: "system",
        content:
          "You are a conversation summarizer. Create a concise summary preserving: " +
          "user preferences, decisions made, important facts, tool results, and context needed to continue.",
      },
      {
        role: "user",
        content: `Summarize this conversation (${toSummarize.length} messages) in 3-5 sentences:\n\n${transcript}`,
      },
    ],
  })

  // A failed provider call still returns a populated `content` (the error text),
  // so this has to gate on stop_reason — otherwise the summary that permanently
  // replaces N messages of history becomes "[LLM Error] ...". Skipping leaves the
  // thread uncompacted, which is recoverable; saving is not.
  if (summaryResponse.stop_reason === "error") {
    log.warn(
      `[compaction] Summarizer call failed (${summaryResponse.error?.message ?? "unknown error"}) — `
      + `keeping thread ${threadId} uncompacted rather than saving the error as its summary`
    )
    return
  }

  const summary = summaryResponse.content.trim()
  if (!summary) return

  await saveSummary(threadId, summary, toSummarize.length, lastSummarizedId)
  // Memoria entre hilos: segundo plano, fuera del camino de la respuesta.
  void indexThreadSummary(threadId, summary)
  log.info(
    `[compaction] Thread ${threadId} compacted: ${toSummarize.length} msgs → ${estimateTokens(summary)} tokens`
  )

  // Notify user in their active channel (non-critical)
  if (notify?.channel && notify?.userId) {
    try {
      const { sendToUserChannel } = await import("../gateway/channel-notify")
      await sendToUserChannel(
        notify.channel,
        notify.userId,
        `🗜️ Resumí ${toSummarize.length} mensajes anteriores para mantener el contexto limpio.`,
        { threadId }
      )
    } catch {
      // Non-critical — don't break the flow if notification fails
    }
  }
}

/**
 * Clear old tool results in-memory to reduce tokens before a model call.
 * Does NOT modify the database — only the in-memory messages array.
 * 
 * Strategy: COMPRESS (Context Engineering)
 * - Replaces old tool results with short summaries
 * - Keeps recent tool results intact (keepLastN)
 * - Uses TOON format for compact representation
 */
export function clearOldToolResults<T extends { role: string; content: string | ContentPart[] }>(
  messages: T[],
  keepLastN = 6
): T[] {
  if (messages.length <= keepLastN) return messages
  const cutoffIndex = messages.length - keepLastN

  return messages.map((msg, i) => {
    if (i >= cutoffIndex) return msg
    
    if (msg.role === "tool" && typeof msg.content === "string") {
      // For tool results older than keepLastN, summarize
      if (msg.content.length > TOOL_RESULT_MAX_CHARS) {
        // Try to extract key info from TOON/JSON format
        let summary = msg.content.substring(0, TOOL_RESULT_MAX_CHARS)
        
        // If it looks like JSON/TOON, add a marker
        if (msg.content.trim().startsWith('{') || msg.content.trim().includes(':')) {
          summary = `[Tool result summarized: ${summary}...]`
        } else {
          summary = `[Result truncated: ${summary}...]`
        }
        
        return {
          ...msg,
          content: summary,
        }
      }
    }
    
    return msg
  })
}

