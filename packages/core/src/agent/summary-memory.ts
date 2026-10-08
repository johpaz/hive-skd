/**
 * Memoria entre hilos — los resúmenes de compactación, indexados en HiveDB.
 *
 * Cada hilo tiene UN resumen acumulativo (cada compactación incorpora el
 * anterior), así que no hay resúmenes viejos que recuperar dentro del mismo
 * hilo. Lo que sí aporta el índice es encontrar, por relevancia, lo hablado en
 * OTROS hilos del mismo inquilino.
 *
 * Convención (mismo índice que capability-search): id `summary:<threadId>`,
 * filtros `type=summary`, `thread`, `tenant` y su gemelo `tenant__type`.
 * `searchCapabilities` siempre filtra por `type`, así que no los ve.
 */

import { getHiveDb } from "../storage/hivedb"
import { currentTenant, qualifyDocId, unqualifyDocId, scopedFilterValue } from "../storage/tenant"
import { getSummary } from "./conversation-store"
import { loadConfig } from "../config/loader"
import { logger } from "../utils/logger"

const log = logger.child("summary-memory")

const TYPE = "summary"
const CATALOGO = "_"
const DEFAULT_K = 3
const QUERY_MAX_CHARS = 500
const BODY_MAX_CHARS = 4000

export interface RelatedSummary {
  threadId: string
  summary: string
  score: number
}

export function crossThreadRecallEnabled(): boolean {
  return !!loadConfig().memory?.crossThreadRecall?.enabled
}

function docId(threadId: string): string {
  return qualifyDocId(`${TYPE}:${threadId}`)
}

/** Indexa (o reemplaza) el resumen de un hilo. Nunca lanza: es memoria auxiliar. */
export async function indexThreadSummary(threadId: string, summary: string): Promise<void> {
  try {
    const db = await getHiveDb()
    await db.upsertDoc({
      id: docId(threadId),
      body: summary.slice(0, BODY_MAX_CHARS),
      filters: [
        { field: "type", value: TYPE },
        { field: "thread", value: threadId },
        { field: "tenant", value: currentTenant() ?? CATALOGO },
        { field: "tenant__type", value: scopedFilterValue(TYPE) },
      ],
    })
  } catch (err) {
    log.warn(`[summary-memory] No se pudo indexar el resumen de ${threadId}: ${(err as Error).message}`)
  }
}

/** Quita el resumen de un hilo del índice (al borrar la conversación). */
export async function removeThreadSummary(threadId: string): Promise<void> {
  try {
    const db = await getHiveDb()
    await db.deleteDoc(docId(threadId))
  } catch (err) {
    log.warn(`[summary-memory] No se pudo quitar el resumen de ${threadId}: ${(err as Error).message}`)
  }
}

/** Resúmenes de otros hilos del inquilino activo, por relevancia a `query`. */
export async function searchRelatedSummaries(
  query: string,
  excludeThreadId: string,
  k = loadConfig().memory?.crossThreadRecall?.k ?? DEFAULT_K,
): Promise<RelatedSummary[]> {
  const text = query.trim().slice(0, QUERY_MAX_CHARS)
  if (!text || k <= 0) return []
  try {
    const db = await getHiveDb()
    // +1: el hilo actual puede ocupar un puesto y se descarta después.
    const hits = await db.queryHybrid({
      text,
      k: k + 1,
      filters: [
        { field: "tenant", value: currentTenant() ?? CATALOGO },
        { field: "type", value: TYPE },
      ],
    })
    const prefix = `${TYPE}:`
    const out: RelatedSummary[] = []
    for (const hit of hits) {
      const id = unqualifyDocId(hit.id)
      if (!id.startsWith(prefix)) continue
      const threadId = id.slice(prefix.length)
      if (threadId === excludeThreadId) continue
      // El índice solo devuelve ids: el texto vive en la colección `summaries`.
      // Si el hilo ya no tiene resumen, el documento del índice quedó huérfano.
      const stored = await getSummary(threadId)
      if (!stored) continue
      out.push({ threadId, summary: stored.summary, score: hit.score })
      if (out.length >= k) break
    }
    return out
  } catch (err) {
    log.warn(`[summary-memory] Búsqueda de resúmenes relacionados falló: ${(err as Error).message}`)
    return []
  }
}
