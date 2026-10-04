/**
 * El oráculo (Jev/Kev) revisa lo que devuelven las tools y la respuesta antes de
 * entregarla. Aquí el modelo y el oráculo son simulados: se comprueba qué hace el
 * runtime con cada veredicto, no qué tan bueno es el oráculo.
 */

process.env.HIVE_DB_PATH = ":memory:";
process.env.HIVE_LLM_STREAM = "0";
process.env.OPENAI_API_KEY = "llave-de-prueba";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createAgent } from "../packages/core/src/api/index";
import { defineTool } from "../packages/core/src/tools/ToolRegistry";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { resetJevStatus } from "../packages/core/src/agent/jev-decisions";

const realFetch = globalThis.fetch;
const ORACLE = "https://oracle.test/v1/systemone";

interface Script {
  /** Lo que responde el modelo, en orden; "tool" pide la tool, cualquier otro texto es respuesta final. */
  model: string[];
  /** Veredictos del oráculo para `verdict` y `grounded` (cumple por defecto). */
  verdict?: "cumple" | "parcial" | "no_cumple";
  grounded?: Array<"cumple" | "no_cumple">;
  /** El modelo responde por streaming (SSE), como hacia un servidor remoto. */
  sse?: boolean;
}

let modelRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
let oracleQuestions: string[][] = [];

function install(script: Script) {
  modelRequests = [];
  oracleQuestions = [];
  let modelCall = 0;
  let groundedCall = 0;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}")));
    if (url === ORACLE) {
      oracleQuestions.push(Object.keys(body.questions));
      const answers: Record<string, unknown> = {};
      for (const name of Object.keys(body.questions)) {
        if (name === "verdict") answers[name] = { choice: script.verdict ?? "cumple", probabilities: { [script.verdict ?? "cumple"]: 0.95 } };
        else if (name === "grounded") {
          const g = script.grounded?.[groundedCall++] ?? "cumple";
          answers[name] = { choice: g, probabilities: { [g]: 0.95 } };
        } else answers[name] = name === "effort" || name === "length" ? { choice: Object.keys(body.questions[name].criteria)[0], probabilities: {} } : { noul: 0.9 };
      }
      return Response.json({ answers });
    }
    modelRequests.push(body);
    const next = script.model[modelCall++] ?? "respuesta final";
    const message = next === "tool"
      ? { role: "assistant", content: null, tool_calls: [{ id: `call_${modelCall}`, type: "function", function: { name: "buscar", arguments: JSON.stringify({ consulta: "x" }) } }] }
      : { role: "assistant", content: next };
    if (script.sse) {
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
      const chunks = next === "tool"
        ? [chunk({ tool_calls: [{ index: 0, id: `call_${modelCall}`, type: "function", function: { name: "buscar", arguments: JSON.stringify({ consulta: "x" }) } }] }, "tool_calls")]
        : [...next.split(" ").map((w, i, all) => chunk({ content: i < all.length - 1 ? `${w} ` : w })), chunk({}, "stop")];
      chunks.push({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } } as never);
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: "c", object: "chat.completion", created: 1, model: "m",
      choices: [{ index: 0, message, finish_reason: next === "tool" ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    });
  }) as unknown as typeof fetch;
}

const buscar = defineTool({
  name: "buscar",
  description: "Busca en la base documental",
  parameters: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] },
  execute: async () => (emptyResults ? { resultados: [] } : { resultados: [{ fuente: "Doc", texto: "Hive SDK es un framework para agentes." }] }),
});
let emptyResults = false;

let counter = 0;
async function run(script: Script, oracle: Parameters<typeof createAgent>[0]["oracle"], tokens?: string[]) {
  install(script);
  resetJevStatus();
  const agent = await createAgent({ name: `verificado-${++counter}`, provider: "openai", model: "gpt-5.6-luna", maxIterations: 6, tools: [buscar], seed: "minimal", browser: false });
  let done: any;
  for await (const event of agent.chat("¿Qué es Hive SDK?", { threadId: `t-${counter}`, oracle, stream: !!tokens })) {
    if (event.type === "token") tokens?.push(event.content);
    if (event.type === "done") done = event;
  }
  return done as { response: string; usage: { iterations: number; oracleCorrections: number; oracleUnsatisfied: boolean } };
}

const kev = (verify?: { tools?: boolean; answer?: boolean; maxCorrections?: number }) => ({ apiKey: "k", endpoint: ORACLE, model: "kev", verify });
const correctionsSeen = () => (modelRequests.at(-1)?.messages ?? []).filter((m) => typeof m.content === "string" && (m.content as string).startsWith("[Verificación]")).length;

beforeAll(() => { /* el fetch se instala por prueba */ });
afterEach(() => { globalThis.fetch = realFetch; });
afterAll(() => { globalThis.fetch = realFetch; closeHiveDb(); });

