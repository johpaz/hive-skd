/**
 * Tool escrita como texto: `buscar_x(query="…")` en lugar de una llamada
 * estructurada. Fixture real del banco contra Qwen3.6 en el laboratorio.
 */

import { afterEach, describe, expect, test, beforeAll, afterAll } from "bun:test";
import { extractFunctionStyleCall, type KnownTool } from "../packages/core/src/agent/llm-providers/text-tool-calls";
import { HiveAgentsProvider } from "../packages/core/src/agent/llm-providers/hiveagents";

// Estas pruebas simulan un servidor con respuestas JSON sin streaming: el
// streaming interno hacia servidores remotos se apaga mientras corren (el
// entorno es del proceso, así que se restaura al terminar).
const previousStream = process.env.HIVE_LLM_STREAM;
beforeAll(() => { process.env.HIVE_LLM_STREAM = "0"; });
afterAll(() => { if (previousStream === undefined) delete process.env.HIVE_LLM_STREAM; else process.env.HIVE_LLM_STREAM = previousStream; });

const known = new Map<string, KnownTool>([
  ["buscar_conocimiento_sitio", { parameters: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] } }],
  ["sumar", { parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }],
]);

const argsOf = (r: ReturnType<typeof extractFunctionStyleCall>) => JSON.parse(r.tool_calls[0]!.function.arguments);

describe("extractFunctionStyleCall", () => {
  test("el caso real: nombre de argumento inventado, texto después de la llamada", () => {
    const text = 'buscar_conocimiento_sitio(query="cómo evita un agente quedarse atascado repitiendo lo mismo")\nNo tengo eso documentado.';
    const result = extractFunctionStyleCall(text, known);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]!.function.name).toBe("buscar_conocimiento_sitio");
    // `query` no existe; la tool tiene un solo parámetro y el valor es claramente para él.
    expect(argsOf(result)).toEqual({ consulta: "cómo evita un agente quedarse atascado repitiendo lo mismo" });
    expect(result.content).toBe("No tengo eso documentado.");
  });

  test("si el argumento ya se llama como el parámetro, no se renombra", () => {
    expect(argsOf(extractFunctionStyleCall('buscar_conocimiento_sitio(consulta="hive")', known))).toEqual({ consulta: "hive" });
  });

  test("varios argumentos: números, booleanos y comas dentro de un texto", () => {
    expect(argsOf(extractFunctionStyleCall("sumar(a=2, b=40)", known))).toEqual({ a: 2, b: 40 });
    expect(argsOf(extractFunctionStyleCall('buscar_conocimiento_sitio(consulta="uno, dos (tres)")', known))).toEqual({ consulta: "uno, dos (tres)" });
  });

  test("con varios parámetros no se adivina el nombre", () => {
    expect(argsOf(extractFunctionStyleCall("sumar(x=1)", known))).toEqual({ x: 1 });
  });

  test("argumentos como objeto JSON", () => {
    expect(argsOf(extractFunctionStyleCall('sumar({"a": 1, "b": 2})', known))).toEqual({ a: 1, b: 2 });
  });

  test("comillas escapadas dentro del valor", () => {
    expect(argsOf(extractFunctionStyleCall('buscar_conocimiento_sitio(consulta="dijo \\"hola\\"")', known))).toEqual({ consulta: 'dijo "hola"' });
  });

  test("una función que no se ofreció no se toca", () => {
    const text = 'borrar_todo(path="/")';
    expect(extractFunctionStyleCall(text, known)).toEqual({ content: text, tool_calls: [] });
  });

  test("una mención en medio de una frase no es una llamada", () => {
    const text = 'Puedes usar sumar(a=1, b=2) para sumar.';
    expect(extractFunctionStyleCall(text, known).tool_calls).toEqual([]);
  });

  test("una llamada sin cerrar o con argumentos que no se entienden se deja como está", () => {
    expect(extractFunctionStyleCall('buscar_conocimiento_sitio(consulta="x"', known).tool_calls).toEqual([]);
    expect(extractFunctionStyleCall("sumar(1, 2)", known).tool_calls).toEqual([]);
  });
});

describe("a través del proveedor", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const reply = (content: string) => {
    globalThis.fetch = (async () => Response.json({
      id: "c", object: "chat.completion", created: 1, model: "local",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })) as unknown as typeof fetch;
  };
  const call = () => new HiveAgentsProvider().call({
    provider: "hiveagents", model: "hiveagents/local", apiKey: "k", baseUrl: "https://llm.invalido/v1",
    messages: [{ role: "user", content: "hola" }],
    tools: [{ type: "function", function: { name: "buscar_conocimiento_sitio", description: "Busca", parameters: known.get("buscar_conocimiento_sitio")!.parameters! } }],
  } as never);

  test("la respuesta con la tool como texto se convierte en una llamada estructurada", async () => {
    reply('buscar_conocimiento_sitio(query="hive sdk")');
    const response = await call();
    expect(response.tool_calls?.[0]?.function.name).toBe("buscar_conocimiento_sitio");
    expect(JSON.parse(response.tool_calls![0]!.function.arguments)).toEqual({ consulta: "hive sdk" });
    expect(response.content).toBe("");
  });

  test("una respuesta normal queda intacta", async () => {
    reply("Hive SDK es una capa para construir agentes.");
    const response = await call();
    expect(response.tool_calls).toBeUndefined();
    expect(response.content).toBe("Hive SDK es una capa para construir agentes.");
  });
});
