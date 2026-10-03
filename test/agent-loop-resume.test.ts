/**
 * Reanudar un run desde su checkpoint: el turno continúa con el historial
 * guardado, las tools que corrían al caerse el proceso entran como
 * `[interrupted]` (no se re-ejecutan) y el run termina `completed`.
 */

process.env.HIVE_DB_PATH = ":memory:";
process.env.HIVE_LLM_STREAM = "0";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { runAgent } from "../packages/core/src/agent/agent-loop";
import { checkpoint, createRun as createAgentRun, getRun } from "../packages/core/src/agent/run-store";
import { col, toIndexable } from "../packages/core/src/storage/hive";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import type { AgentDoc, ModelDoc, ProviderDoc } from "../packages/core/src/storage/collections";

const realFetch = globalThis.fetch;
let sent: any = null;

beforeAll(async () => {
  closeHiveDb();
  await ensureHiveDb();
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    sent = await request.json();
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Retomado y listo." } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await (await col<ProviderDoc>("providers")).put("openai", {
    id: "openai", name: "OpenAI", base_url: "https://proveedor.invalido/v1", category: "llm",
    num_ctx: null, num_gpu: 0, enabled: true, active: true, created_at: Date.now(),
  });
  await (await col<ModelDoc>("models")).put("modelo-resume", {
    id: "modelo-resume", provider_id: "openai", name: "modelo-resume", model_type: "llm",
    context_window: 128_000, capabilities: null, enabled: true, active: true,
  } as ModelDoc);
  await (await col<AgentDoc>("agents")).put("agente-resume", {
    id: "agente-resume", user_id: "u", name: "Resume", description: "x", system_prompt: "Eres un agente.",
    tone: null, role: "coordinator", status: "idle", enabled: true,
    provider_id: toIndexable("openai"), model_id: toIndexable("modelo-resume"), tools_json: null, skills_json: null,
    parent_id: toIndexable(null), max_iterations: 5, workspace: null, lastTraceAt: null, created_at: 1, updated_at: 1,
  } as unknown as AgentDoc);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  closeHiveDb();
});

test("resume restaura el historial, marca la tool pendiente como interrumpida y completa el run", async () => {
  const threadId = `hilo-${crypto.randomUUID()}`;
  const run = await createAgentRun({
    thread_id: threadId, agent_id: "agente-resume", user_id: "u", channel: null, kind: "chat",
    max_iterations: 5, resume_policy: "resume",
  } as any);
  await checkpoint(run.id, {
    version: 1,
    messages: [
      { role: "system", content: "Eres un agente." },
      { role: "user", content: "busca algo" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: { q: "x" } } }] },
    ],
    iterations: 2, totalInputTokens: 100, totalOutputTokens: 20,
    lastToolSignature: "", consecutiveRepeat: 0, idleIterations: 0,
    injectedToolNames: [], systemPromptSkillSections: [],
  } as any, [{ id: "call_1", type: "function", function: { name: "web_search", arguments: { q: "x" } } }]);

  const texts: string[] = [];
  let usage: any;
  for await (const chunk of runAgent({
    agentId: "agente-resume", threadId, userMessage: "busca algo", runId: run.id, resume: true, durable: true,
    credentials: { apiKey: "k", baseUrl: "https://proveedor.invalido/v1" }, jev: false,
  })) {
    for (const m of (chunk as any).agent?.messages ?? []) if (typeof m.content === "string") texts.push(m.content);
    if ((chunk as any).usage) usage = (chunk as any).usage;
  }

  const roles = sent.messages.map((m: any) => m.role);
  expect(roles).toEqual(["system", "user", "assistant", "tool"]);
  expect(sent.messages[3].content).toContain("[interrupted]");
  expect(sent.messages[3].tool_call_id).toBe("call_1");
  expect(texts.join(" ")).toContain("Retomado y listo.");
  // Los tokens y las iteraciones del checkpoint se suman a los de esta llamada.
  expect(usage.input_tokens).toBe(110);
  expect(usage.iterations).toBe(3);
  expect((await getRun(run.id))?.status).toBe("completed");
});
