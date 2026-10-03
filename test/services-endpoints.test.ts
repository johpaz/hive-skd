/**
 * Endpoints HTTP registrados como herramientas.
 *
 * Es lo más cerca que se puede estar de "crear una tool desde la UI" sin abrir
 * la puerta a ejecutar código arbitrario: el usuario aporta datos y el ejecutor
 * es genérico.
 *
 * El test que más importa es el de la credencial: si se filtrara al resultado o
 * al listado, esta función sería peor que darle al modelo una `api_request` con
 * la clave en el prompt, porque además daría sensación de seguridad.
 *
 * Uses HIVE_DB_PATH=":memory:" so no state persists between runs.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach, afterEach, } from "bun:test";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { col } from "../packages/core/src/storage/hive";
import type { ToolDoc } from "../packages/core/src/storage/collections";
import * as endpoints from "../packages/core/src/services/endpoints";
import { clearAppTools, listAppTools } from "../packages/core/src/tools/index";

const SECRETO = "Bearer sk-clave-super-secreta";

/** Captura la llamada saliente sin salir a la red. */
function interceptarFetch() {
  const llamadas: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true, eco: "respuesta" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { llamadas, restaurar: () => { globalThis.fetch = original; } };
}

beforeEach(async () => {
  closeHiveDb();
  clearAppTools();
  await ensureHiveDb();
});

afterEach(() => {
  closeHiveDb();
});

describe("services/endpoints: registro", () => {
  test("crear un endpoint lo deja disponible como tool", async () => {
    const ep = await endpoints.createEndpoint({
      name: "Clima",
      description: "Consulta el clima de una ciudad",
      url: "https://api.example.com/clima",
    });

    expect(ep.toolName).toBe("endpoint_clima");
    // Sin la fila en `tools`, search_knowledge nunca lo encontraría.
    const fila = await (await col<ToolDoc>("tools")).get("endpoint_clima");
    expect(fila?.doc.category).toBe("api");
    expect(listAppTools().map((t) => t.name)).toContain("endpoint_clima");
  });

  test("exige descripción: es lo que el modelo lee para decidir", async () => {
    await expect(
      endpoints.createEndpoint({ name: "X", description: "  ", url: "https://x.com" }),
    ).rejects.toThrow(/descripción/);
  });

  test("rechaza un método no permitido", async () => {
    await expect(
      endpoints.createEndpoint({ name: "Y", description: "d", url: "https://x.com", method: "TRACE" }),
    ).rejects.toThrow(/Método no permitido/);
  });

  test("no permite duplicados", async () => {
    await endpoints.createEndpoint({ name: "Dup", description: "d", url: "https://x.com" });
    await expect(
      endpoints.createEndpoint({ name: "Dup", description: "d", url: "https://x.com" }),
    ).rejects.toThrow(/Ya existe/);
  });
});

describe("services/endpoints: la credencial no se filtra", () => {
  test("no aparece al leer el endpoint ni al listarlo", async () => {
    await endpoints.createEndpoint({
      name: "Privado",
      description: "d",
      url: "https://api.example.com/x",
      secretHeaders: { Authorization: SECRETO },
    });

    const uno = await endpoints.getEndpoint("privado");
    const todos = await endpoints.listEndpoints();

    expect(JSON.stringify(uno)).not.toContain("sk-clave-super-secreta");
    expect(JSON.stringify(todos)).not.toContain("sk-clave-super-secreta");
    // Pero sí se sabe QUÉ cabeceras hay configuradas.
    expect(uno?.secretHeaderNames).toEqual(["Authorization"]);
  });

  test("sí viaja en la llamada real, que es donde tiene que estar", async () => {
    const { llamadas, restaurar } = interceptarFetch();
    try {
      await endpoints.createEndpoint({
        name: "Con clave",
        description: "d",
        url: "https://api.example.com/x",
        secretHeaders: { Authorization: SECRETO },
      });
      await endpoints.testEndpoint("con_clave");

      const headers = llamadas[0]!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(SECRETO);
    } finally {
      restaurar();
    }
  });
});

describe("services/endpoints: plantillas", () => {
  test("los parámetros del modelo llenan la URL y el cuerpo", async () => {
    const { llamadas, restaurar } = interceptarFetch();
    try {
      await endpoints.createEndpoint({
        name: "Buscar",
        description: "d",
        method: "POST",
        url: "https://api.example.com/{{recurso}}",
        bodyTemplate: '{"q":"{{consulta}}","n":{{limite}}}',
        query: { lang: "{{idioma}}" },
      });

      await endpoints.testEndpoint("buscar", { recurso: "items", consulta: "sillas", limite: 5, idioma: "es" });

      const { url, init } = llamadas[0]!;
      expect(url).toContain("/items");
      expect(url).toContain("lang=es");
      // Un número no debe terminar como "[object Object]" ni entrecomillado.
      expect(String(init.body)).toBe('{"q":"sillas","n":5}');
    } finally {
      restaurar();
    }
  });

  test("un parámetro ausente deja el hueco vacío, no el literal", async () => {
    const { llamadas, restaurar } = interceptarFetch();
    try {
      await endpoints.createEndpoint({
        name: "Parcial", description: "d", url: "https://api.example.com/x?a={{falta}}",
      });
      await endpoints.testEndpoint("parcial", {});
      expect(llamadas[0]!.url).not.toContain("{{falta}}");
    } finally {
      restaurar();
    }
  });
});

describe("services/endpoints: ciclo de vida", () => {
  test("borrar quita la tool del catálogo", async () => {
    await endpoints.createEndpoint({ name: "Temporal", description: "d", url: "https://x.com" });
    expect(await endpoints.deleteEndpoint("temporal")).toBe(true);

    expect(await (await col<ToolDoc>("tools")).get("endpoint_temporal")).toBeUndefined();
    expect(await endpoints.getEndpoint("temporal")).toBeNull();
  });

  test("deshabilitar lo saca del listado y desactiva su tool", async () => {
    await endpoints.createEndpoint({ name: "Pausable", description: "d", url: "https://x.com" });
    await endpoints.toggleEndpoint("pausable", false);

    expect((await endpoints.listEndpoints()).map((e) => e.id)).not.toContain("pausable");
    const fila = await (await col<ToolDoc>("tools")).get("endpoint_pausable");
    expect(fila?.doc.active).toBe(false);
  });

  test("registerEndpointTools rearma las tools tras un reinicio", async () => {
    await endpoints.createEndpoint({ name: "Persistente", description: "d", url: "https://x.com" });

    // Un proceso nuevo arranca con el registro en memoria vacío.
    clearAppTools();
    expect(listAppTools()).toHaveLength(0);

    expect(await endpoints.registerEndpointTools()).toBe(1);
    expect(listAppTools().map((t) => t.name)).toContain("endpoint_persistente");
  });
});
