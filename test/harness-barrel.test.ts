/**
 * `harness/` pasó de tener implementación propia a ser un barrel.
 *
 * Hasta 0.1.5 el módulo traía sus propias copias de `db-helpers`, `boot-id`,
 * `reconcile`, `collections`, `run-store`, `run-epoch` y `proof-packet`, en
 * paralelo con las de `storage/` y `agent/`. Dos almacenes de jobs sobre las
 * mismas colecciones de HiveDB son una sola cosa con dos estados posibles.
 *
 * Lo que este test protege no es el comportamiento (eso lo cubren
 * job-store/durable-queue/run-store.test.ts) sino el contrato del subpath
 * `@johpaz/hive-sdk/harness`: que siga exportando los mismos nombres y que
 * apunten a la implementación única.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, test, expect } from "bun:test";
import * as harness from "../packages/core/src/harness/index.ts";
import { createJob } from "../packages/core/src/gateway/job-store.ts";
import { createRun } from "../packages/core/src/agent/run-store.ts";
import { col } from "../packages/core/src/storage/hive.ts";

describe("subpath @johpaz/hive-sdk/harness", () => {
  test("sigue exportando la superficie que tenía", () => {
    for (const name of [
      "createJob",
      "getJob",
      "registerExecutor",
      "getDurableQueue",
      "initDurableQueue",
      "DurableLaneQueue",
      "createRun",
      "checkpoint",
      "completeRun",
      "failRun",
      "interruptRun",
      "reclaimRun",
      "getRun",
      "buildRunEpoch",
      "buildProofPacket",
      "verifyGoal",
      "getBootId",
      "resetBootId",
      "reconcileOnBoot",
      "ensureHarnessIndexes",
      "col",
      "nextId",
      "updateDoc",
      "findByAny",
      "toIndexable",
      "fromIndexable",
      "NO_PARENT",
    ]) {
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: el test recorre los nombres del contrato a propósito.
    expect(harness[name as keyof typeof harness], `falta el export ${name}`).toBeDefined();
    }
  });

  test("re-exporta la misma función, no una copia", () => {
    // Si esto falla es que harness/ volvió a tener implementación propia.
    expect(harness.createJob).toBe(createJob);
    expect(harness.createRun).toBe(createRun);
    expect(harness.col).toBe(col);
  });
});
