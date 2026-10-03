/**
 * Al vencer el tope de una llamada al modelo, la petición se aborta.
 *
 * `withTimeout` solo deja de esperar. Sin abortar, el servidor sigue generando
 * para nadie: con un modelo local de un solo slot, las llamadas siguientes
 * esperan detrás de esa generación y también vencen (medido: tres timeouts de
 * 180 s seguidos con 0 tokens).
 */

process.env.HIVE_DB_PATH = ":memory:";
process.env.HIVE_LLM_CALL_TIMEOUT_MS = "300";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runAgent } from "../packages/core/src/agent/agent-loop";
import { col, toIndexable } from "../packages/core/src/storage/hive";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import type { AgentDoc, ModelDoc, ProviderDoc } from "../packages/core/src/storage/collections";

const realFetch = globalThis.fetch;
let aborted = false;
let started = false;

beforeAll(async () => {
  closeHiveDb();
  await ensureHiveDb();
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    started = true;
    // Un servidor lento: no responde hasta que el cliente se va.
    await new Promise<void>((resolve) => {
      if (request.signal.aborted) { aborted = true; resolve(); return; }
      request.signal.addEventListener("abort", () => { aborted = true; resolve(); });
      setTimeout(resolve, 5000);
    });
    return new Response("{}", { status: 499 });
  }) as typeof fetch;

  await (await col<ProviderDoc>("providers")).put("openai", {
    id: "openai", name: "OpenAI", base_url: "https://proveedor.invalido/v1", category: "llm",
    num_ctx: null, num_gpu: 0, enabled: true, active: true, created_at: Date.now(),
  });
  await (await col<ModelDoc>("models")).put("modelo-lento", {
    id: "modelo-lento", provider_id: "openai", name: "modelo-lento", model_type: "llm",
    context_window: 128_000, capabilities: null, enabled: true, active: true,
  } as ModelDoc);
  await (await col<AgentDoc>("agents")).put("agente-lento", {
    id: "agente-lento", user_id: "u", name: "Lento", description: "x", system_prompt: "Eres lento.",
    tone: null, role: "coordinator", status: "idle", enabled: true,
    provider_id: toIndexable("openai"), model_id: toIndexable("modelo-lento"), tools_json: null, skills_json: null,
    parent_id: toIndexable(null), max_iterations: 2, workspace: null, lastTraceAt: null, created_at: 1, updated_at: 1,
  } as unknown as AgentDoc);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  closeHiveDb();
});

describe("tope de la llamada al modelo", () => {
  test("al vencer, la petición HTTP se aborta y el turno responde con el aviso", async () => {
    const texts: string[] = [];
    const t0 = Date.now();
    for await (const chunk of runAgent({
      agentId: "agente-lento",
      threadId: `hilo-${crypto.randomUUID()}`,
      userMessage: "hola",
      credentials: { apiKey: "k", baseUrl: "https://proveedor.invalido/v1" },
      jev: false,
    })) {
      for (const m of (chunk as any).agent?.messages ?? []) if (typeof m.content === "string") texts.push(m.content);
    }
    expect(started).toBe(true);
    expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(texts.join(" ")).toContain("tardó demasiado");
  });
});
