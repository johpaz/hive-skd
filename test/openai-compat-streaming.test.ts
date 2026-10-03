/**
 * Streaming interno y tokens de uso en proveedores compatibles con OpenAI.
 *
 * Detrás de Cloudflare una petición sin streaming no envía nada hasta que el
 * modelo termina; pasado ~100 s el túnel responde 524 y el reintento repite el
 * trabajo. Con streaming llegan tokens y la conexión se mantiene. Los deltas se
 * acumulan y la respuesta es la misma.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HiveAgentsProvider } from "../packages/core/src/agent/llm-providers/hiveagents";

const realFetch = globalThis.fetch;
const realEnv = process.env.HIVE_LLM_STREAM;
// Estas pruebas parten del comportamiento por defecto, sin lo que otros archivos dejen en el entorno.
beforeEach(() => { delete process.env.HIVE_LLM_STREAM; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv === undefined) delete process.env.HIVE_LLM_STREAM; else process.env.HIVE_LLM_STREAM = realEnv;
});

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usageChunk = (usage: Record<string, unknown>) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "local", choices: [], usage });

const requests: any[] = [];
function serve(handler: (body: any) => Response) {
  requests.length = 0;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const body = await request.clone().json();
    requests.push(body);
    return handler(body);
  }) as unknown as typeof fetch;
}

const call = (baseUrl: string, extra: Record<string, unknown> = {}) =>
  new HiveAgentsProvider().call({
    provider: "hiveagents", model: "hiveagents/local", apiKey: "k", baseUrl,
    messages: [{ role: "user", content: "hola" }], ...extra,
  } as never);

const streamingReply = () => sse([
  delta({ reasoning_content: "pienso un poco " }),
  delta({ content: "Hola, " }),
  delta({ content: "mundo" }, "stop"),
  usageChunk({ prompt_tokens: 12, completion_tokens: 30 }),
]);

describe("streaming interno", () => {
  test("hacia un servidor remoto se hace streaming aunque nadie pida tokens, y se acumula", async () => {
    serve(() => streamingReply());
    const response = await call("https://llm.hiveagents.io/v1");
    expect(requests[0].stream).toBe(true);
    expect(response.content).toBe("Hola, mundo");
    expect(response.reasoning_content).toBe("pienso un poco ");
    expect(response.stop_reason).toBe("stop");
  });

  test("pide los tokens de uso y los lee del último chunk, que no trae choices", async () => {
    serve(() => streamingReply());
    const response = await call("https://llm.hiveagents.io/v1");
    expect(requests[0].stream_options).toEqual({ include_usage: true });
    expect(response.usage).toMatchObject({ input_tokens: 12, output_tokens: 30 });
    // llama.cpp no informa los tokens de razonamiento: se estiman del texto.
    expect(response.usage?.thinking_tokens).toBe(Math.ceil("pienso un poco ".length / 4));
  });

  test("un servidor local conserva la llamada sin streaming", async () => {
    serve(() => Response.json({ id: "c", object: "chat.completion", created: 1, model: "local", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const response = await call("http://127.0.0.1:8081/v1");
    expect(requests[0].stream).toBeUndefined();
    expect(response.content).toBe("ok");
  });

  test("HIVE_LLM_STREAM=0 lo apaga también hacia un servidor remoto", async () => {
    process.env.HIVE_LLM_STREAM = "0";
    serve(() => Response.json({ id: "c", object: "chat.completion", created: 1, model: "local", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    await call("https://llm.hiveagents.io/v1");
    expect(requests[0].stream).toBeUndefined();
  });

  test("un servidor que no conoce stream_options recibe la petición sin el campo", async () => {
    serve((body) => body.stream_options
      ? new Response(JSON.stringify({ error: { message: "Unknown field: stream_options" } }), { status: 400, headers: { "content-type": "application/json" } })
      : streamingReply());
    const response = await call("https://llm.hiveagents.io/v1");
    expect(requests).toHaveLength(2);
    expect(requests[1].stream_options).toBeUndefined();
    expect(response.content).toBe("Hola, mundo");
  });

  test("con onToken los deltas llegan uno a uno", async () => {
    serve(() => streamingReply());
    const tokens: string[] = [];
    await call("https://llm.hiveagents.io/v1", { onToken: (t: string) => tokens.push(t) });
    expect(tokens).toEqual(["Hola, ", "mundo"]);
  });
});
