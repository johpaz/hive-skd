/**
 * Escrituras en segundo plano y fallos que no deben pasar en silencio.
 *
 *  - `flushTraces()` espera a las trazas y usos en vuelo: sin eso, cerrar la base
 *    justo después de un turno perdía la traza (`database is closed`).
 *  - `bestEffort()` sustituye al `try { … } catch { /* ignore DB errors *\/ }` que
 *    repetían los canales: el fallo no se propaga, pero queda en el log.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { col } from "../packages/core/src/storage/hive";
import { flushTraces, saveTrace } from "../packages/core/src/agent/tracer";
import { bestEffort } from "../packages/core/src/utils/best-effort";
import { flushPendingWrites, isClosedDatabase, trackWrite } from "../packages/core/src/utils/pending-writes";
import type { TraceDoc } from "../packages/core/src/storage/collections";

beforeAll(async () => { closeHiveDb(); await ensureHiveDb(); });
afterAll(() => closeHiveDb());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("flushPendingWrites", () => {
  test("espera a lo que está en vuelo", async () => {
    let done = false;
    trackWrite(sleep(30).then(() => { done = true; }));
    expect(done).toBe(false);
    await flushPendingWrites();
    expect(done).toBe(true);
  });

  test("un fallo no impide esperar al resto ni rompe el flush", async () => {
    let done = false;
    trackWrite(Promise.reject(new Error("falló")).catch(() => {}) as Promise<void>);
    trackWrite(sleep(20).then(() => { done = true; }));
    await flushPendingWrites();
    expect(done).toBe(true);
  });

  test("espera también lo que se registra mientras espera", async () => {
    let second = false;
    trackWrite(sleep(10).then(() => { trackWrite(sleep(20).then(() => { second = true; })); }));
    await flushPendingWrites();
    expect(second).toBe(true);
  });

  test("sin nada pendiente vuelve enseguida", async () => {
    await flushPendingWrites();
  });
});

describe("flushTraces", () => {
  test("la traza está escrita cuando el flush termina", async () => {
    const traces = await col<TraceDoc>("traces");
    const before = await traces.count();
    saveTrace({ threadId: "t-flush", agentId: "a", agentName: "A", inputSummary: "in", outputSummary: "out", success: true });
    await flushTraces();
    expect(await traces.count()).toBe(before + 1);
  });
});

describe("isClosedDatabase", () => {
  test("reconoce el error de base cerrada, venga como Error o como texto", () => {
    expect(isClosedDatabase(new Error("database is closed"))).toBe(true);
    expect(isClosedDatabase("Database is closed")).toBe(true);
    expect(isClosedDatabase(new Error("otra cosa"))).toBe(false);
  });
});

describe("bestEffort", () => {
  test("devuelve el valor si todo sale bien", async () => {
    expect(await bestEffort("x", async () => 42)).toBe(42);
  });

  test("un fallo no se propaga: devuelve undefined", async () => {
    expect(await bestEffort("x", async () => { throw new Error("boom"); })).toBeUndefined();
  });

  test("también cubre un fallo síncrono dentro de la función", async () => {
    expect(await bestEffort("x", () => { throw new Error("boom"); })).toBeUndefined();
  });
});
