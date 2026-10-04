/**
 * El coordinador se entera de si el oráculo respaldó lo que entregó el especialista.
 * Modelos y oráculo simulados: se comprueba qué llega al coordinador, no la calidad del modelo.
 */

process.env.HIVE_DB_PATH = ":memory:";
process.env.HIVE_LLM_STREAM = "0";
process.env.OPENAI_API_KEY = "llave-de-prueba";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createAgent } from "../packages/core/src/api/index";
import { defineTool } from "../packages/core/src/tools/ToolRegistry";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { resetJevStatus } from "../packages/core/src/agent/jev-decisions";
import { describeVerification } from "../packages/core/src/agent/oracle-checks";

const realFetch = globalThis.fetch;
const ORACLE = "https://oracle.test/v1/systemone";

describe("describeVerification", () => {
  test("sin nada que decir, el coordinador no ve nada", () => {
    expect(describeVerification(null)).toBeNull();
    expect(describeVerification({ corrections: 0, unsatisfied: false })).toBeNull();
  });
  test("el oráculo no respaldó la entrega: se lo dice al coordinador, para que no la afirme como cierta", () => {
    const v = describeVerification({ corrections: 2, unsatisfied: true });
    expect(v).toMatchObject({ status: "unsupported", corrections: 2 });
    expect(v?.note).toContain("No la presentes como un hecho comprobado");
  });
  test("lo corregido y respaldado se anota sin pedir que se mencione", () => {
    const v = describeVerification({ corrections: 1, unsatisfied: false });
    expect(v).toMatchObject({ status: "corrected" });
    expect(v?.note).toContain("No hace falta mencionarlo");
  });
});

const buscar = defineTool({
  name: "buscar",
  description: "Busca en la base documental",
  parameters: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] },
  execute: async () => ({ resultados: [{ fuente: "Doc", texto: "Hive SDK es un framework para agentes." }] }),
});

type Step = { tool: string; args: Record<string, unknown> } | string;

/** Los modelos responden en orden, sea cual sea el agente que llame: coordinador y worker se turnan. */
function install(steps: Step[], grounded: "cumple" | "no_cumple") {
  const modelRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === ORACLE) {
      return Response.json({
        answers: Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([name, q]) => [
          name,
          name === "grounded"
            ? { choice: grounded, probabilities: { [grounded]: 0.95 } }
            : q.type === "choice" ? { choice: Object.keys(q.criteria)[0], probabilities: {} } : { noul: 0.9 },
        ])),
      });
    }
    modelRequests.push(body);
    const step = steps[call++] ?? "respuesta final";
    const message = typeof step === "string"
      ? { role: "assistant", content: step }
      : { role: "assistant", content: null, tool_calls: [{ id: `call_${call}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] };
    return Response.json({
      id: "c", object: "chat.completion", created: 1, model: "m",
      choices: [{ index: 0, message, finish_reason: typeof step === "string" ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    });
  }) as unknown as typeof fetch;
  return modelRequests;
}

let counter = 0;
async function delegate(grounded: "cumple" | "no_cumple", maxCorrections: number) {
  resetJevStatus();
  const n = ++counter;
  const requests = install([
    { tool: "task_delegate", args: { worker_id: `investigador_${n}`, task_description: "¿Qué es Hive SDK?", mode: "sync" } },
    { tool: "buscar", args: { consulta: "hive sdk" } },
    "No tengo eso documentado.",
    "Respuesta del coordinador.",
  ], grounded);
  await createAgent({ name: `investigador_${n}`, provider: "openai", model: "gpt-5.6-luna", tools: [buscar], seed: "minimal", browser: false, oracle: false });
  const jefe = await createAgent({ name: `jefe_${n}`, provider: "openai", model: "gpt-5.6-luna", seed: "minimal", browser: false, maxIterations: 4 });
  let done: any;
  for await (const event of jefe.chat("¿Qué es Hive SDK?", {
    threadId: `t-deleg-${n}`,
    oracle: { apiKey: "k", endpoint: ORACLE, model: "kev", verify: { maxCorrections } },
  })) if (event.type === "done") done = event;
  const toolMessages = requests.flatMap((r) => r.messages).filter((m) => m.role === "tool").map((m) => String(m.content));
  return { done, delegated: toolMessages.find((m) => m.includes("worker_id") || m.includes("investigador")) ?? "" };
}

afterEach(() => { globalThis.fetch = realFetch; });
afterAll(() => { globalThis.fetch = realFetch; closeHiveDb(); });

describe("task_delegate (sync) con oráculo", () => {
  test("si el oráculo no respaldó la entrega del especialista, el coordinador recibe el aviso", async () => {
    const { delegated } = await delegate("no_cumple", 0);
    expect(delegated).toContain("unsupported");
    expect(delegated).toContain("No la presentes como un hecho comprobado");
  });

  test("si el oráculo respaldó la entrega, el resultado no trae ningún aviso", async () => {
    const { delegated } = await delegate("cumple", 2);
    expect(delegated).not.toContain("verification");
    expect(delegated).not.toContain("unsupported");
  });
});
