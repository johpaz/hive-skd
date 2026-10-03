/**
 * Jev dentro de `runAgent`: lo que ve un host que maneja el loop él mismo.
 *
 * hive-cloud no se suscribe al canvas; recibe cada decisión por `onStep` como
 * `jev_decision`. Y con `jev: false` —un workspace sin OpenRouter— el turno
 * corre igual que antes, sin una sola llamada a la API de decisiones.
 *
 * La red se intercepta en `fetch`: no sale nada.
 */

process.env.HIVE_DB_PATH = ":memory:";


import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runAgent, type StepEvent } from "../packages/core/src/agent/agent-loop";
import { col, toIndexable } from "../packages/core/src/storage/hive";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import type { AgentDoc, ModelDoc, ProviderDoc } from "../packages/core/src/storage/collections";

// Estas pruebas simulan un servidor con respuestas JSON sin streaming: el
// streaming interno hacia servidores remotos se apaga mientras corren (el
// entorno es del proceso, así que se restaura al terminar).
const previousStream = process.env.HIVE_LLM_STREAM;
beforeAll(() => { process.env.HIVE_LLM_STREAM = "0"; });
afterAll(() => { if (previousStream === undefined) delete process.env.HIVE_LLM_STREAM; else process.env.HIVE_LLM_STREAM = previousStream; });

const DECISIONS = "https://openrouter.ai/api/alpha/decisions";
const realFetch = globalThis.fetch;
const decisionRequests: Array<{ authorization: string | null; body: any }> = [];

const completion = (content: string) => ({
  id: "cmpl-test",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: "modelo-jev",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

beforeAll(async () => {
  closeHiveDb();
  await ensureHiveDb();
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url === DECISIONS) {
      const body = await request.clone().json();
      decisionRequests.push({ authorization: request.headers.get("authorization"), body });
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id,
        (q as { type: string }).type === "choice"
          ? { type: "choice", choice: "coordinator", confidence: 0.9, probabilities: { coordinator: 0.9 } }
          : { type: "noul", noul: 0.1 }]));
      return Response.json({ answers, usage: { input_tokens: 50, output_tokens: 0, cost: 0.000002 } });
    }
    return new Response(JSON.stringify(completion("Listo")), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  await (await col<ProviderDoc>("providers")).put("openai", {
    id: "openai", name: "OpenAI", base_url: "https://proveedor.invalido/v1", category: "llm",
    num_ctx: null, num_gpu: 0, enabled: true, active: true, created_at: Date.now(),
  });
  await (await col<ModelDoc>("models")).put("modelo-jev", {
    id: "modelo-jev", provider_id: "openai", name: "modelo-jev", model_type: "llm",
    context_window: 128_000, capabilities: null, enabled: true, active: true,
  } as ModelDoc);
  await (await col<AgentDoc>("agents")).put("coord-jev", {
    id: "coord-jev", user_id: "u", name: "Coordinador", description: "coordina", system_prompt: "Eres un coordinador.",
    tone: null, role: "coordinator", status: "idle", enabled: true,
    provider_id: toIndexable("openai"), model_id: toIndexable("modelo-jev"), tools_json: null, skills_json: null,
    parent_id: toIndexable(null), max_iterations: 3, workspace: null, lastTraceAt: null, created_at: 1, updated_at: 1,
  } as unknown as AgentDoc);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  closeHiveDb();
});

beforeEach(() => { decisionRequests.length = 0; });

async function runTurn(jev: { apiKey: string } | false): Promise<StepEvent[]> {
  const steps: StepEvent[] = [];
  for await (const _ of runAgent({
    agentId: "coord-jev",
    threadId: `hilo-${crypto.randomUUID()}`,
    userMessage: "Hola, ¿qué puedes hacer?",
    credentials: { apiKey: "llave-del-modelo", baseUrl: "https://proveedor.invalido/v1" },
    jev,
    onStep: async (step) => { steps.push(step); },
  })) { /* drain */ }
  return steps;
}

describe("Jev en runAgent", () => {
  test("jev: false — el turno corre sin ninguna llamada a decisiones", async () => {
    const steps = await runTurn(false);
    expect(decisionRequests).toHaveLength(0);
    expect(steps.some(s => s.type === "jev_decision")).toBe(false);
    expect(steps.some(s => s.type === "text" && s.message === "Listo")).toBe(true);
  });

  test("jev: { apiKey } — la decisión de contexto llega por onStep, con la llave del inquilino", async () => {
    const steps = await runTurn({ apiKey: "llave-openrouter-del-workspace" });
    expect(decisionRequests.length).toBeGreaterThan(0);
    expect(decisionRequests[0]!.authorization).toBe("Bearer llave-openrouter-del-workspace");
    const decision = steps.find(s => s.type === "jev_decision");
    expect(decision?.jev).toMatchObject({ agentId: "coord-jev", kind: "context", recommendedAgentId: null, mcpOff: [] });
    expect(decision?.jev?.costUsd).toBeCloseTo(0.000002, 10);
    expect(decision?.message).toContain("herramientas");
  });
});
