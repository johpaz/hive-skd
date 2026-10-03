/**
 * Afinado de Jev: lo que se agregó para que decida con conocimiento del agente
 * y para que el razonamiento del modelo dependa de la tarea.
 *
 *  - las herramientas declaradas por un agente (allowlist) nunca se podan;
 *  - Jev recibe quién es el agente (`state.agent`);
 *  - `effort`/`length`: solo se preguntan con `thinking: "auto"`, y `direct`
 *    exige confianza alta (equivocarse al no razonar cuesta calidad; al razonar
 *    de más, solo tiempo);
 *  - `thinking` del agente: "on" (defecto) / "off" / "auto" → `compileContext().thinking`;
 *  - `jevRoute` elige especialista con una pregunta cerrada y devuelve `null`
 *    cuando no hay decisión, para que el llamador use su propio enrutamiento.
 *
 * La red se intercepta en `fetch`: no sale nada.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { col, toIndexable } from "../packages/core/src/storage/hive";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { compileContext } from "../packages/core/src/agent/context-compiler";
import { jevRoute, jevWantsParallel, planJevContext, planJevIteration } from "../packages/core/src/agent/jev-planner";
import { askJev, resetJevStatus } from "../packages/core/src/agent/jev-decisions";
import type { AgentDoc, ModelDoc, ProviderDoc } from "../packages/core/src/storage/collections";

const DECISIONS = "https://openrouter.ai/api/alpha/decisions";
const realFetch = globalThis.fetch;
const requests: Array<{ state: any; questions: Record<string, any> }> = [];

/** Respuestas que el "Jev" falso devuelve; cada prueba las reemplaza. */
let noul = 0.01;
let effort: { choice: string; confidence: number } = { choice: "direct", confidence: 0.9 };
let route: { choice: string; confidence: number } = { choice: "procesos", confidence: 0.9 };

const KEY = { apiKey: "llave-de-prueba" };

beforeAll(async () => {
  closeHiveDb();
  await ensureHiveDb();
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url !== DECISIONS) return new Response("{}", { status: 404 });
    const body = await request.clone().json();
    requests.push({ state: body.state, questions: body.questions });
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => {
      if (q.type !== "choice") return [id, { type: "noul", noul }];
      if (id === "effort") return [id, { type: "choice", ...effort, probabilities: {} }];
      if (id === "route") return [id, { type: "choice", ...route, probabilities: {} }];
      if (id === "length") return [id, { type: "choice", choice: "brief", confidence: 0.9, probabilities: {} }];
      return [id, { type: "choice", choice: "coordinator", confidence: 0.9, probabilities: {} }];
    }));
    return Response.json({ answers, usage: { input_tokens: 10, output_tokens: 0, cost: 0.000001 } });
  }) as typeof fetch;

  await (await col<ProviderDoc>("providers")).put("openai", {
    id: "openai", name: "OpenAI", base_url: "https://proveedor.invalido/v1", category: "llm",
    num_ctx: null, num_gpu: 0, enabled: true, active: true, created_at: Date.now(),
  });
  await (await col<ModelDoc>("models")).put("modelo-jev", {
    id: "modelo-jev", provider_id: "openai", name: "modelo-jev", model_type: "llm",
    context_window: 128_000, capabilities: null, enabled: true, active: true,
  } as ModelDoc);

  const agents = await col<AgentDoc>("agents");
  const base = {
    user_id: "u", description: "Responde sobre lo publicado", tone: null, role: "worker" as const, status: "idle", enabled: true,
    provider_id: toIndexable("openai"), model_id: toIndexable("modelo-jev"), tools_json: null, skills_json: null,
    parent_id: toIndexable(null), max_iterations: 3, workspace: null, lastTraceAt: null, created_at: 1, updated_at: 1,
  };
  for (const [id, thinking, cap] of [["a-on", undefined, null], ["a-off", "off", null], ["a-auto", "auto", null], ["a-cap", "off", 300]] as const) {
    await agents.put(id, {
      ...base, id, name: id, system_prompt: "Siempre busca antes de responder.", thinking, max_output_tokens: cap,
      // Allowlist declarada: es el contrato del agente.
      tool_allowlist_json: JSON.stringify(["fs_read"]),
    } as unknown as AgentDoc);
  }
});

afterAll(() => {
  globalThis.fetch = realFetch;
  closeHiveDb();
});

beforeEach(() => {
  requests.length = 0;
  noul = 0.01;
  effort = { choice: "direct", confidence: 0.9 };
  route = { choice: "procesos", confidence: 0.9 };
  resetJevStatus();
});

