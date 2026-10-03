/**
 * Conversation Store — persists message history in the `conversations` HiveDB collection.
 * Replaces the LangGraph BunSqliteSaver + lg_checkpoints approach.
 *
 * Also manages: summaries and scratchpad, both HiveDB document collections.
 */

import { col, nextId, bumpRollup } from "../storage/hive"
import { logger } from "../utils/logger"
import type { LLMMessage, ContentPart } from "./llm-client"
import { estimateTokens } from "../utils/toon"
import type { ConversationDoc, SummaryDoc, MessageSource } from "../storage/collections"
import { touchThread } from "./thread-store"

const log = logger.child("conv-store")

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredMessage {
  /** Per-thread monotonic sequence number (NOT globally unique — scope every comparison to a single threadId). */
  id: number
  thread_id: string
  channel: string
  role: "user" | "assistant" | "tool"
  /** Provenance of this turn. Never null — legacy rows are normalized to "legacy_internal" on read. */
  source: MessageSource
  content: string
  tool_calls_json: string | null
  tool_call_id: string | null
  reasoning_content: string | null  // Kimi K2 thinking — must be round-tripped
  content_multimodal: string | null // JSON array of ContentPart[]
  token_count: number
  created_at: number
}

// ─── Internal events (delegation fan-in, etc.) ────────────────────────────────
//
// These are system-authored turns (async delegation outcomes) that must reach
// the model as input but must never be persisted with role:"system" — doing so
// causes every LLM provider to hoist them permanently into the system
// instruction on every subsequent turn (see gemini.ts/anthropic.ts, which
// concatenate ALL role:"system" messages into systemInstruction/system). They
// are persisted as role:"user" + a source tag instead, and wrapped with a
// framing marker only at serialization time (toAPIMessages), so stored content
// stays clean and the wording can evolve without a migration.

export const INTERNAL_SOURCES: ReadonlySet<string> =
  new Set(["task_complete", "delegation_summary", "legacy_internal", "realtime_chat"])

export function isInternalSource(source: string | null | undefined): boolean {
  return !!source && INTERNAL_SOURCES.has(source)
}

export function formatInternalEvent(source: string, content: string): string {
  // La charla hablada sí salió del usuario, pero la sesión de voz ya la
  // respondió: es contexto, no trabajo por hacer. Sin esta distinción el
  // coordinador leía cada frase suelta de una llamada como un pedido nuevo y
  // delegaba una tarea por cada una.
  if (source === "realtime_chat") {
    return `<hive:voice_context>\n` +
      `Fragmento de una conversación hablada que la voz de Hive YA respondió en el momento. ` +
      `Es contexto de lo que vinieron hablando, NO un pedido pendiente: no ejecutes ni delegues nada por esto. ` +
      `El trabajo real llega siempre como un mensaje aparte y explícito.\n\n` +
      `${content}\n` +
      `</hive:voice_context>`
  }

  return `<hive:internal_event source="${source}">\n` +
    `Evento interno del sistema — NO es un mensaje del usuario. No lo cites literalmente, no expongas IDs internos (task_id, worker_id) ni JSON crudo. Respondé al usuario de forma natural y breve.\n\n` +
    `${content}\n` +
    `</hive:internal_event>`
}

function storageId(threadId: string, seq: number): string {
  return `${threadId}:${String(seq).padStart(15, "0")}`
}

function toStoredMessage(id: string, doc: ConversationDoc): StoredMessage {
  const seq = parseInt(id.slice(id.lastIndexOf(":") + 1), 10)
  // Legacy rows (written before `source` existed) used role:"system" as the
  // sole marker for internal events. Normalize them here so every downstream
  // reader (getRecentMessages, compaction, context-compiler) sees a single
  // consistent shape and never has to special-case role:"system" again.
  const legacyInternal = doc.role === "system"
  return {
    id: seq,
    thread_id: doc.thread_id,
    channel: doc.channel,
    role: legacyInternal ? "user" : (doc.role as StoredMessage["role"]),
    source: doc.source ?? (legacyInternal ? "legacy_internal" : "message"),
    content: doc.content,
    tool_calls_json: doc.tool_calls_json,
    tool_call_id: doc.tool_call_id,
    reasoning_content: doc.reasoning_content,
    content_multimodal: doc.content_multimodal,
    token_count: doc.token_count,
    created_at: doc.created_at,
  }
}

