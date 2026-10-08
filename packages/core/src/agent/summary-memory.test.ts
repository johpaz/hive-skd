/**
 * Memoria entre hilos: los resúmenes se indexan por hilo y se recuperan desde
 * otros hilos del mismo inquilino, nunca desde otro inquilino ni desde el propio.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeHiveDb } from "../storage/hivedb";
import { ensureHiveDb } from "../storage/bootstrap";
import { runInTenant } from "../storage/tenant";
import { saveSummary } from "./conversation-store";
import { indexThreadSummary, removeThreadSummary, searchRelatedSummaries } from "./summary-memory";
import { searchCapabilities } from "./capability-search";

const A = "t_aaaaaaaa";
const B = "t_bbbbbbbb";

async function resumir(threadId: string, texto: string) {
  await saveSummary(threadId, texto, 5, 10);
  await indexThreadSummary(threadId, texto);
}

beforeEach(async () => {
  closeHiveDb();
  await ensureHiveDb();
});

afterEach(() => {
  closeHiveDb();
});

describe("memoria entre hilos", () => {
  it("encuentra el resumen de otro hilo y descarta el del hilo actual", async () => {
    await resumir("hilo-1", "El cliente pidió migrar la facturación electrónica a Alegra");
    await resumir("hilo-2", "Se habló de la facturación electrónica y los impuestos");

    const r = await searchRelatedSummaries("facturación electrónica", "hilo-2");

    expect(r.map((x) => x.threadId)).toEqual(["hilo-1"]);
    expect(r[0]!.summary).toContain("Alegra");
  });

  it("un resumen actualizado reemplaza al anterior del mismo hilo", async () => {
    await resumir("hilo-1", "Plan de viaje a Japón en primavera");
    await resumir("hilo-1", "Presupuesto del servidor de producción");

    expect(await searchRelatedSummaries("Japón", "otro")).toEqual([]);
    expect((await searchRelatedSummaries("servidor", "otro")).map((x) => x.threadId)).toEqual(["hilo-1"]);
  });

  it("no cruza inquilinos", async () => {
    await runInTenant(A, () => resumir("hilo-a", "Contrato confidencial con el proveedor de acero"));

    const desdeB = await runInTenant(B, () => searchRelatedSummaries("proveedor de acero", "x"));
    const desdeA = await runInTenant(A, () => searchRelatedSummaries("proveedor de acero", "x"));

    expect(desdeB).toEqual([]);
    expect(desdeA.map((x) => x.threadId)).toEqual(["hilo-a"]);
  });

  it("borrar el hilo lo quita del índice", async () => {
    await resumir("hilo-1", "Receta de empanadas de pipián");
    await removeThreadSummary("hilo-1");

    expect(await searchRelatedSummaries("empanadas", "otro")).toEqual([]);
  });

  it("no contamina la búsqueda de capacidades", async () => {
    await resumir("hilo-1", "Receta de empanadas de pipián");

    expect(await searchCapabilities("empanadas pipián", { types: ["tool", "skill"] })).toEqual([]);
  });
});