const compile = (agentId: string, jev: typeof KEY | false = KEY) =>
  compileContext({ agentId, threadId: `h-${crypto.randomUUID()}`, userMessage: "¿Cómo evita un agente repetirse?", isolated: true, jev });

describe("herramientas declaradas", () => {
  test("Jev no pregunta por ellas y no las poda aunque diga 'no hacen falta'", async () => {
    const ctx = await compile("a-on");
    expect(ctx.tools.map(t => t.function.name)).toContain("fs_read");
    const asked = requests.flatMap(r => Object.keys(r.questions));
    expect(asked).not.toContain("tool_fs_read");
  });

  test("las descubiertas (sin allowlist) siguen siendo podables", async () => {
    const tool = { type: "function" as const, function: { name: "web_search", description: "Search the web", parameters: { type: "object" } } };
    const plan = await planJevContext({
      objective: "hola", messages: [], tools: [tool],
      allTools: [{ name: "web_search", description: "Search the web", parameters: { type: "object" } }],
      skills: [], isWorker: true, jev: KEY,
    });
    expect(plan?.tools.map(t => t.function.name)).not.toContain("web_search");
  });

  test("las declaradas se conservan en planJevContext aunque Jev responda 0", async () => {
    const tool = { type: "function" as const, function: { name: "buscar", description: "Busca", parameters: { type: "object" } } };
    const plan = await planJevContext({
      objective: "pregunta conceptual", messages: [], tools: [tool],
      allTools: [{ name: "buscar", description: "Busca", parameters: { type: "object" } }],
      skills: [], isWorker: true, curatedTools: new Set(["buscar"]), jev: KEY,
    });
    // Sin nada más que preguntar no hay decisión (null) y el compilador conserva
    // el loadout tal cual; con decisión, la declarada sigue ahí.
    expect(plan ? plan.tools.map(t => t.function.name) : ["buscar"]).toEqual(["buscar"]);
    const asked = requests.flatMap(r => Object.keys(r.questions));
    expect(asked).not.toContain("tool_buscar");
  });
});

describe("Jev conoce al agente", () => {
  test("state.agent lleva nombre, rol, descripción e instrucciones, y las preguntas lo mencionan", async () => {
    await compile("a-on");
    const request = requests.at(-1)!;
    expect(request.state.agent).toMatchObject({ name: "a-on", role: "worker", description: "Responde sobre lo publicado", instructions: "Siempre busca antes de responder." });
    const questions = Object.values(request.questions).map(q => q.instructions as string);
    expect(questions.some(q => q.includes("state.agent"))).toBe(true);
  });
});

