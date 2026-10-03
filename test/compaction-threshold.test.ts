/**
 * Cuándo se compacta y con qué llave se pide el resumen.
 *
 * Los dos errores que cubre:
 *   - `agent.context.compactionThreshold` (0.8 por defecto) se leía como
 *     tokens y no como proporción de la ventana del modelo: el umbral quedaba
 *     en 0.8 tokens y cualquier hilo se resumía en cada turno.
 *   - el resumen se pedía con `getDefaultLLM()` y sin credenciales, así que la
 *     llave salía del secret store, del llavero del sistema o del entorno —la
 *     de la plataforma, no la del inquilino—.
 *
 * La llamada al proveedor se intercepta en `fetch`: no sale nada a la red.
 */

process.env.HIVE_DB_PATH = ":memory:";


import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { maybeCompact, resolveCompactionThreshold } from "../packages/core/src/agent/compaction";
import { addMessage, getSummary } from "../packages/core/src/agent/conversation-store";
import { col } from "../packages/core/src/storage/hive";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import type { ModelDoc, ProviderDoc } from "../packages/core/src/storage/collections";

// Estas pruebas simulan un servidor con respuestas JSON sin streaming: el
// streaming interno hacia servidores remotos se apaga mientras corren (el
// entorno es del proceso, así que se restaura al terminar).
const previousStream = process.env.HIVE_LLM_STREAM;
beforeAll(() => { process.env.HIVE_LLM_STREAM = "0"; });
afterAll(() => { if (previousStream === undefined) delete process.env.HIVE_LLM_STREAM; else process.env.HIVE_LLM_STREAM = previousStream; });

const CONTEXT_WINDOW = 1_000;
/** El umbral por defecto: 80 % de la ventana. */
const THRESHOLD = 800;

const realFetch = globalThis.fetch;
const requests: Array<{ url: string; authorization: string | null; body: any }> = [];

/** Una respuesta con forma de chat completion, para que el cliente de OpenAI la acepte. */
const completion = (content: string) => ({
  id: "cmpl-test",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "modelo-corto",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

beforeAll(async () => {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: await request.clone().json().catch(() => null),
    });
    return new Response(JSON.stringify(completion("Resumen de prueba")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const providers = await col<ProviderDoc>("providers");
  await providers.put("openai", {
    id: "openai", name: "OpenAI", base_url: "https://proveedor.invalido/v1", category: "llm",
    num_ctx: null, num_gpu: 0, enabled: true, active: true, created_at: Date.now(),
  });
  const models = await col<ModelDoc>("models");
  await models.put("modelo-corto", {
    id: "modelo-corto", provider_id: "openai", name: "modelo-corto", model_type: "llm",
    context_window: CONTEXT_WINDOW, capabilities: null, enabled: true, active: true,
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await closeHiveDb();
});

beforeEach(() => { requests.length = 0; });

/** Un hilo con `turns` intercambios de ~150 tokens cada mensaje. */
async function seedThread(turns: number): Promise<string> {
  const threadId = `hilo-${crypto.randomUUID()}`;
  for (let turn = 0; turn < turns; turn++) {
    await addMessage(threadId, "user", `pregunta ${turn} `.padEnd(600, "x"));
    await addMessage(threadId, "assistant", `respuesta ${turn} `.padEnd(600, "y"));
  }
  return threadId;
}

const llm = (apiKey: string) => ({
  provider: "openai",
  model: "modelo-corto",
  credentials: { apiKey, baseUrl: "https://proveedor.invalido/v1" },
  contextWindow: CONTEXT_WINDOW,
});

describe("resolveCompactionThreshold", () => {
  test("lee la configuración por defecto como proporción de la ventana", () => {
    expect(resolveCompactionThreshold(0.8, 200_000)).toBe(160_000);
    expect(resolveCompactionThreshold(0.8, CONTEXT_WINDOW)).toBe(THRESHOLD);
    // Sin ventana conocida, la proporción se aplica sobre la asumida (128k).
    expect(resolveCompactionThreshold(0.8, undefined)).toBe(102_400);
  });

  test("un valor mayor que 1 sigue siendo un número de tokens", () => {
    expect(resolveCompactionThreshold(5_000, 200_000)).toBe(5_000);
    expect(resolveCompactionThreshold(5_000.7, undefined)).toBe(5_000);
  });

  test("sin configuración usa el 25 % de la ventana, o la constante si no se sabe", () => {
    expect(resolveCompactionThreshold(undefined, 200_000)).toBe(50_000);
    expect(resolveCompactionThreshold(undefined, undefined)).toBe(32_000);
    expect(resolveCompactionThreshold(0, 200_000)).toBe(50_000);
    expect(resolveCompactionThreshold(Number.NaN, 200_000)).toBe(50_000);
    expect(resolveCompactionThreshold(-1, undefined)).toBe(32_000);
  });
});

describe("maybeCompact", () => {
  test("no compacta un hilo corto (el bug dejaba el umbral en 0.8 tokens)", async () => {
    const threadId = await seedThread(1);
    await maybeCompact(threadId, undefined, llm("llave-del-cliente"));
    expect(requests).toHaveLength(0);
    expect(await getSummary(threadId)).toBeNull();
  });

  test("compacta al pasar el umbral, con el modelo y la llave del turno", async () => {
    const threadId = await seedThread(4);
    await maybeCompact(threadId, undefined, llm("llave-del-cliente"));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toStartWith("https://proveedor.invalido/v1");
    expect(requests[0]!.authorization).toBe("Bearer llave-del-cliente");
    expect(requests[0]!.body.model).toBe("modelo-corto");
    expect(await getSummary(threadId)).toMatchObject({ summary: "Resumen de prueba" });
  });

  test("cada inquilino resume con su propia llave", async () => {
    const otro = await seedThread(4);
    await maybeCompact(otro, undefined, llm("llave-de-otro-cliente"));
    expect(requests.at(-1)!.authorization).toBe("Bearer llave-de-otro-cliente");
  });
});
