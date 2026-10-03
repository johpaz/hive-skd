/**
 * Sessions — la conversación de un usuario, como una sola cosa.
 *
 * Hasta acá "sesión" estaba repartida en cuatro capas que nadie unía:
 *
 *  - `agent/thread-store.ts`      — identidad y catálogo (`conversationThreads`)
 *  - `agent/conversation-store.ts`— los mensajes (`conversations`, por prefijo)
 *  - `agent/run-store.ts`         — la ejecución: checkpoint, lease, resume
 *  - `state/store.ts`             — un `Map` en memoria que muere con el proceso
 *
 * El resultado eran dos identificadores para lo mismo —`thread_id` para la
 * conversación y `run_id` para la ejecución— y ninguna forma de preguntar "qué
 * sesiones tiene este usuario" sin escanear mensajes.
 *
 * Este módulo **no agrega una tercera persistencia**: `Session` es una vista
 * compuesta sobre las colecciones que ya existen. `Session.id` ES el `threadId`.
 * Agregar una colección propia habría recreado exactamente la duplicación que
 * este módulo viene a cerrar.
 *
 * `state/store.ts` queda para métricas efímeras; no es la sesión.
 */

import type { ContentPart } from "../multimodal/types"
import type { AgentRunDoc, ConversationThreadDoc } from "../storage/collections"
import {
  addMessage,
  getHistory,
  type StoredMessage,
} from "../agent/conversation-store"
import {
  archiveThread,
  createWebConversation,
  deleteThread,
  ensureThread,
  getThread,
  listThreads,
  mostRecentWebThread,
  renameThread,
  threadForChannel,
  unarchiveThread,
} from "../agent/thread-store"
import {
  deserializeCheckpoint,
  findRunsByThread,
  type RunCheckpointState,
} from "../agent/run-store"

export * from "../agent/thread-id"
export * from "./resolve"

/** El estado de ejecución más reciente del hilo, si alguna vez corrió. */
export interface SessionRun {
  runId: string
  agentId: string
  status: AgentRunDoc["status"]
  kind: AgentRunDoc["kind"]
  updatedAt: number
  /** true cuando quedó a medias y `resumeSession` puede retomarla. */
  resumable: boolean
}

/**
 * Una sesión: la identidad del hilo más, opcionalmente, su última ejecución.
 * Es una vista, no una fila: se compone de `conversationThreads` + `agentRuns`.
 */
export interface Session {
  /** ES el threadId (`${user}/${canal}/${peer}`). */
  id: string
  userId: string
  channel: string
  peerId: string
  peerKind: "direct" | "group"
  title: string | null
  archived: boolean
  createdAt: number
  lastMessageAt: number
  messageCount: number
  lastRun?: SessionRun
}

/** Una ejecución interrumpida sigue siendo retomable; una terminada no. */
const RESUMABLE_STATUSES: ReadonlySet<AgentRunDoc["status"]> = new Set([
  "interrupted",
  "running",
])

function toSessionRun(run: AgentRunDoc): SessionRun {
  return {
    runId: run.id,
    agentId: run.agent_id,
    status: run.status,
    kind: run.kind,
    updatedAt: run.updated_at ?? run.created_at,
    resumable: RESUMABLE_STATUSES.has(run.status),
  }
}

function toSession(doc: ConversationThreadDoc, lastRun?: SessionRun): Session {
  return {
    id: doc.id,
    userId: doc.user_id,
    channel: doc.channel,
    peerId: doc.peer_id,
    peerKind: doc.peer_kind,
    title: doc.title,
    archived: doc.archived,
    createdAt: doc.created_at,
    lastMessageAt: doc.last_message_at,
    messageCount: doc.message_count,
    ...(lastRun ? { lastRun } : {}),
  }
}

/** La ejecución más reciente del hilo, o undefined si nunca corrió. */
async function latestRun(threadId: string): Promise<SessionRun | undefined> {
  const runs = await findRunsByThread(threadId)
  if (runs.length === 0) return undefined
  const newest = runs.reduce((a, b) =>
    (b.updated_at ?? b.created_at) > (a.updated_at ?? a.created_at) ? b : a,
  )
  return toSessionRun(newest)
}

export interface CreateSessionInput {
  userId: string
  channel: string
  peerId: string
  peerKind?: "direct" | "group"
}

/**
 * Abre la sesión de un usuario en un canal, o devuelve la que ya existía.
 * Idempotente: se puede llamar en cada turno.
 */
