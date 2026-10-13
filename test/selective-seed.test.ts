/**
 * Seed selectivo: elegir qué especialistas se instalan y qué se enciende.
 *
 * Lo que estos tests fijan es que **el usuario decide**: planificar la activación
 * no cambia nada, y el seed inicial instala sólo lo que se pidió.
 *
 * Uses HIVE_DB_PATH=":memory:" so no state persists between runs.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { col } from "../packages/core/src/storage/hive";
import type { AgentDoc, ToolDoc, SkillDoc } from "../packages/core/src/storage/collections";
import * as setup from "../packages/core/src/services/setup";
import { MINIMAL_TOOLS } from "../packages/core/src/agent/minimal-loadout";

const habilitado = async (id: string) =>
  !!(await (await col<AgentDoc>("agents")).get(id))?.doc.enabled;
const toolActiva = async (n: string) =>
  !!(await (await col<ToolDoc>("tools")).get(n))?.doc.active;

beforeEach(async () => {
  closeHiveDb();
  await ensureHiveDb();
});
afterEach(() => closeHiveDb());

const cuenta = async () => ({
  agentes: (await (await col<AgentDoc>("agents")).scan({})).filter((e) => e.doc.source === "catalog").length,
  toolsActivas: (await (await col<ToolDoc>("tools")).scan({})).filter((e) => e.doc.active).length,
  toolsTotal: (await (await col<ToolDoc>("tools")).scan({})).length,
  skillsActivas: (await (await col<SkillDoc>("skills")).scan({})).filter((e) => e.doc.active).length,
});

describe("planActivationFor: qué se encendería, sin encender", () => {
  test("informa el faltante y no toca nada", async () => {
    await setup.applySeedPlan(["web_researcher"]);

    const gap = await setup.planActivationFor(["software_engineer"]);

    expect(gap.agents).toEqual(["software_engineer"]);
    expect(gap.tools.length).toBeGreaterThan(0);
    // Es un plan, no una acción: si encendiera algo, la UI no podría preguntar
    // antes de confirmar.
    expect(await habilitado("software_engineer")).toBe(false);
  });

  test("un especialista ya activo no tiene faltante", async () => {
    await setup.applySeedPlan(["web_researcher"]);
    const gap = await setup.planActivationFor(["web_researcher"]);
    expect(gap).toEqual({ agents: [], tools: [], skills: [], nonCatalog: [] });
  });

  test("no promete encender lo que ya está encendido por otro", async () => {
    // `web_fetch` la comparten web_researcher y browser_operator. Con el
    // primero activo, agregar el segundo no la "va a activar": ya lo está.
    await setup.applySeedPlan(["web_researcher"]);
    expect(await toolActiva("web_fetch")).toBe(true);

    const gap = await setup.planActivationFor(["browser_operator"]);
    expect(gap.agents).toEqual(["browser_operator"]);
    expect(gap.tools).not.toContain("web_fetch");
  });

  test("los agentes que no son del catálogo se separan, no se rechazan", async () => {
    // Un agente creado por el usuario trae sus propias tools: no se siembra
    // desde el catálogo, pero tampoco puede hacer fallar el plan.
    const gap = await setup.planActivationFor(["web_researcher", "mi_agente_propio"]);
    expect(gap.nonCatalog).toEqual(["mi_agente_propio"]);
  });
});

describe("seed inicial: elegir qué especialistas se instalan", () => {
  test('"none" deja la colmena vacía, con las mínimas prendidas', async () => {
    closeHiveDb();
    await ensureHiveDb({ specialists: "none" });

    const c = await cuenta();
    expect(c.agentes).toBe(0);
    expect(c.skillsActivas).toBe(0);
    // Las MINIMAL_TOOLS quedan activas igual: son la competencia del
    // coordinador —delegar, buscar, avisar— y sin ellas no hay colmena a la que
    // agregarle especialistas después.
    expect(c.toolsActivas).toBe(MINIMAL_TOOLS.size);
    // Las filas existen todas, apagadas: activarlas después no requiere volver
    // a sembrar desde el código.
    expect(c.toolsTotal).toBeGreaterThan(c.toolsActivas);
  });

  test('"all" es el default y no cambió', async () => {
    closeHiveDb();
    await ensureHiveDb();   // sin opciones
    const c = await cuenta();
    expect(c.agentes).toBe(8);
    expect(c.toolsActivas).toBe(c.toolsTotal);
  });

  test("una lista instala sólo esos y sus capacidades", async () => {
    closeHiveDb();
    await ensureHiveDb({ specialists: ["web_researcher"] });

    expect(await habilitado("web_researcher")).toBe(true);
    expect(await toolActiva("web_search")).toBe(true);
    expect(await toolActiva("cli_exec")).toBe(false);
    expect((await cuenta()).agentes).toBe(1);
  });

  test("cambiar a `none` NO borra los especialistas que ya estaban", async () => {
    // La garantía que hace seguro cambiar de modo: la elección gobierna qué se
    // CREA, nunca qué se conserva. Sin esto, un host que pruebe `none` perdería
    // los ocho agentes de una instalación en uso.
    expect((await cuenta()).agentes).toBe(8);   // el beforeEach sembró todo

    await ensureHiveDb({ specialists: "none" });

    expect((await cuenta()).agentes).toBe(8);
    expect(await habilitado("software_engineer")).toBe(true);
  });
});