describe("verificación con el oráculo", () => {
  test("si el veredicto es cumple, el turno no cambia", async () => {
    const done = await run({ model: ["tool", "Hive SDK es un framework."] }, kev({ tools: true }));
    expect(done.response).toBe("Hive SDK es un framework.");
    expect(done.usage).toMatchObject({ iterations: 2, oracleCorrections: 0, oracleUnsatisfied: false });
    expect(correctionsSeen()).toBe(0);
    expect(oracleQuestions.some((q) => q.includes("verdict"))).toBe(true);
    expect(oracleQuestions.some((q) => q.includes("grounded"))).toBe(true);
  });

  test("resultado que no responde: se manda al agente a buscar de nuevo, una sola vez", async () => {
    const done = await run({ model: ["tool", "tool", "Hive SDK es un framework."], verdict: "no_cumple" }, kev({ tools: true }));
    // Segunda ronda de tools con los mismos argumentos: ya se corrigió esa firma, no se vuelve a pedir.
    expect(done.usage.oracleCorrections).toBe(1);
    expect(done.usage.oracleUnsatisfied).toBe(true);
    expect(correctionsSeen()).toBe(1);
    expect(done.response).toBe("Hive SDK es un framework.");
  });

  test("respuesta sin respaldo: se pide reescribirla y se entrega la nueva", async () => {
    const done = await run({ model: ["tool", "No tengo eso documentado.", "Hive SDK es un framework para agentes."], grounded: ["no_cumple", "cumple"] }, kev());
    expect(done.response).toBe("Hive SDK es un framework para agentes.");
    expect(done.usage.oracleCorrections).toBe(1);
    expect(modelRequests.at(-1)!.messages.some((m) => typeof m.content === "string" && m.content.includes("No tengo eso documentado."))).toBe(true);
  });

  test("con maxCorrections 0 solo observa: entrega lo que dijo el modelo y avisa", async () => {
    const done = await run({ model: ["tool", "No tengo eso documentado."], grounded: ["no_cumple"] }, kev({ maxCorrections: 0 }));
    expect(done.response).toBe("No tengo eso documentado.");
    expect(done.usage).toMatchObject({ oracleCorrections: 0, oracleUnsatisfied: true });
    expect(correctionsSeen()).toBe(0);
  });

  test("por defecto no se pregunta por el resultado de las tools: un resultado vacío no manda a buscar de nuevo", async () => {
    const done = await run({ model: ["tool", "Hive SDK es un framework."], verdict: "no_cumple" }, kev());
    expect(done.usage.oracleCorrections).toBe(0);
    expect(oracleQuestions.some((q) => q.includes("verdict"))).toBe(false);
    expect(oracleQuestions.some((q) => q.includes("grounded"))).toBe(true);
  });

  test("un resultado vacío no cuenta como evidencia: la respuesta «no hay información» no se cuestiona", async () => {
    emptyResults = true;
    try {
      const done = await run({ model: ["tool", "No tengo eso documentado."], grounded: ["no_cumple"] }, kev());
      expect(done.response).toBe("No tengo eso documentado.");
      expect(done.usage.oracleCorrections).toBe(0);
      expect(oracleQuestions.some((q) => q.includes("grounded"))).toBe(false);
    } finally {
      emptyResults = false;
    }
  });

  test("verify apagado: el oráculo no recibe preguntas de verificación", async () => {
    await run({ model: ["tool", "Hive SDK es un framework."], verdict: "no_cumple", grounded: ["no_cumple"] }, kev({ tools: false, answer: false }));
    expect(oracleQuestions.some((q) => q.includes("verdict") || q.includes("grounded"))).toBe(false);
  });

  test("sin oráculo el turno corre igual y no se consulta a nadie", async () => {
    const done = await run({ model: ["tool", "Hive SDK es un framework."] }, false);
    expect(done.response).toBe("Hive SDK es un framework.");
    expect(done.usage).toMatchObject({ iterations: 2, oracleCorrections: 0, oracleUnsatisfied: false });
    expect(oracleQuestions).toHaveLength(0);
  });

  test("por streaming, la respuesta rechazada no sale: solo llegan los tokens de la que sí tiene respaldo", async () => {
    delete process.env.HIVE_LLM_STREAM;
    const tokens: string[] = [];
    try {
      const done = await run({ sse: true, model: ["tool", "No tengo eso documentado.", "Hive SDK es un framework para agentes."], grounded: ["no_cumple", "cumple"] }, kev(), tokens);
      expect(done.response).toBe("Hive SDK es un framework para agentes.");
      expect(tokens.join("")).toBe("Hive SDK es un framework para agentes.");
    } finally {
      process.env.HIVE_LLM_STREAM = "0";
    }
  });

  test("por streaming, una respuesta con respaldo se entrega entera tras el veredicto", async () => {
    delete process.env.HIVE_LLM_STREAM;
    const tokens: string[] = [];
    try {
      await run({ sse: true, model: ["tool", "Hive SDK es un framework para agentes."] }, kev(), tokens);
      expect(tokens.join("")).toBe("Hive SDK es un framework para agentes.");
    } finally {
      process.env.HIVE_LLM_STREAM = "0";
    }
  });
});
