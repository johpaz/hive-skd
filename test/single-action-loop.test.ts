/**
 * El modo de una acción por contexto dentro del bucle real de un worker.
 *
 * Modelo simulado por `fetch`: responde en orden —tres llamadas a una herramienta y luego la respuesta
 * final— y, aparte, al destilador de estado (se reconoce por su prompt de sistema). Se comprueba qué
 * recibe el modelo en cada llamada, no su calidad.
 */

process.env.HIVE_DB_PATH = ":memory:";
process.env.HIVE_LLM_STREAM = "0";
process.env.OPENAI_API_KEY = "llave-de-prueba";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAgent } from "../packages/core/src/api/index";
import { runAgentIsolatedDetailed } from "../packages/core/src/agent/agent-loop";
import { defineTool } from "../packages/core/src/tools/ToolRegistry";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { resetJevStatus } from "../packages/core/src/agent/jev-decisions";

const realFetch = globalThis.fetch;
const STATE_SYSTEM = "conversation state compactor";

type Msg = { role: string; content: unknown; tool_calls?: unknown[] };
type Req = { messages: Msg[] };

const buscar = defineTool({
  name: "buscar",
  description: "Busca en la base documental",
  parameters: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] },
  execute: async (args: { consulta: string }) => ({ resultado: `dato-exacto-${args.consulta}-` + "z".repeat(1500) }),
});

const text = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

/**
 * Tres consultas y la respuesta final. `stateReply` decide qué contesta el destilador:
 * un traspaso válido, o algo que no lo es.
 */
function install(stateReply: "valido" | "invalido") {
  const actions: Req[] = [];
  const states: Req[] = [];
  let step = 0;
  globalThis.fetch = (async (_input: any, init: any = {}) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Req;
    const system = text(body.messages[0]!);
    const reply = (message: Record<string, unknown>, finish: string) =>
      Response.json({
        id: "c", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      });

    if (system.includes(STATE_SYSTEM)) {
      states.push(body);
      const n = states.length;
      const content = stateReply === "valido"
        ? JSON.stringify({
            objective: "Reunir los tres datos",
            facts: [`dato ${n} obtenido`],
            changes: [], verification: [],
            dead_ends: [], plan: [`consulta ${n + 1}`],
          })
        : "esto no es un traspaso";
      return reply({ content }, "stop");
    }

    actions.push(body);
    step++;
    if (step <= 3) {
      return reply({
        content: null,
        tool_calls: [{ id: `call_${step}`, type: "function", function: { name: "buscar", arguments: JSON.stringify({ consulta: `q${step}` }) } }],
      }, "tool_calls");
    }
    return reply({ content: "Listo: tres datos reunidos." }, "stop");
  }) as unknown as typeof fetch;
  return { actions, states };
}

let counter = 0;
async function runWorker() {
  resetJevStatus();
  const name = `worker_sa_${++counter}`;
  await createAgent({ name, provider: "openai", model: "gpt-5.6-luna", tools: [buscar], seed: "minimal", browser: false, oracle: false, maxIterations: 8 });
  return runAgentIsolatedDetailed({
    agentId: name,
    taskDescription: "Reúne los tres datos pedidos",
    threadId: `t-sa-${counter}`,
  });
}

beforeEach(() => {
  delete process.env.HIVE_SINGLE_ACTION;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HIVE_SINGLE_ACTION;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  closeHiveDb();
});

describe("worker con singleActionMode apagado (por defecto)", () => {
  test("acumula el historial: la última llamada ve las tres herramientas anteriores", async () => {
    const { actions, states } = install("valido");
    const out = await runWorker();

    expect(out.content).toContain("tres datos reunidos");
    expect(actions.length).toBe(4);
    expect(states.length).toBe(0);
    expect(actions[3]!.messages.filter((m) => m.role === "tool").length).toBe(3);
  }, 60_000);
});

