/**
 * Thread store — el registro de conversaciones (`conversationThreads`).
 *
 * `conversations` no tiene índice secundario: los mensajes se leen por prefijo del
 * threadId. Esta colección es el catálogo que permite listar las conversaciones de
 * un usuario, ponerles título y borrarlas sin escanear todos los mensajes.
 *
 * El id de cada fila ES el threadId. La única fila cuyo id no tiene formato
 * `${user}/${canal}/${peer}` es la del hilo legacy anterior a la separación por
 * canal (ver ensureLegacyThread).
 */

import { col, updateDoc } from "../storage/hive"
import { logger } from "../utils/logger"
import type { ConversationThreadDoc, ConversationDoc, SummaryDoc } from "../storage/collections"
import { removeThreadSummary } from "./summary-memory"
import { makeThreadId, parseThreadId, newWebConversationId } from "./thread-id"
import { runSessionStart, runSessionEnd } from "../hooks/index"

const log = logger.child("thread-store")

const TITLE_MAX_CHARS = 60

/** Reintentos del contador ante mensajes concurrentes del mismo hilo. */
const TOUCH_MAX_RETRIES = 5

export interface EnsureThreadInput {
  userId: string
  channel: string
  peerId: string
  peerKind?: "direct" | "group"
}

async function threadsCol() {
  return col<ConversationThreadDoc>("conversationThreads")
}

export async function getThread(threadId: string): Promise<ConversationThreadDoc | null> {
  const c = await threadsCol()
  const entry = await c.get(threadId)
  return entry?.doc ?? null
}

/**
 * Crea la fila de la conversación si aún no existe y devuelve su threadId.
 * Idempotente: se llama en cada turno desde resolveContext.
 */
export async function ensureThread(input: EnsureThreadInput): Promise<string> {
  const threadId = makeThreadId(input.userId, input.channel, input.peerId)
  const c = await threadsCol()
  const existing = await c.get(threadId)
  if (existing) return threadId

  const now = Date.now()
  try {
    await c.put(threadId, {
      id: threadId,
      user_id: input.userId,
      channel: input.channel,
      peer_id: input.peerId,
      peer_kind: input.peerKind ?? "direct",
      title: null,
      archived: false,
      created_at: now,
      last_message_at: now,
      message_count: 0,
    }, { expectedVersion: 0 })
  } catch {
    // Otro turno del mismo canal la creó primero — ambos quieren lo mismo.
    return threadId
  }

  // `sessionStart` se dispara acá y no en `createSession` porque esa función es
  // idempotente y se llama en cada turno: engancharla ahí haría que el hook
  // corriera con cada mensaje. El `put` con `expectedVersion: 0` es el punto de
  // serialización, así que dispararlo justo después de que ese put haya salido
  // bien evita el doble disparo cuando dos turnos del mismo canal llegan juntos
  // — el perdedor se fue por el catch de arriba. Cubre además a quien llame
  // `ensureThread` directamente desde un canal, sin pasar por `sessions`.
  await runSessionStart({ threadId, userId: input.userId, channel: input.channel })
  return threadId
}

/** Conversación nueva de la web. El id lo elige el servidor, nunca el cliente. */
export async function createWebConversation(userId: string, title?: string): Promise<ConversationThreadDoc> {
  const peerId = newWebConversationId()
  const threadId = await ensureThread({ userId, channel: "webchat", peerId, peerKind: "direct" })
  if (title?.trim()) await renameThread(threadId, title)
  const doc = await getThread(threadId)
  if (!doc) throw new Error(`No pude crear la conversación ${threadId}`)
  return doc
}

/**
 * Título derivado del primer mensaje del usuario. El contenido llega con el
 * prefijo `[Timestamp: ...]` que le añaden el gateway y las rutas REST: esa línea
 * no describe nada, así que se descarta antes de recortar.
 */
