/**
 * Aislamiento del playbook ACE entre usuarios.
 *
 * El playbook es lo que el agente APRENDE de interactuar con la gente, y se
 * inyecta en el system prompt de cada turno. Sin `user_id` la cadena entera era
 * global: lo observado hablando con una persona salía como regla y se le
 * aplicaba a todas las demás en el mismo proceso — el mismo supuesto de "un
 * solo usuario" que ya se cerró en `memory`.
 *
 * Estos tests recorren la cadena completa: trazas → reflexión → regla →
 * selección. Lo sembrado (`user_id: ""`) es la excepción a propósito: es
 * conocimiento del producto y le toca a todos.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { resetBootId } from "../packages/core/src/storage/boot-id";
import { col, nextId, toIndexable } from "../packages/core/src/storage/hive";
import type { TraceDoc, ReflectionDoc, PlaybookDoc } from "../packages/core/src/storage/collections";
import { runReflector } from "../packages/core/src/agent/reflector";
import { selectPlaybookRules, syncPlaybookToIndex } from "../packages/core/src/agent/playbook-selector";
import { makeThreadId } from "../packages/core/src/agent/thread-id";
import { searchKnowledgeTool } from "../packages/core/src/tools/core";
import { EthicsGuard } from "../packages/core/src/ethics/EthicsGuard";

const ANA = "user-ana";
const BETO = "user-beto";

async function seedTrace(userId: string, overrides: Partial<TraceDoc> = {}) {
  const tracesCol = await col<TraceDoc>("traces");
  const id = await nextId("traces");
  await tracesCol.put(id, {
    id,
    thread_id: makeThreadId(userId, "webchat", "peer"),
    agent_id: "agent-1",
    agent_name: "Agent 1",
    tool_used: null,
    input_summary: "input",
    output_summary: "output",
    success: true,
    error_message: null,
    duration_ms: null,
    tokens_used: null,
    created_at: Date.now(),
    ...overrides,
  });
  return id;
}

async function addRule(rule: string, userId: string) {
  const playbookCol = await col<PlaybookDoc>("playbook");
  const id = await nextId("playbook");
  const now = Date.now();
  await playbookCol.put(id, {
    id,
    rule,
    category: "tool_selection",
    user_id: userId,
    applicable_to: null,
    helpful_count: 1,
    harmful_count: 0,
    active: true,
    source_reflection_id: toIndexable(null),
    created_at: now,
    updated_at: now,
  });
  return id;
}

beforeEach(async () => {
  closeHiveDb();
  resetBootId();
  await ensureHiveDb();
});

afterEach(() => {
  closeHiveDb();
});

describe("selección: cada quien ve lo suyo", () => {
  test("una regla aprendida de Ana no llega al prompt de Beto", async () => {
    await addRule("Al exportar el reporte mensual usar siempre el formato xlsx", ANA);
    await syncPlaybookToIndex();

    const paraAna = await selectPlaybookRules("exportar el reporte mensual", ANA);
    const paraBeto = await selectPlaybookRules("exportar el reporte mensual", BETO);

    // La contraprueba importa tanto como la prueba: si Ana tampoco la viera,
    // el test pasaría por estar rota la búsqueda y no por el aislamiento.
    expect(paraAna.map((r) => r.rule)).toContain(
      "Al exportar el reporte mensual usar siempre el formato xlsx",
    );
    expect(paraBeto).toHaveLength(0);
  });

  test("lo sembrado es global: lo ven todos", async () => {
    await addRule("Verificar el resultado antes de reportarlo como hecho", "");
    await syncPlaybookToIndex();

    const paraBeto = await selectPlaybookRules("verificar el resultado antes de reportarlo", BETO);
    expect(paraBeto.map((r) => r.rule)).toContain(
      "Verificar el resultado antes de reportarlo como hecho",
    );
  });

  test("las reglas de otro no desplazan a las propias en el ranking", async () => {
    // El índice BM25 es único para todo el proceso. Si se pidieran k candidatos
    // y se filtrara después, las 8 reglas de Ana —todas muy relevantes— dejarían
    // a Beto sin ninguna, aunque la suya coincida igual de bien.
    for (let i = 0; i < 8; i++) {
      await addRule(`Ana ${i}: al migrar la base de datos hacer respaldo previo`, ANA);
    }
    await addRule("Beto: al migrar la base de datos hacer respaldo previo", BETO);
    await syncPlaybookToIndex();

    const paraBeto = await selectPlaybookRules("al migrar la base de datos", BETO);
    expect(paraBeto.length).toBeGreaterThan(0);
    expect(paraBeto.every((r) => !r.rule.startsWith("Ana "))).toBe(true);
  });

  test("sin userId sólo salen las globales", async () => {
    await addRule("Regla privada de Ana sobre facturación electrónica", ANA);
    await addRule("Regla global sobre facturación electrónica", "");
    await syncPlaybookToIndex();

    const reglas = await selectPlaybookRules("facturación electrónica");
    expect(reglas.map((r) => r.rule)).toEqual(["Regla global sobre facturación electrónica"]);
  });
});

describe("cadena completa: trazas → reflexión → regla", () => {
  test("el reflector separa las trazas por usuario", async () => {
    for (let i = 0; i < 4; i++) await seedTrace(ANA, { tool_used: "flaky_tool", success: false });
    for (let i = 0; i < 6; i++) await seedTrace(BETO, { tool_used: "ok_tool", success: true });

    await runReflector();

    const reflexiones = (await (await col<ReflectionDoc>("reflections")).scan({})).map((e) => e.doc);
    expect(reflexiones.length).toBeGreaterThan(0);
    // Ninguna reflexión queda sin dueño y ninguna mezcla a los dos.
    for (const r of reflexiones) expect([ANA, BETO]).toContain(r.user_id);

    const deAna = reflexiones.filter((r) => r.user_id === ANA);
    expect(deAna.length).toBeGreaterThan(0);
    // El fallo es sólo de Ana: no puede aparecer atribuido a Beto.
    expect(reflexiones.filter((r) => r.user_id === BETO && r.description.includes("flaky_tool")))
      .toHaveLength(0);
  });

  test("el curador propaga el dueño de la reflexión a la regla", async () => {
    // El reflector exige un lote mínimo antes de correr, así que el relleno
    // exitoso no es decorativo: sin él no hay ciclo y el test pasaría vacío.
    for (let i = 0; i < 4; i++) await seedTrace(ANA, { tool_used: "flaky_tool", success: false });
    for (let i = 0; i < 6; i++) await seedTrace(ANA, { tool_used: "ok_tool", success: true });

    await runReflector(); // dispara runCurator() al final

    const reglas = (await (await col<PlaybookDoc>("playbook")).scan({}))
      .map((e) => e.doc)
      .filter((r) => r.rule.includes("flaky_tool"));

    expect(reglas.length).toBeGreaterThan(0);
    for (const r of reglas) expect(r.user_id).toBe(ANA);
  });

  test("la misma observación de dos personas son dos reglas, no una reforzada", async () => {
    for (let i = 0; i < 4; i++) await seedTrace(ANA, { tool_used: "flaky_tool", success: false });
    for (let i = 0; i < 6; i++) await seedTrace(ANA, { tool_used: "ok_tool", success: true });
    await runReflector();

    for (let i = 0; i < 4; i++) await seedTrace(BETO, { tool_used: "flaky_tool", success: false });
    for (let i = 0; i < 6; i++) await seedTrace(BETO, { tool_used: "ok_tool", success: true });
    await runReflector();

    const reglas = (await (await col<PlaybookDoc>("playbook")).scan({}))
      .map((e) => e.doc)
      .filter((r) => r.rule.includes("flaky_tool"));

    const duenos = new Set(reglas.map((r) => r.user_id));
    expect(duenos.has(ANA)).toBe(true);
    expect(duenos.has(BETO)).toBe(true);
  });
});

describe("las otras dos puertas al playbook", () => {
  test("search_knowledge no le muestra a Beto lo aprendido de Ana", async () => {
    await addRule("Ana pidió que los informes de nómina se entreguen en pdf", ANA);
    await syncPlaybookToIndex();

    const deAna: any = await searchKnowledgeTool.execute(
      { query: "informes de nómina", type: "playbook" },
      { configurable: { user_id: ANA } },
    );
    const deBeto: any = await searchKnowledgeTool.execute(
      { query: "informes de nómina", type: "playbook" },
      { configurable: { user_id: BETO } },
    );

    // Contraprueba: si Ana tampoco la viera, el test pasaría por estar rota la
    // búsqueda y no por el filtro.
    expect(deAna.playbook.map((r: any) => r.rule)).toContain(
      "Ana pidió que los informes de nómina se entreguen en pdf",
    );
    // A Beto le pueden salir reglas sembradas —son globales y le tocan—, pero
    // no la de Ana.
    expect(deBeto.playbook.map((r: any) => r.rule)).not.toContain(
      "Ana pidió que los informes de nómina se entreguen en pdf",
    );
  });

  test("EthicsGuard sólo suma las globales y las del usuario", async () => {
    const guard = new EthicsGuard();
    const playbookCol = await col<PlaybookDoc>("playbook");
    const now = Date.now();
    for (const [rule, dueno] of [
      ["Responder siempre citando la fuente", ""],
      ["A Ana contestarle en tono formal", ANA],
      ["A Beto contestarle en tono informal", BETO],
    ] as const) {
      const id = await nextId("playbook");
      await playbookCol.put(id, {
        id, rule, category: "response_quality", user_id: dueno, applicable_to: null,
        helpful_count: 1, harmful_count: 0, active: true,
        source_reflection_id: toIndexable(null), created_at: now, updated_at: now,
      });
    }

    const paraAna = (await guard.getRules(undefined, ANA)).map((r) => r.rule);
    expect(paraAna).toContain("A Ana contestarle en tono formal");
    expect(paraAna).toContain("Responder siempre citando la fuente");
    expect(paraAna).not.toContain("A Beto contestarle en tono informal");
  });
});