export async function createSession(input: CreateSessionInput): Promise<Session> {
  const threadId = await ensureThread(input)
  const doc = await getThread(threadId)
  if (!doc) throw new Error(`No se pudo abrir la sesión ${threadId}`)
  return toSession(doc)
}

/** Una conversación nueva de la web, con su propio id (no reusa la anterior). */
export async function createWebSession(userId: string, title?: string): Promise<Session> {
  return toSession(await createWebConversation(userId, title))
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const doc = await getThread(sessionId)
  if (!doc) return null
  return toSession(doc, await latestRun(sessionId))
}

export interface ListSessionsOptions {
  channel?: string
  includeArchived?: boolean
  /**
   * Adjunta la última ejecución de cada sesión. Cuesta una consulta por sesión,
   * así que está apagado por defecto: la lista de conversaciones no lo necesita.
   */
  withRuns?: boolean
}

/**
 * Las sesiones de un usuario, de la más reciente a la más vieja.
 *
 * Es la consulta que antes no existía: el estado en memoria se perdía en cada
 * reinicio y los mensajes sólo se podían leer por prefijo de un hilo conocido.
 */
export async function listSessions(
  userId: string,
  opts?: ListSessionsOptions,
): Promise<Session[]> {
  const docs = await listThreads(userId, {
    channel: opts?.channel,
    includeArchived: opts?.includeArchived,
  })
  if (!opts?.withRuns) return docs.map((d) => toSession(d))
  return Promise.all(docs.map(async (d) => toSession(d, await latestRun(d.id))))
}

/** La sesión de webchat en la que el usuario seguiría escribiendo. */
export async function mostRecentWebSession(userId: string): Promise<Session | null> {
  const doc = await mostRecentWebThread(userId)
  return doc ? toSession(doc) : null
}

/**
 * La sesión por la que hablarle a alguien en un canal cuando no venimos de un
 * mensaje suyo (un aviso de tarea programada, por ejemplo). null si no hay.
 */
export async function sessionForChannel(
  userId: string,
  channel: string,
): Promise<string | null> {
  return threadForChannel(userId, channel)
}

/**
 * Agrega un mensaje y mantiene al día el catálogo (título, orden, contador):
 * `addMessage` ya llama a `touchThread`, así que no hay que hacerlo acá.
 *
 * Ojo: esa actualización del catálogo es deliberadamente *fire-and-forget* —
 * persistir el mensaje nunca se bloquea por el contador. En la práctica eso
 * significa que `messageCount` y `title` son de consistencia eventual: leer la
 * sesión inmediatamente después de escribir puede devolver el valor anterior.
 * El historial (`getSessionHistory`) sí es consistente al instante.
 */
export async function appendMessage(
  sessionId: string,
  role: StoredMessage["role"],
  content: string | ContentPart[],
  opts?: Parameters<typeof addMessage>[3],
): Promise<number> {
  return addMessage(sessionId, role, content, opts)
}

export async function getSessionHistory(
  sessionId: string,
  limit?: number,
): Promise<StoredMessage[]> {
  return getHistory(sessionId, limit)
}

export interface ResumableSession {
  run: SessionRun
  checkpoint: RunCheckpointState
}

/**
 * El trabajo a medias de una sesión, listo para retomar.
 *
 * Devuelve null cuando no hay nada que retomar — que es el caso normal. Un run
 * `running` sin checkpoint tampoco sirve: murió antes de guardar estado.
 */
export async function resumeSession(sessionId: string): Promise<ResumableSession | null> {
  const runs = await findRunsByThread(sessionId)
  const candidates = runs
    .filter((r) => RESUMABLE_STATUSES.has(r.status))
    .sort((a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at))

  for (const run of candidates) {
    const checkpoint = deserializeCheckpoint(run)
    if (checkpoint) return { run: toSessionRun(run), checkpoint }
  }
  return null
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  return renameThread(sessionId, title)
}

/**
 * Cierra la sesión sin perder nada: sale de la lista pero el historial queda.
 * Para borrarla de verdad, `deleteSession`.
 */
export async function closeSession(sessionId: string): Promise<void> {
  return archiveThread(sessionId)
}

/** Reabre una sesión archivada. */
export async function reopenSession(sessionId: string): Promise<void> {
  return unarchiveThread(sessionId)
}

/** Borra la sesión entera: mensajes, resumen, notas y su fila del catálogo. */
export async function deleteSession(sessionId: string): Promise<void> {
  return deleteThread(sessionId)
}
