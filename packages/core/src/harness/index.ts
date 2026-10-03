/**
 * Hive Harness — ejecución durable de tareas.
 *
 * Cola de jobs con retry/backoff, recuperación por lease tras un crash, envío
 * idempotente, verificación de objetivos y proof packets. Ver docs/HIVE-HARNESS.md.
 *
 * **Esto es un barrel, no una implementación.** Hasta 0.1.5 `harness/` tenía su
 * propia copia de `db-helpers`, `boot-id`, `reconcile`, `collections`, `run-store`,
 * `run-epoch` y `proof-packet`, en paralelo con las de `storage/` y `agent/`. Dos
 * almacenes de jobs sobre las mismas colecciones de HiveDB son una sola cosa con
 * dos estados posibles, así que ahora esto re-exporta la implementación única y el
 * subpath `@johpaz/hive-sdk/harness` sigue funcionando igual.
 *
 * La app decide qué significa "durable" para sus tipos de job. Para los dos
 * casos que necesita cualquier enjambre —ejecutar un worker delegado y
 * perseguir un objetivo— hay ejecutores listos: `initHarnessExecutors()`. Para
 * el resto, `registerExecutor()`.
 */

import { ensureHiveDb } from "../storage/bootstrap";

// ─── Ejecutores listos para usar ─────────────────────────────────────────────
// La cola sabe encolar, reintentar y recuperar; estos son los que saben hacer
// el trabajo. Ver executors.ts para por qué `chat_turn` no está entre ellos.
export {
  initHarnessExecutors,
  setHarnessExecutorMCPManager,
} from "./executors";

// ─── Cola y almacén de jobs ──────────────────────────────────────────────────
export * from "../gateway/job-store";
export * from "../gateway/durable-queue";

// ─── Runs: checkpoint, lease, epoch, proof ───────────────────────────────────
export * from "../agent/run-store";
export * from "../agent/run-epoch";
export * from "../agent/proof-packet";

// ─── Verificación de objetivos ───────────────────────────────────────────────
export { runGoal, verifyGoal, interpretCheckResult } from "../agent/goal-runner";
export type { AcceptanceResult, GoalRunOptions, GoalRunResult } from "../agent/goal-runner";

// ─── Durabilidad entre arranques ─────────────────────────────────────────────
export { getBootId, resetBootId } from "../storage/boot-id";
export { reconcileOnBoot } from "../storage/reconcile";
export type { ReconcileResult } from "../storage/reconcile";

// ─── Shapes ──────────────────────────────────────────────────────────────────
export type { JobDoc, AgentRunDoc, ProofPacketDoc } from "../storage/collections";

// ─── Primitivas de colección ─────────────────────────────────────────────────
export { col, nextId, updateDoc, findByAny, toIndexable, fromIndexable, NO_PARENT } from "../storage/hive";

/**
 * Crea los índices que necesitan las colecciones del harness.
 *
 * Los índices ahora se declaran en un solo lugar (`INDEXES` en storage/bootstrap.ts)
 * y los crea `ensureHiveDb()`. Se mantiene la función porque era pública; es
 * idempotente y llamarla en cada arranque sigue siendo seguro.
 */
export async function ensureHarnessIndexes(): Promise<void> {
  await ensureHiveDb();
}
