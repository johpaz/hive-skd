/**
 * Ámbitos del índice de capacidades.
 *
 * El índice BM25 es UNO solo para todos los inquilinos —no hay colección que
 * prefijar— así que el ámbito viaja como filtro. Lo que se fija acá son las tres
 * consecuencias de eso, que antes estaban rotas:
 *
 *  1. desde un enjambre se encuentra el catálogo compartido, que se indexa una
 *     sola vez y sin inquilino;
 *  2. lo que indexa un enjambre no lo ve otro;
 *  3. reindexar el catálogo —lo que hace el gateway en cada arranque— no borra
 *     lo que los inquilinos tenían indexado.
 *
 * Y encima de todo eso manda la elección: una tool que el inquilino apagó no se
 * le ofrece, aunque esté en el catálogo y puntúe primero.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeHiveDb, getHiveDb } from "../storage/hivedb";
import { ensureHiveDb } from "../storage/bootstrap";
import { runInTenant } from "../storage/tenant";
import { setCatalogActivation } from "../storage/catalog";
import { replaceCapabilityDocs, upsertCapabilityDocs, searchCapabilities } from "./capability-search";
import type { CapabilityDoc } from "./capability-search";

const A = "t_aaaaaaaa";
const B = "t_bbbbbbbb";

const DEL_CATALOGO: CapabilityDoc = {
  type: "tool",
  rawId: "buscador_lunar",
  name: "buscador_lunar",
  tags: "astronomia",
  body: "busca cráteres en la superficie de la luna",
};

const DEL_INQUILINO: CapabilityDoc = {
  type: "tool",
  rawId: "endpoint_privado_a",
  name: "endpoint_privado_a",
  tags: "api",
  body: "consulta la facturación del cliente",
};

const encontradas = (hits: Awaited<ReturnType<typeof searchCapabilities>>) => hits.map((h) => h.rawId);

beforeEach(async () => {
  closeHiveDb();
  await ensureHiveDb();
});

afterEach(() => {
  closeHiveDb();
});

describe("ámbitos del índice de capacidades", () => {
  it("el catálogo se indexa una vez y se encuentra desde dentro de un enjambre", async () => {
    // Sin inquilino: es lo que hace el gateway al arrancar.
    await replaceCapabilityDocs("tool", [DEL_CATALOGO]);

    const desdeA = await runInTenant(A, () => searchCapabilities("cráteres de la luna", { types: ["tool"] }));

    expect(encontradas(desdeA)).toContain("buscador_lunar");
  });

  it("lo que indexa un enjambre no lo ve el otro", async () => {
    await runInTenant(A, () => upsertCapabilityDocs([DEL_INQUILINO]));

    const desdeA = await runInTenant(A, () => searchCapabilities("facturación del cliente", { types: ["tool"] }));
    const desdeB = await runInTenant(B, () => searchCapabilities("facturación del cliente", { types: ["tool"] }));

    expect(encontradas(desdeA)).toContain("endpoint_privado_a");
    expect(encontradas(desdeB)).not.toContain("endpoint_privado_a");
  });

  it("reindexar el catálogo no borra lo que los inquilinos tenían indexado", async () => {
    await runInTenant(A, () => upsertCapabilityDocs([DEL_INQUILINO]));

    // El arranque del gateway vuelve a publicar el catálogo, sin inquilino.
    await replaceCapabilityDocs("tool", [DEL_CATALOGO]);

    const desdeA = await runInTenant(A, () => searchCapabilities("facturación del cliente", { types: ["tool"] }));

    expect(encontradas(desdeA)).toContain("endpoint_privado_a");
  });

  it("una tool que el inquilino apagó no se le ofrece", async () => {
    await replaceCapabilityDocs("tool", [DEL_CATALOGO]);

    const desdeA = await runInTenant(A, async () => {
      await setCatalogActivation("tools", "buscador_lunar", { active: false });
      return searchCapabilities("cráteres de la luna", { types: ["tool"] });
    });
    const desdeB = await runInTenant(B, () => searchCapabilities("cráteres de la luna", { types: ["tool"] }));

    expect(encontradas(desdeA)).not.toContain("buscador_lunar");
    // La elección es de A y de nadie más.
    expect(encontradas(desdeB)).toContain("buscador_lunar");
  });

  it("sin inquilino la búsqueda sigue encontrando el catálogo", async () => {
    await replaceCapabilityDocs("tool", [DEL_CATALOGO]);

    expect(encontradas(await searchCapabilities("cráteres de la luna", { types: ["tool"] })))
      .toContain("buscador_lunar");
  });
});

describe("sync incremental del índice de capacidades", () => {
  const OTRA: CapabilityDoc = {
    type: "tool",
    rawId: "traductor_marino",
    name: "traductor_marino",
    body: "Traduce el canto de las ballenas",
    tags: "ballenas océano",
  };

  it("un segundo sync idéntico no reescribe el índice", async () => {
    await replaceCapabilityDocs("tool", [DEL_CATALOGO, OTRA]);
    const db = await getHiveDb();
    const original = db.upsertBatch.bind(db);
    let escritos = 0;
    db.upsertBatch = async (docs) => {
      escritos += docs.length;
      return original(docs);
    };

    await replaceCapabilityDocs("tool", [DEL_CATALOGO, OTRA]);

    expect(escritos).toBe(0);
    expect(encontradas(await searchCapabilities("cráteres de la luna", { types: ["tool"] })))
      .toContain("buscador_lunar");
  });

  it("solo reescribe lo que cambió y borra lo que desapareció", async () => {
    await replaceCapabilityDocs("tool", [DEL_CATALOGO, OTRA]);

    const editada = { ...DEL_CATALOGO, body: "Explora volcanes submarinos" };
    await replaceCapabilityDocs("tool", [editada]);

    expect(encontradas(await searchCapabilities("volcanes submarinos", { types: ["tool"] })))
      .toContain("buscador_lunar");
    expect(encontradas(await searchCapabilities("cráteres", { types: ["tool"] })))
      .not.toContain("buscador_lunar");
    expect(encontradas(await searchCapabilities("ballenas", { types: ["tool"] })))
      .not.toContain("traductor_marino");
  });

  it("tras un upsert suelto el replace sigue limpiando el tipo del ámbito", async () => {
    await replaceCapabilityDocs("tool", [DEL_CATALOGO]);
    await upsertCapabilityDocs([OTRA]);

    await replaceCapabilityDocs("tool", [DEL_CATALOGO]);

    expect(encontradas(await searchCapabilities("ballenas", { types: ["tool"] })))
      .not.toContain("traductor_marino");
  });
});