// ─── Message operations ───────────────────────────────────────────────────────

const recentMessageTimestamps: number[] = []

export function getRecentMessageCount(windowMs = 5 * 60_000): number {
  const cutoff = Date.now() - windowMs
  while (recentMessageTimestamps.length && recentMessageTimestamps[0]! < cutoff) {
    recentMessageTimestamps.shift()
  }
  return recentMessageTimestamps.length
}

/** El threadId es `${userId}/${canal}/${peer}`, así que el dueño ya está ahí. */
async function resolveOwnerId(threadId: string): Promise<string> {
  const { parseThreadId } = await import("./thread-id")
  return parseThreadId(threadId)?.userId ?? threadId
}

/**
 * Cuánto ocupa una imagen en la ventana de contexto.
 *
 * Los proveedores cobran por área, no por bytes: la fórmula es la de los
 * modelos de visión más comunes (~750 px² por token). Es una estimación, pero
 * cualquier estimación es infinitamente mejor que la anterior, que era cero: la
 * compactación creía que un hilo con diez fotos ocupaba lo que ocupa su texto,
 * y no se disparaba hasta que el proveedor rechazaba el turno.
 */
export function estimateImageTokens(width?: number | null, height?: number | null): number {
  if (!width || !height) return 1_500;   // desconocida: el promedio de una foto
  return Math.ceil((width * height) / 750);
}

/**
 * Cambia las imágenes en línea por referencias a un artefacto.
 *
 * El base64 se guardaba entero en `content_multimodal` y `toAPIMessages` lo
 * devolvía al modelo **en cada turno siguiente**: cinco fotos en una
 * conversación eran cinco fotos reenviadas una y otra vez. Guardar el archivo y
 * dejar una referencia corta ese crecimiento de raíz.
 *
 * La imagen no se pierde: `inflateRecentImages` la vuelve a poner en línea para
 * los últimos turnos, que es donde el modelo todavía puede necesitar mirarla.
 */
async function imagesToRefs(content: ContentPart[], userId: string): Promise<ContentPart[]> {
  const { createArtifact } = await import("../artifacts/store")
  const out: ContentPart[] = []

  for (const part of content) {
    if (part.type !== "image_base64") { out.push(part); continue }
    try {
      const bytes = Uint8Array.from(Buffer.from((part as { base64: string }).base64, "base64"))
      const mimeType = (part as { mimeType?: string }).mimeType || "image/jpeg"
      // Si no se puede medir, no es una imagen. Guardarla igual crearía un
      // artefacto de tipo "image" con basura adentro, que aparecería en la
      // galería del usuario; es mejor dejarla como venía.
      const { measureImage } = await import("../images/index")
      const meta = await measureImage(bytes)

      const art = await createArtifact({
        bytes, mimeType, kind: "image", userId,
        width: meta.width, height: meta.height, expiresAt: null,
      })
      out.push({ type: "artifact_ref", artifact_id: art.id, mime_type: mimeType, width: meta.width, height: meta.height } as unknown as ContentPart)
    } catch {
      // No es una imagen medible, o no se pudo guardar: viaja como venía.
      // Perderla sería peor que no optimizarla.
      out.push(part)
    }
  }
  return out
}

