/**
 * Las tools se declaran con `parameters` en JSON Schema, sin zod.
 *
 * Es el formato que ve el modelo y que usan las tools nativas (y `hive`). Los
 * argumentos se validan al ejecutar, y el error que recibe el modelo dice qué
 * falta y qué parámetros existen: el caso real fue Qwen escribiendo `query`
 * donde la tool espera `consulta`.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { defineTool, ToolRegistry } from "../packages/core/src/tools/ToolRegistry";
import { ToolExecutor } from "../packages/core/src/tools/ToolExecutor";
import { describeInvalidArgs, validateToolArgs } from "../packages/core/src/tools/validate-args";
import { createAgent } from "../packages/core/src/api/createAgent";
import { clearAppTools, createAllTools } from "../packages/core/src/tools/index";
import { loadConfig } from "../packages/core/src/config/loader";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import type { ToolParametersSchema } from "../packages/core/src/tools/types";

const buscar: ToolParametersSchema = {
  type: "object",
  properties: {
    consulta: { type: "string", description: "qué buscar", minLength: 2 },
    coleccion: { type: "string", enum: ["cases", "hive"] },
    limite: { type: "integer", minimum: 1, maximum: 10 },
    etiquetas: { type: "array", items: { type: "string" } },
    filtro: { type: "object", properties: { desde: { type: "string" } }, required: ["desde"] },
  },
  required: ["consulta"],
};

describe("defineTool", () => {
  test("acepta una definición con parameters en JSON Schema", () => {
    const tool = defineTool({ name: "buscar", description: "Busca", parameters: buscar, execute: async () => "ok" });
    expect(tool.parameters).toBe(buscar);
  });

  test("sin parameters es una tool sin argumentos", () => {
    expect(() => defineTool({ name: "ping", description: "Responde pong", execute: async () => "pong" })).not.toThrow();
  });

  test("`schema` (de zod, hasta 0.5) se rechaza con el cambio explicado", () => {
    expect(() => defineTool({ name: "viejo", description: "x", schema: {}, execute: async () => 1 } as never)).toThrow(/`schema` ya no existe.*parameters/s);
  });

  test("rechaza lo que fallaría más tarde y lejos", () => {
    expect(() => defineTool({ name: "", description: "x", execute: async () => 1 })).toThrow(/falta `name`/);
    expect(() => defineTool({ name: "a", execute: async () => 1 } as never)).toThrow(/falta `description`/);
    // Vacía se admite: solo la tool no se podrá encontrar por capacidad.
    expect(() => defineTool({ name: "a", description: "", execute: async () => 1 })).not.toThrow();
    expect(() => defineTool({ name: "a", description: "x" } as never)).toThrow(/falta `execute`/);
    expect(() => defineTool({ name: "a", description: "x", parameters: { type: "string" } as never, execute: async () => 1 })).toThrow(/debe ser "object"/);
    expect(() => defineTool({ name: "a", description: "x", parameters: { type: "object", properties: { a: { type: "string" } }, required: ["b"] }, execute: async () => 1 }))
      .toThrow(/menciona parámetros que no están en `properties`: b/);
  });
});

describe("validateToolArgs", () => {
  test("argumentos válidos: sin errores", () => {
    expect(validateToolArgs(buscar, { consulta: "hive", coleccion: "cases", limite: 3, etiquetas: ["a"], filtro: { desde: "2026" } })).toEqual([]);
  });

  test("sin parameters no hay nada que validar", () => {
    expect(validateToolArgs(undefined, { cualquier: "cosa" })).toEqual([]);
  });

  test("falta un parámetro requerido", () => {
    expect(validateToolArgs(buscar, {})).toEqual(['falta "consulta"']);
  });

  test("tipo incorrecto, con lo que se recibió", () => {
    expect(validateToolArgs(buscar, { consulta: 5 })).toEqual(['"consulta" debe ser string (recibí number)']);
  });

  test("enum, rangos, longitudes y enteros", () => {
    expect(validateToolArgs(buscar, { consulta: "x" })).toEqual(['"consulta" debe tener al menos 2 caracteres']);
    expect(validateToolArgs(buscar, { consulta: "hive", coleccion: "otra" })[0]).toMatch(/uno de: "cases", "hive"/);
    expect(validateToolArgs(buscar, { consulta: "hive", limite: 11 })).toEqual(['"limite" debe ser ≤ 10']);
    expect(validateToolArgs(buscar, { consulta: "hive", limite: 2.5 })[0]).toMatch(/debe ser integer/);
  });

  test("arrays y objetos anidados con la ruta del error", () => {
    expect(validateToolArgs(buscar, { consulta: "hive", etiquetas: ["a", 2] })).toEqual(['"etiquetas[1]" debe ser string (recibí number)']);
    expect(validateToolArgs(buscar, { consulta: "hive", filtro: {} })).toEqual(['falta "filtro.desde"']);
  });

  test("additionalProperties:false rechaza lo desconocido; por defecto se permite", () => {
    const estricto: ToolParametersSchema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } as never;
    expect(validateToolArgs(estricto, { a: "x", b: 1 })).toEqual(['"b" no existe']);
    expect(validateToolArgs(buscar, { consulta: "hive", extra: true })).toEqual([]);
  });

  test("los argumentos tienen que ser un objeto", () => {
    expect(validateToolArgs(buscar, "hola")[0]).toMatch(/deben ser un objeto/);
    expect(validateToolArgs(buscar, [1])[0]).toMatch(/deben ser un objeto/);
  });

  test("un tipo que no se conoce no se rechaza (una validación de más rompe llamadas que sí servían)", () => {
    expect(validateToolArgs({ type: "object", properties: { x: { type: "raro" } } }, { x: 1 })).toEqual([]);
  });

  test("unión de tipos", () => {
    const p: ToolParametersSchema = { type: "object", properties: { x: { type: ["string", "null"] } } };
    expect(validateToolArgs(p, { x: null })).toEqual([]);
    expect(validateToolArgs(p, { x: 3 })[0]).toMatch(/string o null/);
  });
});

describe("describeInvalidArgs: el mensaje que lee el modelo", () => {
  test("el caso real: inventó `query` y la tool espera `consulta`", () => {
    const message = describeInvalidArgs("buscar_conocimiento_sitio", buscar, { query: "hive sdk" });
    expect(message).toContain('falta "consulta"');
    expect(message).toContain("Parámetros de buscar_conocimiento_sitio: consulta, coleccion, limite, etiquetas, filtro");
    expect(message).toContain("Recibí: query");
  });

  test("argumentos válidos: null", () => {
    expect(describeInvalidArgs("x", buscar, { consulta: "hive" })).toBeNull();
  });
});

describe("ToolExecutor", () => {
  test("ejecuta con argumentos válidos y devuelve el error de validación sin ejecutar", async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register(defineTool({ name: "buscar", description: "Busca", parameters: buscar, execute: async (a: { consulta: string }) => { calls++; return a.consulta; } }));
    const executor = new ToolExecutor(registry);

    expect((await executor.execute("buscar", { consulta: "hive" })).result).toBe("hive");
    const bad = await executor.execute("buscar", { query: "hive" });
    expect(bad.error).toContain('falta "consulta"');
    expect(calls).toBe(1);
  });
});

describe("createAgent con una tool de la app", () => {
  beforeAll(() => { delete process.env.HIVE_JEV; });
  beforeEach(async () => { closeHiveDb(); clearAppTools(); await ensureHiveDb(); });
  afterEach(() => closeHiveDb());
  afterAll(() => closeHiveDb());

  const registered = async (name: string) => createAllTools(await loadConfig()).find((t) => t.name === name)!;

  test("los parameters llegan al modelo tal cual", async () => {
    await createAgent({ name: "con-parametros", tools: [defineTool({ name: "buscar_x", description: "Busca", parameters: buscar, execute: async () => "ok" })] });
    const tool = await registered("buscar_x");
    expect(tool.parameters.required).toEqual(["consulta"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["consulta", "coleccion", "limite", "etiquetas", "filtro"]);
    expect(tool.parameters.properties.coleccion).toEqual({ type: "string", enum: ["cases", "hive"] });
  });

  test("argumentos válidos llegan a execute", async () => {
    await createAgent({ name: "valida", tools: [defineTool({ name: "buscar_y", description: "Busca", parameters: buscar, execute: async (a: { consulta: string }) => `r:${a.consulta}` })] });
    expect(await (await registered("buscar_y")).execute({ consulta: "hive" })).toBe("r:hive");
  });

  test("argumentos inválidos lanzan el mensaje para el modelo y execute no corre", async () => {
    let ran = false;
    await createAgent({ name: "invalida", tools: [defineTool({ name: "buscar_z", description: "Busca", parameters: buscar, execute: async () => { ran = true; return "ok"; } })] });
    await expect((await registered("buscar_z")).execute({ query: "hive" })).rejects.toThrow(/falta "consulta".*Parámetros de buscar_z: consulta/s);
    expect(ran).toBe(false);
  });

  test("una tool sin parameters se ofrece sin argumentos y acepta cualquier llamada", async () => {
    await createAgent({ name: "sin-args", tools: [defineTool({ name: "ping_w", description: "Responde pong", execute: async () => "pong" })] });
    const tool = await registered("ping_w");
    expect(tool.parameters).toEqual({ type: "object", properties: {}, required: [] });
    expect(await tool.execute({})).toBe("pong");
  });
});