describe("razonamiento (thinking)", () => {
  test("sin configurar es 'on': razona, como siempre", async () => {
    expect((await compile("a-on")).thinking).toBe(true);
  });

  test("'off' nunca razona y Jev no pregunta por esfuerzo", async () => {
    expect((await compile("a-off")).thinking).toBe(false);
    expect(Object.keys(requests.at(-1)!.questions)).not.toContain("effort");
  });

  test("'on' ignora lo que diga Jev sobre el esfuerzo", async () => {
    effort = { choice: "direct", confidence: 0.99 };
    expect((await compile("a-on")).thinking).toBe(true);
    expect(Object.keys(requests.at(-1)!.questions)).not.toContain("effort");
  });

  test("'auto' + direct con confianza alta: no razona", async () => {
    const ctx = await compile("a-auto");
    expect(ctx.thinking).toBe(false);
    expect(ctx.jevDecision).toMatchObject({ effort: "direct", length: "brief" });
  });

  test("'auto' + direct con confianza baja: razona (conservador)", async () => {
    effort = { choice: "direct", confidence: 0.5 };
    const ctx = await compile("a-auto");
    expect(ctx.thinking).toBe(true);
    expect(ctx.jevDecision?.effort).toBe("reason");
  });

  test("'auto' + reason: razona", async () => {
    effort = { choice: "reason", confidence: 0.95 };
    expect((await compile("a-auto")).thinking).toBe(true);
  });

  test("'auto' sin Jev se comporta como 'on' y no llama a OpenRouter", async () => {
    expect((await compile("a-auto", false)).thinking).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test("la longitud decidida por Jev llega al system prompt", async () => {
    const ctx = await compile("a-auto");
    expect(ctx.systemPrompt).toContain("# LONGITUD DE LA RESPUESTA");
    expect(ctx.systemPrompt).toContain("pocas frases");
  });

  test("sin 'auto' no hay sección de longitud", async () => {
    expect((await compile("a-on")).systemPrompt).not.toContain("# LONGITUD DE LA RESPUESTA");
  });
});

describe("tope de tokens de salida", () => {
  test("el del agente llega al compilador", async () => {
    expect((await compile("a-cap")).maxOutputTokens).toBe(300);
  });

  test("sin tope del agente ni de Jev, el del proveedor (undefined)", async () => {
    expect((await compile("a-on")).maxOutputTokens).toBeUndefined();
  });

  test("'auto' + direct + respuesta breve: Jev acota la salida (el modelo no razona)", async () => {
    const ctx = await compile("a-auto");
    expect(ctx.thinking).toBe(false);
    expect(ctx.maxOutputTokens).toBe(512);
  });

  test("si el modelo razona no se acota por longitud: los tokens de razonamiento cuentan", async () => {
    effort = { choice: "reason", confidence: 0.95 };
    const ctx = await compile("a-auto");
    expect(ctx.thinking).toBe(true);
    expect(ctx.maxOutputTokens).toBeUndefined();
  });
});

describe("jevRoute", () => {
  const candidates = [
    { id: "sitio", description: "Responde sobre lo publicado", tools: ["buscar_conocimiento_sitio"] },
    { id: "procesos", description: "Propone cómo automatizar un proceso de negocio" },
  ];

  test("devuelve el especialista elegido con su confianza", async () => {
    const result = await jevRoute("mi distribuidora cruza facturas a mano", candidates, { jev: KEY });
    expect(result).toMatchObject({ choice: "procesos", confidence: 0.9 });
    const question = requests.at(-1)!.questions.route;
    expect(Object.keys(question.criteria)).toEqual(["sitio", "procesos"]);
  });

  test("por debajo de la confianza mínima no decide", async () => {
    route = { choice: "procesos", confidence: 0.6 };
    expect(await jevRoute("algo ambiguo", candidates, { jev: KEY })).toBeNull();
  });

  test("con jev:false no hace ninguna llamada", async () => {
    expect(await jevRoute("x", candidates, { jev: false })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test("con un solo candidato o ninguno no hay nada que decidir", async () => {
    expect(await jevRoute("x", [candidates[0]!], { jev: KEY })).toBeNull();
    expect(await jevRoute("x", [], { jev: KEY })).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

describe("modelo de decisión propio (endpoint configurable)", () => {
  const LOCAL = "http://127.0.0.1:8090/v1/systemone";
  const ask = (answers: Record<string, unknown>, jev: object) => {
    const calls: Array<{ url: string; body: any; auth: string | null }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ answers });
    }) as unknown as typeof fetch;
    return askJev(
      { text: "factura duplicada" },
      { route: { type: "choice", instructions: "Quién", criteria: { billing: "pagos", shipping: "envíos" } }, urgent: { type: "noul", instructions: "¿Urge?" } },
      { fetcher, jev: jev as never },
    ).then(result => ({ result, calls }));
  };

  test("usa el endpoint y el modelo configurados, no los de OpenRouter", async () => {
    const { calls } = await ask(
      { route: { choice: "billing", probabilities: { billing: 0.9, shipping: 0.1 } }, urgent: { noul: 0.2 } },
      { apiKey: "local", endpoint: LOCAL, model: "Kev-4B" },
    );
    expect(calls[0]).toMatchObject({ url: LOCAL, auth: "Bearer local" });
    expect(calls[0]!.body.model).toBe("Kev-4B");
  });

  test("entiende la respuesta de llama.cpp: la confianza es la probabilidad de la opción", async () => {
    const { result } = await ask(
      { route: { choice: "billing", probabilities: { billing: 0.9049, shipping: 0.0275 } }, urgent: { probability: 0.3 } },
      { apiKey: "local", endpoint: LOCAL },
    );
    expect(result?.answers.route).toMatchObject({ type: "choice", choice: "billing", confidence: 0.9049 });
    expect(result?.answers.urgent).toEqual({ type: "noul", noul: 0.3 });
  });

  test("un modelo propio no tiene costo ni se registra con la tarifa de OpenRouter", async () => {
    const { result } = await ask(
      { route: { choice: "billing", probabilities: { billing: 0.9 } }, urgent: { noul: 0.2 } },
      { apiKey: "local", endpoint: LOCAL },
    );
    expect(result?.costUsd).toBe(0);
  });

  test("una opción que no existe sigue siendo inválida", async () => {
    const { result } = await ask(
      { route: { choice: "refunds", probabilities: { refunds: 0.9 } }, urgent: { noul: 0.2 } },
      { apiKey: "local", endpoint: LOCAL },
    );
    expect(result).toBeNull();
  });
});

describe("privacidad: qué viaja al modelo de decisión (share)", () => {
  const history = [
    { role: "user" as const, content: "tema viejo: facturas de 2024" },
    { role: "assistant" as const, content: "respuesta vieja sobre facturas" },
    { role: "user" as const, content: "tema anterior" },
    { role: "assistant" as const, content: "respuesta anterior" },
    { role: "user" as const, content: "pregunta actual" },
    { role: "assistant" as const, content: "ok" },
  ];
  const agent = { name: "sitio", role: "worker", description: "Responde", instructions: "Instrucciones internas del agente: no divulgar" };
  const plan = (share?: object) => planJevContext({
    objective: "pregunta actual", messages: history, tools: [], allTools: [], skills: [], isWorker: true, agent,
    jev: { apiKey: "k", ...(share ? { share } : {}) } as never,
  });
  const sent = () => JSON.stringify(requests.at(-1)!.state);

  test("por defecto viaja todo, como hasta ahora", async () => {
    await plan();
    expect(sent()).toContain("Instrucciones internas del agente");
    expect(sent()).toContain("facturas de 2024");
  });

  test("instructions:false no envía el extracto del system prompt, pero sí quién es el agente", async () => {
    await plan({ instructions: false });
    expect(sent()).not.toContain("Instrucciones internas del agente");
    expect(requests.at(-1)!.state.agent).toMatchObject({ name: "sitio", role: "worker", description: "Responde" });
    expect("instructions" in requests.at(-1)!.state.agent).toBe(false);
  });

  test("history:false: los mensajes anteriores no se envían ni se preguntan; sin otra cosa que decidir no sale ninguna petición", async () => {
    noul = 0.01; // si se preguntara por la historia, Jev diría "no hacen falta"
    const before = requests.length;
    const result = await plan({ history: false });
    // Sin historia que juzgar y sin tools/skills/notas/reglas, no hay nada que preguntar:
    // no viaja nada y el compilador conserva el contexto tal cual (null = sin decisión).
    expect(requests.length).toBe(before);
    expect(result).toBeNull();
  });

  test("history:false con algo más que decidir: se envía eso, nunca la historia, y se conservan todos los mensajes", async () => {
    noul = 0.01;
    const tool = { type: "function" as const, function: { name: "web_search", description: "Search", parameters: { type: "object" } } };
    const result = await planJevContext({
      objective: "pregunta actual", messages: history, tools: [tool],
      allTools: [{ name: "web_search", description: "Search", parameters: { type: "object" } }],
      skills: [], isWorker: true, agent, jev: { apiKey: "k", share: { history: false } },
    });
    expect(sent()).not.toContain("facturas de 2024");
    expect(Object.keys(requests.at(-1)!.questions).some((q) => q.startsWith("history_"))).toBe(false);
    expect(result?.messages).toHaveLength(history.length);
  });

  test("con history permitido, Jev sí puede podar lo que no hace falta", async () => {
    noul = 0.01;
    const result = await plan();
    expect(result!.messages.length).toBeLessThan(history.length);
  });

  test("toolResults:false: no hay decisión entre iteraciones ni de paralelismo, y no sale nada", async () => {
    const long = "x".repeat(2500);
    const messages = [
      { role: "user" as const, content: "pregunta" },
      { role: "tool" as const, content: long, name: "buscar", tool_call_id: "1" },
      { role: "tool" as const, content: long, name: "buscar", tool_call_id: "2" },
      { role: "tool" as const, content: "último", name: "buscar", tool_call_id: "3" },
    ] as never;
    const before = requests.length;
    const iteration = await planJevIteration({ objective: "pregunta", messages, tools: [], jev: { apiKey: "k", share: { toolResults: false } } });
    const parallel = await jevWantsParallel(
      [{ function: { name: "fs_read", arguments: { path: "/secreto" } } }, { function: { name: "fs_list", arguments: {} } }],
      { apiKey: "k", share: { toolResults: false } },
    );
    expect(iteration).toBeNull();
    expect(parallel).toBeNull();
    expect(requests.length).toBe(before);
  });

  test("con toolResults permitido (defecto) sí se consulta", async () => {
    const before = requests.length;
    await jevWantsParallel(
      [{ function: { name: "fs_read", arguments: { path: "/a" } } }, { function: { name: "fs_list", arguments: {} } }],
      { apiKey: "k" },
    );
    expect(requests.length).toBe(before + 1);
  });
});