export async function addMessage(
  threadId: string,
  role: StoredMessage["role"],
  content: string | ContentPart[],
  opts?: {
    channel?: string
    tool_calls?: LLMMessage["tool_calls"]
    tool_call_id?: string
    reasoning_content?: string
    source?: MessageSource
    /** Dueño de los artefactos que se creen para este mensaje (imágenes). */
    userId?: string
  }
): Promise<number> {
  // Handle multimodal content by extracting text for the content column
  const textContent = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter(p => p.type === "text").map(p => (p as any).text).join("\n")
      : String(content)

  // Las imágenes se guardan como archivo y en el historial queda una
  // referencia: el base64 entero se reenviaba al modelo en cada turno.
  const partes = Array.isArray(content)
    ? await imagesToRefs(content, opts?.userId ?? (await resolveOwnerId(threadId)))
    : null
  const content_multimodal = partes ? JSON.stringify(partes) : null
  const tool_calls_json = opts?.tool_calls ? JSON.stringify(opts.tool_calls) : null

  const paddedSeq = await nextId(`conversations:${threadId}`)
  const seq = parseInt(paddedSeq, 10)
  const now = Date.now()

  const conversationsCol = await col<ConversationDoc>("conversations")
  await conversationsCol.put(storageId(threadId, seq), {
    id: storageId(threadId, seq),
    thread_id: threadId,
    channel: opts?.channel ?? "webchat",
    role,
    content: textContent,
    content_multimodal,
    tool_calls_json,
    tool_call_id: opts?.tool_call_id ?? null,
    reasoning_content: opts?.reasoning_content ?? null,
    source: opts?.source ?? "message",
    // Estimate tokens: content + tool_calls JSON
    // Las imágenes cuentan: antes sumaban cero y la compactación creía que un
    // hilo lleno de fotos ocupaba lo que ocupa su texto.
    token_count: Math.max(
      1,
      estimateTokens(textContent) +
      estimateTokens(tool_calls_json ?? "") +
      (partes ?? []).reduce((n, p) => {
        const q = p as { type: string; width?: number | null; height?: number | null }
        return q.type === "artifact_ref" || q.type === "image_base64" || q.type === "image_url"
          ? n + estimateImageTokens(q.width, q.height)
          : n
      }, 0),
    ),
    created_at: now,
    updated_at: now,
  }, { expectedVersion: 0 })

  // Fire-and-forget — never block message persistence on the activity chart rollup.
  const hour = new Date(now).toISOString().slice(0, 13)
  bumpRollup("activityRollups", hour, { messageCount: 1 }).catch(() => {})
  recentMessageTimestamps.push(now)

  // Igual de opcional: el registro de conversaciones es el catálogo que alimenta la
  // lista de la web (título, orden, contador). Se actualiza acá y no en cada llamador
  // para que todo camino que escriba un mensaje —canales, webchat, API, voz— lo
  // mantenga al día sin repetir la llamada.
  touchThread(threadId, {
    role,
    text: textContent,
    internal: isInternalSource(opts?.source),
  }).catch(() => {})

  return seq
}

/**
 * Returns all messages for the thread ordered oldest → newest.
 */
export async function getHistory(threadId: string, limit = 200): Promise<StoredMessage[]> {
  const conversationsCol = await col<ConversationDoc>("conversations")
  const entries = await conversationsCol.scan({ prefix: `${threadId}:`, limit })
  return entries.map(e => toStoredMessage(e.id, e.doc))
}

/**
 * Returns only the last N messages (oldest → newest order),
 * with leading orphaned tool messages stripped from the window start.
 *
 * A tool message is "orphaned" when the assistant message that issued its
 * tool_call_id is not present in the loaded window (it was compacted away).
 * Sending orphaned tool messages to the LLM causes provider errors.
 */
export async function getRecentMessages(threadId: string, n: number): Promise<StoredMessage[]> {
  const conversationsCol = await col<ConversationDoc>("conversations")
  const entries = await conversationsCol.scan({ prefix: `${threadId}:`, reverse: true })
  const nonTool = entries.filter(e => e.doc.role !== "tool").slice(0, n)
  const rows = nonTool.map(e => toStoredMessage(e.id, e.doc)).reverse()
  return stripLeadingOrphanedTools(rows)
}

function stripLeadingOrphanedTools(rows: StoredMessage[]): StoredMessage[] {
  // Collect all tool_call_ids referenced by assistant messages in this window
  const knownIds = new Set<string>()
  for (const r of rows) {
    if (r.role === "assistant" && r.tool_calls_json) {
      try {
        const tcs = JSON.parse(r.tool_calls_json) as Array<{ id: string }>
        for (const tc of tcs) knownIds.add(tc.id)
      } catch { /* ignore malformed JSON */ }
    }
  }

  // Drop tool messages at the start of the window whose assistant is missing
  let start = 0
  while (start < rows.length) {
    const row = rows[start]!
    if (!(row.role === "tool" && row.tool_call_id !== null && !knownIds.has(row.tool_call_id))) break
    start++
  }

  if (start > 0) {
    log.warn(`[conv-store] Stripped ${start} leading orphaned tool message(s) from window (tool_call_ids outside window)`)
  }
  return start > 0 ? rows.slice(start) : rows
}

