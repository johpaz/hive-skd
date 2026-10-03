/**
 * Live-tail wrapper over HiveDB's G9 causal event log (subscribe()/events()).
 *
 * Read-side, separate from agent-loop.ts's write-side appendCausalEvent()
 * (module-private there, write-only). This is the read/watch counterpart,
 * co-located with the DB singleton accessor. It also owns the shard key both
 * sides use (causalAgentKey) and the agent scope of every aggregated read
 * (causalScope).
 */

import { getHiveDb } from "./hivedb"
import { currentTenant, qualifyDocId, unqualifyDocId } from "./tenant"
import { loadConfig } from "../config/loader"
import type { Event, EventPattern } from "@johpaz/hive-db"

export type { Event as CausalEvent, EventPattern as CausalEventPattern }

/**
 * Clave de shard de un agente en el log causal.
 *
 * El log no tiene colecciones que prefijar: cada evento va al shard de su
 * `agentId`, y ahí está todo el aislamiento. Con un tenant activo la clave
 * lleva el tenant delante (`t_…:agentId`, la misma forma que usa el índice
 * BM25 vía `qualifyDocId`), así que dos inquilinos con un agente del mismo id
 * no comparten shard. Sin tenant es la identidad y un log de un solo dueño no
 * cambia.
 *
 * Escritura y lecturas tienen que pasar por aquí: un evento escrito con una
 * clave y leído con otra simplemente no aparece.
 */
export function causalAgentKey(agentId: string): string {
  return qualifyDocId(agentId)
}

/**
 * Lista `agents` para `causalThread`, `toolStats` y `buildAgentContext`.
 *
 * Devuelve `null` si no queda ningún agente, y quien llama se salta la
 * lectura: hive-db trata una lista vacía igual que la ausencia de filtro y
 * recorre TODOS los shards, que sobre una base compartida es leer los eventos
 * de otros inquilinos.
 */
export function causalScope(agentIds: Iterable<string | null | undefined>): string[] | null {
  const keys = new Set<string>()
  for (const id of agentIds) {
    if (id) keys.add(causalAgentKey(id))
  }
  return keys.size > 0 ? [...keys] : null
}

/**
 * ¿Se lee el log causal (reflector, contexto causal del compilador)?
 *
 * Con hive-db 0.4, `causalThread`, `buildAgentContext` y `toolStats` recorrían
 * todos los shards y mezclaban sus resultados, así que con un tenant activo
 * había que apagarlas para no devolver hilos y estadísticas de otros
 * inquilinos. hive-db 0.5.1 —la mínima que pide el SDK— acepta `agents` en las
 * tres, y el SDK las llama siempre acotadas con {@link causalScope}: basta con
 * que el log esté encendido.
 */
export function causalReadsEnabled(): boolean {
  return !!loadConfig().causalLog?.enabled
}

/**
 * Live-tail causal events matching `pattern`. Forward-only: only events
 * appended AFTER this call resolves are delivered. hive-db's subscribe()/
 * events() are a pure in-process pub/sub (see hiveBD's reactive.rs — a
 * DashMap of subscribers, dispatched right after the durable write, with no
 * backing read of the log on subscribe) — there is no historical replay.
 * Combine with causalThread()/read(seq) if backfill is ever needed.
 *
 * Note: `pattern.kind` matches exactly one kind at a time, not an OR of
 * several — call watchCausalEvents() once per kind if you need more than one.
 *
 * Process constraint (confirmed by testing): getHiveDb() opens the database
 * exclusively — there is no shared/read-only mode, so this can only be
 * called from within the SAME process as whatever else has the DB open
 * (e.g. embedded inside the gateway). A separate process (like the `hive
 * causal watch` CLI) calling this while a `hive` gateway is already running
 * against the same DB fails fast with an "already open" error.
 */
export async function watchCausalEvents(
  pattern: EventPattern
): Promise<AsyncIterable<Event> & { close(): void }> {
  // Un patrón sin `agentId` sobre una base compartida entregaría los eventos de
  // todos los enjambres, así que con un tenant activo se exige explícitamente en
  // vez de filtrar a medias. Se recibe el id crudo del agente y su shard se
  // busca por la clave calificada.
  if (currentTenant() && !pattern.agentId) {
    throw new Error(
      "watchCausalEvents: con un tenant activo el patrón debe fijar agentId; " +
        "un tail sin agente cruzaría eventos de otros inquilinos."
    )
  }
  const db = await getHiveDb()
  return db.events(pattern.agentId ? { ...pattern, agentId: causalAgentKey(pattern.agentId) } : pattern)
}

/** One-line human-readable summary of a causal event, keyed by its kindTag. */
export function formatCausalEvent(event: Event): string {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(event.payload)
  } catch {
    // Malformed payload — still print seq/kind/agent/stream below.
  }

  const streamShort = event.streamId.slice(0, 8)
  const header = `[${event.seq}] ${kindIcon(event.kindTag)} ${event.kindTag.padEnd(16)} agent=${unqualifyDocId(event.agentId)}  stream=${streamShort}…`

  switch (event.kindTag) {
    case "IntentLogged":
      return `${header}  "${truncate(String(payload.intent ?? ""), 120)}"`
    case "StateTransition":
      return `${header}  "${truncate(String(payload.description ?? ""), 120)}"`
    case "ToolCall": {
      const outcome = payload.outcome
      const outcomeStr =
        outcome === "Ok" ? "ok"
        : outcome === "Timeout" ? "TIMEOUT"
        : (outcome && typeof outcome === "object" && "Err" in (outcome as object))
          ? `ERR: ${(outcome as { Err: string }).Err}`
          : String(outcome)
      const latency = payload.latency_ms !== undefined ? `${payload.latency_ms}ms` : "?ms"
      return `${header}  tool=${payload.tool}  ${latency}  ${outcomeStr}`
    }
    default:
      return `${header}  ${truncate(JSON.stringify(payload), 120)}`
  }
}

function kindIcon(kindTag: string): string {
  switch (kindTag) {
    case "IntentLogged": return "🎯"
    case "StateTransition": return "🔀"
    case "ToolCall": return "🔧"
    case "LearningProposal": return "📄"
    default: return "•"
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s
}
