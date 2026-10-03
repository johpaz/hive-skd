/**
 * Catálogo compartido y activación por inquilino.
 *
 * Lo que se fija acá es la promesa entera de storage/catalog.ts: el contenido
 * del catálogo se instala UNA vez y ningún enjambre escribe una copia, pero cada
 * uno decide qué tiene encendido y lo que crea sigue siendo suyo.
 *
 * Las tres cosas se miden contra la partición física del inquilino
 * (`t_xxx__tools`), no contra la vista: es la única forma de distinguir "lo ve"
 * de "tiene una copia", que es justo la diferencia que este módulo introduce.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeHiveDb, getHiveDb } from "./hivedb";
import { ensureHiveDb } from "./bootstrap";
import { col } from "./hive";
import { runInTenant } from "./tenant";
import { setCatalogActivation, listCatalogActivations } from "./catalog";
import type { ToolDoc } from "./collections";

const A = "t_aaaaaaaa";
const B = "t_bbbbbbbb";

/** Filas que el inquilino escribió en SU partición. Cero es el objetivo. */
async function filasPropias(tenant: string, coleccion: string): Promise<number> {
  const db = await getHiveDb();
  return db.collection(`${tenant}__${coleccion}`).count();
}

/** Una tool cualquiera del catálogo, leída fuera de todo inquilino. */
async function unaDelCatalogo(): Promise<{ id: string; doc: ToolDoc }> {
  const entradas = await (await col<ToolDoc>("tools")).scan({ limit: 1 });
  return { id: entradas[0].id, doc: entradas[0].doc };
}

beforeEach(async () => {
  closeHiveDb();
  // Sin inquilino: esto es el "instalar una vez" — siembra el catálogo en las
  // colecciones sin prefijo, que es lo que después ven todos.
  await ensureHiveDb();
});

afterEach(() => {
  closeHiveDb();
});

describe("catálogo compartido", () => {
  it("los inquilinos ven el catálogo entero sin copiarlo", async () => {
    const enElCatalogo = await (await col<ToolDoc>("tools")).count();
    expect(enElCatalogo).toBeGreaterThan(0);

    const visto = await runInTenant(A, async () =>
      (await (await col<ToolDoc>("tools")).scan({})).length,
    );

    expect(visto).toBe(enElCatalogo);
    expect(await filasPropias(A, "tools")).toBe(0);
  });

  it("sembrar dentro de un inquilino no escribe una copia del catálogo", async () => {
    await runInTenant(A, async () => {
      await ensureHiveDb({ specialists: "none" });
    });

    for (const coleccion of ["tools", "skills", "ethics", "models", "providers"]) {
      expect(await filasPropias(A, coleccion)).toBe(0);
    }
  });

  it("encender una tool en un inquilino no toca al catálogo ni al vecino", async () => {
    const { id, doc } = await unaDelCatalogo();
    const opuesto = !doc.active;

    await runInTenant(A, async () => {
      const tools = await col<ToolDoc>("tools");
      const entrada = await tools.get(id);
      await tools.put(id, { ...entrada!.doc, active: opuesto }, { expectedVersion: entrada!.version });
    });

    const enA = await runInTenant(A, async () => (await (await col<ToolDoc>("tools")).get(id))!.doc.active);
    const enB = await runInTenant(B, async () => (await (await col<ToolDoc>("tools")).get(id))!.doc.active);
    const enElCatalogo = (await (await col<ToolDoc>("tools")).get(id))!.doc.active;

    expect(enA).toBe(opuesto);
    expect(enB).toBe(doc.active);
    expect(enElCatalogo).toBe(doc.active);

    // La elección se guardó como elección, no como una copia de la fila.
    expect(await filasPropias(A, "tools")).toBe(0);
    expect(await filasPropias(A, "catalogActivations")).toBe(1);
  });

  it("setCatalogActivation deja la misma huella que el toggle", async () => {
    const { id } = await unaDelCatalogo();

    await runInTenant(A, async () => {
      await setCatalogActivation("tools", id, { active: true });
      const elegidas = await listCatalogActivations("tools");
      expect(elegidas).toEqual([{ itemId: id, active: true, enabled: true, hidden: false }]);
    });

    expect(await filasPropias(A, "tools")).toBe(0);
    expect(await runInTenant(B, async () => (await listCatalogActivations("tools")).length)).toBe(0);
  });

  it("lo que el inquilino crea es suyo y no se filtra", async () => {
    const ahora = Date.now();
    const propia: ToolDoc = {
      id: "api_probe", name: "api_probe", description: "tool de un endpoint del inquilino",
      category: "api", enabled: true, active: true, created_at: ahora, updated_at: ahora,
    };

    await runInTenant(A, async () => {
      await (await col<ToolDoc>("tools")).put("api_probe", propia, { expectedVersion: 0 });
    });

    expect(await runInTenant(A, async () => (await (await col<ToolDoc>("tools")).get("api_probe"))?.doc.name))
      .toBe("api_probe");
    expect(await runInTenant(B, async () => (await (await col<ToolDoc>("tools")).get("api_probe"))))
      .toBeUndefined();
    // Y tampoco cayó en el catálogo, que es de todos.
    expect(await (await col<ToolDoc>("tools")).get("api_probe")).toBeUndefined();
    expect(await filasPropias(A, "tools")).toBe(1);
  });

  it("borrar una fila del catálogo la oculta sólo para ese inquilino", async () => {
    const { id } = await unaDelCatalogo();

    expect(await runInTenant(A, async () => (await col<ToolDoc>("tools")).delete(id))).toBe(true);

    expect(await runInTenant(A, async () => (await (await col<ToolDoc>("tools")).get(id)))).toBeUndefined();
    expect(await runInTenant(A, async () =>
      (await (await col<ToolDoc>("tools")).scan({})).some((e) => e.id === id),
    )).toBe(false);

    expect(await runInTenant(B, async () => (await (await col<ToolDoc>("tools")).get(id))?.id)).toBe(id);
    expect((await (await col<ToolDoc>("tools")).get(id))?.id).toBe(id);
  });

  it("editar el contenido de una fila del catálogo se queda en el inquilino", async () => {
    const { id, doc } = await unaDelCatalogo();

    await runInTenant(A, async () => {
      const tools = await col<ToolDoc>("tools");
      const entrada = await tools.get(id);
      await tools.put(id, { ...entrada!.doc, description: "descripción propia de A" },
        { expectedVersion: entrada!.version });
    });

    expect(await runInTenant(A, async () => (await (await col<ToolDoc>("tools")).get(id))!.doc.description))
      .toBe("descripción propia de A");
    expect(await runInTenant(B, async () => (await (await col<ToolDoc>("tools")).get(id))!.doc.description))
      .toBe(doc.description);
    expect((await (await col<ToolDoc>("tools")).get(id))!.doc.description).toBe(doc.description);
    // Acá sí hay copia, y es correcto: el inquilino cambió el CONTENIDO.
    expect(await filasPropias(A, "tools")).toBe(1);
  });
});