describe("worker con HIVE_SINGLE_ACTION=true", () => {
  test("cada llamada ve solo la tarea y el estado: el historial no crece", async () => {
    process.env.HIVE_SINGLE_ACTION = "true";
    const { actions, states } = install("valido");
    const out = await runWorker();

    expect(out.content).toContain("tres datos reunidos");
    expect(actions.length).toBe(4);
    expect(states.length).toBe(3);

    // La primera llamada es la tarea; las siguientes, tarea + estado, sin herramientas ni resultados.
    const sizes = actions.map((a) => a.messages.length);
    expect(sizes[1]).toBe(sizes[2]!);
    expect(sizes[2]).toBe(sizes[3]!);
    expect(sizes[3]!).toBe(sizes[0]! + 1);
    for (const a of actions.slice(1)) {
      expect(a.messages.some((m) => m.role === "tool")).toBe(false);
      expect(a.messages.some((m) => m.tool_calls?.length)).toBe(false);
      expect(text(a.messages[a.messages.length - 1]!)).toContain("ESTADO ACTUAL DE LA TAREA");
    }
  }, 60_000);

  test("el estado se arrastra: la llamada n+1 trae lo que dijo el destilador en la n", async () => {
    process.env.HIVE_SINGLE_ACTION = "true";
    const { actions } = install("valido");
    await runWorker();

    const last = (n: number) => text(actions[n]!.messages[actions[n]!.messages.length - 1]!);
    expect(last(1)).toContain("dato 1 obtenido");
    expect(last(2)).toContain("dato 2 obtenido");
    expect(last(3)).toContain("dato 3 obtenido");
    expect(last(3)).toContain("Reunir los tres datos");
  }, 60_000);

  test("el destilador recibe lo ocurrido: la llamada, su resultado y el estado anterior", async () => {
    process.env.HIVE_SINGLE_ACTION = "true";
    const { states } = install("valido");
    await runWorker();

    const prompt = (n: number) => text(states[n]!.messages[1]!);
    expect(prompt(0)).toContain("Tarea original:\nReúne los tres datos pedidos");
    expect(prompt(0)).toContain("[LLAMADA buscar]");
    expect(prompt(0)).toContain("dato-exacto-q1");
    expect(prompt(1)).toContain("dato 1 obtenido"); // estado anterior
    expect(prompt(1)).toContain("dato-exacto-q2");
    expect(prompt(1)).not.toContain("dato-exacto-q1"); // lo ya destilado no se repite
  }, 60_000);

  test("si el destilador falla no se recorta nada y el trabajo se completa igual", async () => {
    process.env.HIVE_SINGLE_ACTION = "true";
    const { actions, states } = install("invalido");
    const out = await runWorker();

    expect(out.content).toContain("tres datos reunidos");
    expect(states.length).toBe(3); // lo intentó en cada paso
    // El historial se conservó: la última llamada ve las tres herramientas.
    expect(actions[3]!.messages.filter((m) => m.role === "tool").length).toBe(3);
    expect(actions.every((a) => !a.messages.some((m) => text(m).includes("ESTADO ACTUAL DE LA TAREA")))).toBe(true);
  }, 60_000);

  test("fuera de un worker (chat normal) no hace nada aunque esté encendido", async () => {
    process.env.HIVE_SINGLE_ACTION = "true";
    resetJevStatus();
    const { actions, states } = install("valido");
    const agent = await createAgent({ name: `chat_sa_${++counter}`, provider: "openai", model: "gpt-5.6-luna", tools: [buscar], seed: "minimal", browser: false, oracle: false, maxIterations: 8 });
    for await (const _ of agent.chat("Reúne los tres datos", { threadId: `t-chat-sa-${counter}` })) { /* consumir */ }

    expect(states.length).toBe(0);
    expect(actions[actions.length - 1]!.messages.filter((m) => m.role === "tool").length).toBe(3);
  }, 60_000);
});
