/**
 * Credenciales y Jev por llamada en `createAgent`.
 *
 * Un host multi-inquilino no puede depender de variables de entorno para la
 * llave de cada cliente. `createAgent({ credentials })` fija las del agente y
 * cada `chat()/run()` puede traer las suyas, que ganan.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgent } from "../packages/core/src/api/createAgent";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";

const realFetch = globalThis.fetch;
const previousStream = process.env.HIVE_LLM_STREAM;
const previousKey = process.env.OPENAI_API_KEY;
const seen: Array<{ url: string; auth: string | null }> = [];

beforeAll(() => {
  process.env.HIVE_LLM_STREAM = "0";
  delete process.env.OPENAI_API_KEY; // ninguna llave en el entorno: todo viene de `credentials`
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    seen.push({ url: request.url, auth: request.headers.get("authorization") });
    return Response.json({
      id: "c", object: "chat.completion", created: 1, model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (previousStream === undefined) delete process.env.HIVE_LLM_STREAM; else process.env.HIVE_LLM_STREAM = previousStream;
  if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
  closeHiveDb();
});

describe("credenciales por agente y por llamada", () => {
  test("las del agente se usan sin ninguna variable de entorno", async () => {
    seen.length = 0;
    const agent = await createAgent({
      name: "con-credenciales", provider: "openai", model: "gpt-5.6-luna", jev: false,
      credentials: { apiKey: "llave-del-agente", baseUrl: "https://proveedor.invalido/v1" },
    });
    expect(await agent.run("hola", { threadId: "t1" })).toBe("ok");
    expect(seen.at(-1)).toEqual({ url: "https://proveedor.invalido/v1/chat/completions", auth: "Bearer llave-del-agente" });
  }, 60_000);

  test("las de la llamada ganan a las del agente", async () => {
    seen.length = 0;
    const agent = await createAgent({
      name: "con-credenciales", provider: "openai", model: "gpt-5.6-luna", jev: false,
      credentials: { apiKey: "llave-del-agente", baseUrl: "https://proveedor.invalido/v1" },
    });
    await agent.run("hola", { threadId: "t2", credentials: { apiKey: "llave-del-cliente", baseUrl: "https://cliente.invalido/v1" } });
    expect(seen.at(-1)).toEqual({ url: "https://cliente.invalido/v1/chat/completions", auth: "Bearer llave-del-cliente" });
  }, 60_000);

  test("jev:false en la llamada no hace ninguna petición de decisiones", async () => {
    seen.length = 0;
    const agent = await createAgent({
      name: "sin-jev", provider: "openai", model: "gpt-5.6-luna",
      credentials: { apiKey: "k", baseUrl: "https://proveedor.invalido/v1" },
    });
    await agent.run("hola", { threadId: "t3", jev: false });
    expect(seen.some((r) => r.url.includes("openrouter.ai"))).toBe(false);
  }, 60_000);
});
