/**
 * El evento `done` de `agent.chat()` trae lo que costó el turno.
 *
 * Para medir un agente había que raspar los logs del SDK (iteraciones, tokens,
 * tiempo). Ahora vienen en el evento: tokens de entrada y salida, tokens de
 * razonamiento, cuántas llamadas al modelo y a tools hizo, y cuánto tardó.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgent } from "../packages/core/src/api/createAgent";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";

const realFetch = globalThis.fetch;
const previousStream = process.env.HIVE_LLM_STREAM;
const previousKey = process.env.OPENAI_API_KEY;

beforeAll(() => {
  // El servidor simulado responde JSON sin streaming.
  process.env.HIVE_LLM_STREAM = "0";
  process.env.OPENAI_API_KEY = "llave-de-prueba";
  globalThis.fetch = (async () => Response.json({
    id: "c", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "Hola", reasoning_content: "x".repeat(40) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135, completion_tokens_details: { reasoning_tokens: 9 } },
  })) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (previousStream === undefined) delete process.env.HIVE_LLM_STREAM; else process.env.HIVE_LLM_STREAM = previousStream;
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  closeHiveDb();
});

describe("métricas del turno", () => {
  test("done lleva tokens, razonamiento, llamadas y tiempo", async () => {
    const agent = await createAgent({ name: "medido", provider: "openai", model: "gpt-5.6-luna", maxIterations: 2 });
    const events = [];
    for await (const event of agent.chat("hola", { threadId: "t-medido" })) events.push(event);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") throw new Error("sin done");
    expect(done.response).toBe("Hola");
    expect(done.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 15,
      // El servidor informa `reasoning_tokens`: se usa ese número, no una estimación.
      thinkingTokens: 9,
      iterations: 1,
      toolCalls: 0,
    });
    expect(done.usage!.elapsedMs).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