export async function getMessageCount(threadId: string): Promise<number> {
  const conversationsCol = await col<ConversationDoc>("conversations")
  const entries = await conversationsCol.scan({ prefix: `${threadId}:` })
  return entries.length
}

export async function getTotalTokens(threadId: string): Promise<number> {
  const conversationsCol = await col<ConversationDoc>("conversations")
  const entries = await conversationsCol.scan({ prefix: `${threadId}:` })
  return entries.reduce((sum, e) => sum + e.doc.token_count, 0)
}

/**
 * Messages after a given message ID (for incremental summary updates).
 */
export async function getMessagesAfter(threadId: string, afterId: number): Promise<StoredMessage[]> {
  const conversationsCol = await col<ConversationDoc>("conversations")
  const entries = await conversationsCol.scan({ prefix: `${threadId}:` })
  return entries
    .map(e => toStoredMessage(e.id, e.doc))
    .filter(m => m.id > afterId)
}

// ─── Convert stored messages → LLMMessage array ───────────────────────────────

/**
 * Cuántos mensajes del final conservan sus imágenes en línea.
 *
 * Mismo criterio que `clearOldToolResults` (compaction.ts), que ya poda
 * resultados viejos y deja intactos los recientes. Es el compromiso: el modelo
 * puede volver a mirar una imagen de hace un rato —"¿qué decía la factura?"—
 * sin que una conversación larga arrastre todas las fotos para siempre.
 */
export const KEEP_IMAGES_LAST_N = 6

/**
 * Vuelve a poner en línea las imágenes de los últimos mensajes.
 *
 * En el historial las imágenes son referencias (ver `imagesToRefs`), que no
 * ocupan contexto pero tampoco se pueden mirar: un modelo de visión no ve una
 * foto desde un id. Para los últimos `keepLastN` mensajes se leen del disco y
 * se devuelven como base64; los anteriores quedan como referencia, con sus
 * dimensiones, para que el modelo sepa que hubo una imagen y cuál.
 */
export async function inflateRecentImages(
  messages: LLMMessage[],
  keepLastN = KEEP_IMAGES_LAST_N,
): Promise<LLMMessage[]> {
  const desde = Math.max(0, messages.length - keepLastN)
  const tieneRefs = messages.slice(desde).some((m) =>
    Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === "artifact_ref"))
  if (!tieneRefs) return messages

  const { readArtifactBytes } = await import("../artifacts/store")

  return Promise.all(messages.map(async (msg, i) => {
    if (i < desde || !Array.isArray(msg.content)) return msg

    const partes = await Promise.all(msg.content.map(async (part) => {
      const p = part as { type: string; artifact_id?: string; mime_type?: string }
      if (p.type !== "artifact_ref" || !p.artifact_id) return part
      if (!String(p.mime_type ?? "").startsWith("image/")) return part

      try {
        const datos = await readArtifactBytes(p.artifact_id)
        if (!datos) return part   // caducó o se borró: queda la referencia
        return {
          type: "image_base64",
          base64: Buffer.from(datos.bytes).toString("base64"),
          mimeType: datos.mimeType,
        } as unknown as ContentPart
      } catch {
        return part
      }
    }))

    return { ...msg, content: partes }
  }))
}

export function toAPIMessages(rows: StoredMessage[]): LLMMessage[] {
  return rows.map((r) => {
    let content: string | ContentPart[] = r.content
    if (r.content_multimodal) {
      try { content = JSON.parse(r.content_multimodal) } catch { /* ignore */ }
    }
    // Internal events (delegation fan-in) are wrapped at serialization time —
    // never at authoring time — so stored content stays clean and legacy rows
    // (normalized to source:"legacy_internal" in toStoredMessage) get wrapped
    // for free. Internal events are never multimodal in practice.
    if (isInternalSource(r.source) && typeof content === "string") {
      content = formatInternalEvent(r.source, content)
    }
    const msg: LLMMessage = { role: r.role, content }
    // Note: tool_calls and tool_call_id are NOT reconstructed from DB.
    // Tool results are kept in-memory during iteration but not persisted,
    // so historical messages only contain text conversation.
    if (r.reasoning_content) msg.reasoning_content = r.reasoning_content
    return msg
  })
}