export function deriveTitle(text: string): string | null {
  const withoutTimestamp = text.replace(/^\[Timestamp:[^\]]*\]\s*/, "").trim()
  const firstLine = withoutTimestamp.split("\n").find((l) => l.trim().length > 0)?.trim()
  if (!firstLine) return null
  return firstLine.length > TITLE_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1)}…`
    : firstLine
}

/**
 * Registra actividad en el hilo: contador, fecha del último mensaje y —la primera
 * vez que habla el usuario— el título.
 *
 * Si el hilo tiene formato y no existe la fila, la crea (es el caso de un hilo que
 * nació fuera de resolveContext, como el de una tarea programada). Si no lo tiene
 * —hilo legacy, hilos aislados `task-*`— solo actualiza una fila ya existente:
 * nunca inventa conversaciones para los hilos internos de los workers.
 */
export async function touchThread(
  threadId: string,
  opts: { role: "user" | "assistant" | "tool"; text?: string; internal?: boolean }
): Promise<void> {
  try {
    const c = await threadsCol()
    let existing = await c.get(threadId)

    if (!existing) {
      const parts = parseThreadId(threadId)
      if (!parts) return
      await ensureThread({ userId: parts.userId, channel: parts.channel, peerId: parts.peerId })
      existing = await c.get(threadId)
      if (!existing) return
    }

    // El contador se recalcula DENTRO del reintento, no fuera. `addMessage` llama
    // acá sin esperar el resultado, así que dos mensajes seguidos se solapan: con
    // el incremento calculado una sola vez, el reintento por conflicto de versión
    // vuelve a escribir el valor viejo y el conteo se queda corto para siempre.
    for (let attempt = 0; attempt < TOUCH_MAX_RETRIES; attempt++) {
      const fresh = attempt === 0 ? existing : await c.get(threadId)
      if (!fresh) return

      const next: ConversationThreadDoc = {
        ...fresh.doc,
        last_message_at: Date.now(),
        message_count: fresh.doc.message_count + 1,
      }
      // El título sale del primer mensaje humano: ni de la respuesta del agente ni
      // de un evento interno (fan-in de delegación), que no describen el tema.
      if (!fresh.doc.title && opts.role === "user" && !opts.internal && opts.text) {
        const title = deriveTitle(opts.text)
        if (title) next.title = title
      }

      try {
        await c.put(threadId, next, { expectedVersion: fresh.version })
        return
      } catch {
        // Conflicto de versión: otro mensaje del mismo hilo llegó primero.
      }
    }
    log.warn(`demasiada contención actualizando el hilo ${threadId}`)
  } catch (err) {
    // El registro es un catálogo, no la fuente de verdad: nunca debe tumbar un turno.
    log.warn(`no pude actualizar el hilo ${threadId}: ${(err as Error).message}`)
  }
}

export async function listThreads(
  userId: string,
  opts?: { channel?: string; includeArchived?: boolean }
): Promise<ConversationThreadDoc[]> {
  const c = await threadsCol()
  const rows = await c.findBy("user_id", userId)
  return rows
    .map((r) => r.doc)
    .filter((d) => (opts?.channel ? d.channel === opts.channel : true))
    .filter((d) => (opts?.includeArchived ? true : !d.archived))
    .sort((a, b) => b.last_message_at - a.last_message_at)
}

/** La conversación de webchat en la que seguiría escribiendo el usuario. */
export async function mostRecentWebThread(userId: string): Promise<ConversationThreadDoc | null> {
  const threads = await listThreads(userId, { channel: "webchat" })
  return threads[0] ?? null
}

export async function renameThread(threadId: string, title: string): Promise<void> {
  const clean = title.trim().slice(0, 200)
  await updateDoc<ConversationThreadDoc>("conversationThreads", threadId, { title: clean || null })
}

/**
 * Archiva el hilo: sale de la lista pero no se pierde nada.
 *
 * Vive acá y no en `sessions/index.ts` para que las cuatro transiciones del
 * ciclo de vida —crear, archivar, reabrir, borrar— disparen sus hooks desde un
 * solo archivo. Repartidas, la próxima que se agregue se olvida de disparar.
 */
export async function archiveThread(threadId: string): Promise<void> {
  const anterior = await getThread(threadId)
  await updateDoc<ConversationThreadDoc>("conversationThreads", threadId, { archived: true })
  // Archivar dos veces es un no-op, y el hook no debería enterarse dos veces.
  if (anterior?.archived) return
  await runSessionEnd({ threadId, userId: anterior?.user_id, channel: anterior?.channel })
}

/** Reabre un hilo archivado: vuelve a estar activo, y eso es un `sessionStart`. */
export async function unarchiveThread(threadId: string): Promise<void> {
  const anterior = await getThread(threadId)
  await updateDoc<ConversationThreadDoc>("conversationThreads", threadId, { archived: false })
  if (anterior && !anterior.archived) return
  await runSessionStart({ threadId, userId: anterior?.user_id, channel: anterior?.channel })
}

/**
 * Borra la conversación entera: mensajes, resumen, notas y la fila del registro.
 * Los mensajes se localizan por prefijo, igual que los lee conversation-store.
 */
export async function deleteThread(threadId: string): Promise<void> {
  const conversations = await col<ConversationDoc>("conversations")
  const messages = await conversations.scan({ prefix: `${threadId}:` })
  for (const m of messages) await conversations.delete(m.id)

  const summaries = await col<SummaryDoc>("summaries")
  await summaries.delete(threadId).catch(() => {})
  await removeThreadSummary(threadId)

  const scratchpad = await col<{ threadId: string }>("scratchpad")
  const notes = await scratchpad.scan({ prefix: `${threadId}:` })
  for (const n of notes) await scratchpad.delete(n.id)

  const c = await threadsCol()
  // La fila se lee antes de borrarla: después no hay de dónde sacar el usuario
  // ni el canal para el contexto del hook. El threadId los lleva codificados,
  // pero el hilo legacy es id = userId pelado y no parsea.
  const fila = (await c.get(threadId))?.doc
  await c.delete(threadId).catch(() => {})

  log.info(`conversación ${threadId} borrada (${messages.length} mensajes)`)
  await runSessionEnd({
    threadId,
    userId: fila?.user_id ?? parseThreadId(threadId)?.userId,
    channel: fila?.channel ?? parseThreadId(threadId)?.channel,
  })
}

/**
 * El hilo por el que hablarle a alguien en un canal cuando no venimos de un
 * mensaje suyo (avisos de tareas programadas, por ejemplo).
 *
 * En la web es la conversación activa; en los demás canales, el contacto al que
 * apunta `userIdentities`. Devuelve null si no hay ninguno, y quien llame decide
 * el fallback.
 */
export async function threadForChannel(userId: string, channel: string): Promise<string | null> {
  if (channel === "webchat") return (await mostRecentWebThread(userId))?.id ?? null

  const identities = await col<{ channel_user_id?: string }>("userIdentities")
  const identity = await identities.get(`${userId}:${channel}`)
  const peerId = identity?.doc.channel_user_id
  return peerId ? makeThreadId(userId, channel, peerId) : null
}

/**
 * Registra el hilo anterior a la separación por canal —`thread_id = userId`, un
 * único hilo compartido por todos los canales— como una conversación más de la
 * web, para que su historial siga siendo accesible. No mueve ni reescribe ningún
 * mensaje: la fila apunta al mismo prefijo de siempre.
 */
export async function ensureLegacyThread(userId: string): Promise<boolean> {
  const c = await threadsCol()
  if (await c.get(userId)) return false

  const conversations = await col<ConversationDoc>("conversations")
  const sample = await conversations.scan({ prefix: `${userId}:`, limit: 1 })
  if (sample.length === 0) return false

  const all = await conversations.scan({ prefix: `${userId}:` })
  const lastAt = all.reduce((max, e) => Math.max(max, e.doc.created_at), 0)

  await c.put(userId, {
    id: userId,
    user_id: userId,
    channel: "webchat",
    peer_id: "legacy",
    peer_kind: "direct",
    title: "Conversación anterior",
    archived: false,
    created_at: all[0]?.doc.created_at ?? Date.now(),
    last_message_at: lastAt || Date.now(),
    message_count: all.length,
  }, { expectedVersion: 0 }).catch(() => {})

  log.info(`hilo legacy ${userId} registrado como conversación (${all.length} mensajes)`)
  return true
}
