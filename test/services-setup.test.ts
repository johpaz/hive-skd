/**
 * Seed selectivo: el usuario elige qué agentes quiere.
 *
 * El error obvio sería sembrar "sólo lo de este agente". No sirve, porque **las
 * tools se comparten**: `web_fetch` lo declaran el investigador web y el
 * operador de navegador, y `fs_*` lo declaran el operador de archivos y el
 * ingeniero de software. Estos tests fijan que se siembre la unión, que las
 * mínimas del coordinador estén siempre, y —lo más importante— que desactivar
 * un agente no deje sin capacidades a otro que las compartía.
 *
 * Uses HIVE_DB_PATH=":memory:" so no state persists between runs.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { col } from "../packages/core/src/storage/hive";
import type { AgentDoc, ToolDoc } from "../packages/core/src/storage/collections";
import * as setup from "../packages/core/src/services/setup";
import { MINIMAL_TOOLS } from "../packages/core/src/agent/minimal-loadout";
import { seedAllData } from "../packages/core/src/storage/seed";

async function toolActiva(name: string): Promise<boolean> {
  const e = await (await col<ToolDoc>("tools")).get(name);
  return !!e?.doc.active;
}

async function agenteHabilitado(id: string): Promise<boolean> {
  const e = await (await col<AgentDoc>("agents")).get(id);
  return !!e?.doc.enabled;
}

beforeEach(async () => {
  closeHiveDb();
  await ensureHiveDb();
});

afterEach(() => {
  closeHiveDb();
});

describe("planSeedFor: la unión, no la suma", () => {
  test("una tool compartida aparece una sola vez", () => {
    const plan = setup.planSeedFor(["web_researcher", "browser_operator"]);
    expect(plan.tools.filter((t) => t === "web_fetch")).toHaveLength(1);
  });

  test("incluye siempre las tools mínimas del coordinador", () => {
    // Sin ellas no hay colmena: son delegar, buscar y avisar.
    const plan = setup.planSeedFor(["web_researcher"]);
    for (const t of MINIMAL_TOOLS) expect(plan.tools).toContain(t);
  });

  test("expande los globs: `fs_*` no es una tool, son varias", () => {
    const plan = setup.planSeedFor(["workspace_file_operator"]);
    expect(plan.tools).not.toContain("fs_*");
    expect(plan.tools.filter((t) => t.startsWith("fs_")).length).toBeGreaterThan(1);
  });

  test("un agente que no está en el catálogo se rechaza", () => {
    expect(() => setup.planSeedFor(["no_existe"])).toThrow(/No existen en el catálogo/);
  });

  test("elegir cero agentes deja igual las mínimas", () => {
    const plan = setup.planSeedFor([]);
    expect(plan.agents).toHaveLength(0);
    for (const t of MINIMAL_TOOLS) expect(plan.tools).toContain(t);
  });
});

describe("applySeedPlan: sembrar sólo lo elegido", () => {
  test("sólo quedan habilitados los elegidos", async () => {
    await setup.applySeedPlan(["web_researcher"]);

    expect(await agenteHabilitado("web_researcher")).toBe(true);
    // El arranque siembra las 8 personas; lo que la selección controla es
    // cuáles quedan habilitadas, no si la fila existe.
    expect(await agenteHabilitado("software_engineer")).toBe(false);
  });

  test("las tools que no hacen falta quedan inactivas, no borradas", async () => {
    await setup.applySeedPlan(["web_researcher"]);

    expect(await toolActiva("web_fetch")).toBe(true);
    // Una fila borrada habría que volver a sembrarla desde el código.
    const cliExec = await (await col<ToolDoc>("tools")).get("cli_exec");
    expect(cliExec).toBeDefined();
    expect(cliExec?.doc.active).toBe(false);
  });

  test("las mínimas quedan activas aunque no las pida ningún agente", async () => {
    await setup.applySeedPlan(["web_researcher"]);
    for (const t of MINIMAL_TOOLS) expect(await toolActiva(t)).toBe(true);
  });
  test("la selección sobrevive al reseed de cada arranque", async () => {
    await setup.applySeedPlan(["web_researcher"]);
    expect(await toolActiva("cli_exec")).toBe(false);

    // `seedAllData()` corre en CADA arranque y reescribe las filas de tools y
    // skills desde el código. Si pisara `active`, el seed selectivo duraría
    // hasta el próximo reinicio y el usuario vería volver todo lo que apagó.
    // (Con HIVE_DB_PATH=":memory:" no se puede cerrar y reabrir la base sin
    // perderla, así que se invoca el reseed sobre la misma.)
    await seedAllData();

    expect(await toolActiva("cli_exec")).toBe(false);
    expect(await toolActiva("web_search")).toBe(true);
    expect(await agenteHabilitado("software_engineer")).toBe(false);
  });
});

describe("activar y desactivar sin romper a los demás", () => {
  test("desactivar un agente NO apaga la tool que comparte con otro", async () => {
    await setup.applySeedPlan(["web_researcher", "browser_operator"]);
    expect(await toolActiva("web_fetch")).toBe(true);

    await setup.disableCatalogAgent("web_researcher");

    // Es la trampa entera del seed selectivo: browser_operator sigue activo y
    // sigue necesitando web_fetch.
    expect(await agenteHabilitado("web_researcher")).toBe(false);
    expect(await agenteHabilitado("browser_operator")).toBe(true);
    expect(await toolActiva("web_fetch")).toBe(true);
  });

  test("desactivar el último que la usaba sí la apaga", async () => {
    await setup.applySeedPlan(["web_researcher"]);
    expect(await toolActiva("web_search")).toBe(true);

    await setup.disableCatalogAgent("web_researcher");
    expect(await toolActiva("web_search")).toBe(false);
  });

  test("activar un agente siembra lo que le falta sin apagar lo de otros", async () => {
    await setup.applySeedPlan(["web_researcher"]);
    expect(await toolActiva("web_search")).toBe(true);

    await setup.enableCatalogAgent("workspace_file_operator");

    expect(await toolActiva("web_search")).toBe(true);   // lo del primero sigue
    const fs = (await (await col<ToolDoc>("tools")).scan({}))
      .filter((e) => e.doc.name.startsWith("fs_") && e.doc.active);
    expect(fs.length).toBeGreaterThan(0);                 // y llegó lo del segundo
  });

  test("listEnabledCatalogAgents refleja lo aplicado", async () => {
    await setup.applySeedPlan(["web_researcher", "browser_operator"]);
    const activos = await setup.listEnabledCatalogAgents();
    expect(activos.sort()).toEqual(["browser_operator", "web_researcher"]);
  });
});

describe("catálogo para la UI", () => {
  test("expone las personas con lo que cada una requiere", () => {
    const personas = setup.listCatalogPersonas();
    expect(personas).toHaveLength(11);

    const web = personas.find((p) => p.id === "web_researcher");
    expect(web?.tools).toContain("web_search");
    expect(web?.name).toBeTruthy();
  });
});