// ─── Summaries ────────────────────────────────────────────────────────────────

export interface Summary {
  summary: string
  last_message_id: number
  messages_covered: number
}

export async function getSummary(threadId: string): Promise<Summary | null> {
  const summariesCol = await col<SummaryDoc>("summaries")
  const entry = await summariesCol.get(threadId)
  if (!entry) return null
  return {
    summary: entry.doc.summary,
    last_message_id: entry.doc.last_message_id ? parseInt(entry.doc.last_message_id, 10) : 0,
    messages_covered: entry.doc.messages_covered,
  }
}

export async function saveSummary(
  threadId: string,
  summary: string,
  messagesCovered: number,
  lastMessageId: number
): Promise<void> {
  const summariesCol = await col<SummaryDoc>("summaries")
  const existing = await summariesCol.get(threadId)
  await summariesCol.put(threadId, {
    thread_id: threadId,
    summary,
    messages_covered: messagesCovered,
    last_message_id: String(lastMessageId),
  }, existing ? { expectedVersion: existing.version } : { expectedVersion: 0 })
}

// ─── Scratchpad (HiveDB collection) ────────────────────────────────────────────
//
// Persistent key-value notes per conversation. Lives in a HiveDB document
// collection instead of SQLite: id = "<threadId>:<key>", so a per-thread
// listing is a prefix scan and no secondary index is needed.

export interface ScratchpadDoc {
  threadId: string
  key: string
  value: string
  source: string | null
  createdAt: number
  updatedAt: number
  /** Monotonic per-process counter — tiebreaker for notes saved within the same clock tick. */
  seq: number
}

let scratchpadSeq = 0

/** Wire shape for the admin notes panel — mirrors the old SQLite row (snake_case, epoch seconds). */
export interface ScratchpadNoteRow {
  id: string
  thread_id: string
  key: string
  value: string
  source: string | null
  created_at: number
  updated_at: number
}

function scratchpadNoteId(threadId: string, key: string): string {
  return `${threadId}:${key}`
}

async function scratchpadCollection() {
  // Vía `col()` y no `db.collection()` a pelo: es lo que aplica el prefijo de
  // tenant y mantiene las notas de cada enjambre en su propia partición.
  return col<ScratchpadDoc>("scratchpad")
}

export async function saveScratchpadNote(
  threadId: string,
  key: string,
  value: string,
  source?: string
): Promise<void> {
  const col = await scratchpadCollection()
  const id = scratchpadNoteId(threadId, key)
  const existing = await col.get(id)
  const now = Date.now()
  await col.put(id, {
    threadId,
    key,
    value,
    source: source ?? null,
    createdAt: existing?.doc.createdAt ?? now,
    updatedAt: now,
    seq: scratchpadSeq++,
  })
}

function byMostRecent(a: { doc: ScratchpadDoc }, b: { doc: ScratchpadDoc }): number {
  return b.doc.updatedAt - a.doc.updatedAt || b.doc.seq - a.doc.seq
}

export async function getScratchpad(threadId: string): Promise<Array<{ key: string; value: string }>> {
  const col = await scratchpadCollection()
  const entries = await col.scan({ prefix: `${threadId}:` })
  return entries
    .sort(byMostRecent)
    .map((e) => ({ key: e.doc.key, value: e.doc.value }))
}

/** All notes across every thread, most recently updated first — used by the admin notes panel. */
export async function listAllScratchpadNotes(limit: number): Promise<ScratchpadNoteRow[]> {
  const col = await scratchpadCollection()
  const entries = await col.scan({})
  return entries
    .sort(byMostRecent)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      thread_id: e.doc.threadId,
      key: e.doc.key,
      value: e.doc.value,
      source: e.doc.source,
      created_at: Math.floor(e.doc.createdAt / 1000),
      updated_at: Math.floor(e.doc.updatedAt / 1000),
    }))
}

export async function deleteScratchpadNote(threadId: string, key: string): Promise<void> {
  const col = await scratchpadCollection()
  await col.delete(scratchpadNoteId(threadId, key))
}
