/**
 * Cuando el runtime ve que el oráculo se contradijo (lo que dijo no resistió lo que
 * pasó después), lo anota; tres seguidas y el oráculo se deja de lado un rato.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { askJev, getJevStatus, recordOracleAgreement, recordOracleOverruled, resetJevStatus } from "../packages/core/src/agent/jev-decisions";
import { TurnVerifier } from "../packages/core/src/agent/oracle-checks";
import type { LLMMessage } from "../packages/core/src/agent/llm-client";

const jev = { apiKey: "k", endpoint: "https://oracle.test/v1/systemone", model: "kev", verify: { tools: true } };
const realFetch = globalThis.fetch;
const choice = { q: { type: "choice" as const, instructions: "?", criteria: { a: "A", b: "B" } } };

beforeEach(async () => {
  closeHiveDb();
  await ensureHiveDb();
  resetJevStatus();
  globalThis.fetch = realFetch;
});
afterAll(() => { globalThis.fetch = realFetch; closeHiveDb(); });

describe("contador de contradicciones", () => {
  test("dos seguidas no bastan y un acuerdo las borra", async () => {
    expect(recordOracleOverruled("uno", jev)).toBe(false);
    expect(recordOracleOverruled("dos", jev)).toBe(false);
    recordOracleAgreement();
    expect(recordOracleOverruled("tres", jev)).toBe(false);
    expect(recordOracleOverruled("cuatro", jev)).toBe(false);
    expect((await getJevStatus(jev)).state).toBe("ready");
  });

  test("tres seguidas dejan al oráculo de lado: no se le pregunta y el estado lo dice", async () => {
    recordOracleOverruled("uno", jev);
    recordOracleOverruled("dos", jev);
    expect(recordOracleOverruled("tres", jev)).toBe(true);
    let calls = 0;
    const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    expect(await askJev("s", choice, { fetcher, jev })).toBeNull();
    expect(calls).toBe(0);
    const status = await getJevStatus(jev);
    expect(status.state).toBe("fallback");
    expect(status.lastError).toContain("3 contradictions");
    resetJevStatus(jev);
    expect((await getJevStatus(jev)).state).toBe("ready");
  });
});

function verifier(published: string[]) {
  return new TurnVerifier({
    jev,
    objective: "¿Qué es Hive SDK?",
    agent: { name: "a", role: "worker" },
    publish: async (d) => { published.push(`${d.kind}:${d.summary}`); },
  });
}

describe("TurnVerifier", () => {
  const call = (id: string) => ({ id, type: "function" as const, function: { name: "buscar", arguments: { consulta: "x" } } });
  const history = (): LLMMessage[] => [
    { role: "user", content: "q" },
    { role: "assistant", content: "", tool_calls: [call("a")] },
    { role: "tool", name: "buscar", content: "resultado", tool_call_id: "a" },
  ];

  test("pedir de nuevo un resultado que el oráculo omitió cuenta como contradicción", async () => {
    const published: string[] = [];
    const v = verifier(published);
    await v.start();
    for (let i = 0; i < 3; i++) {
      v.noteIteration({ action: "continue", omittedIds: [2] }, history());
      await v.noteToolCalls([call("b")]);
    }
    expect(published.filter((p) => p.startsWith("overruled:"))).toHaveLength(3);
    expect((await getJevStatus(jev)).state).toBe("fallback");
  });

  test("pedir otra cosa no cuenta", async () => {
    const published: string[] = [];
    const v = verifier(published);
    await v.start();
    v.noteIteration({ action: "continue", omittedIds: [2] }, history());
    await v.noteToolCalls([{ function: { name: "buscar", arguments: { consulta: "otra cosa" } } }]);
    expect(published).toHaveLength(0);
  });

  test("aconsejar terminar y que la respuesta no tenga respaldo cuenta como contradicción", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const questions = JSON.parse(String(init?.body)).questions;
      return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { choice: "no_cumple", probabilities: { no_cumple: 0.95 } }])) });
    }) as unknown as typeof fetch;
    const published: string[] = [];
    const v = verifier(published);
    await v.start();
    v.collect("buscar", "Hive SDK es un framework");
    v.noteIteration({ action: "finish", omittedIds: [] }, history());
    const rewrite = await v.checkAnswer("No tengo eso documentado.");
    expect(rewrite).toContain("[Verificación]");
    expect(published.some((p) => p.startsWith("overruled:"))).toBe(true);
  });
});

describe("isEmptyResult", () => {
  test("reconoce lo vacío de las tools y no confunde lo que tiene contenido", async () => {
    const { isEmptyResult } = await import("../packages/core/src/agent/oracle-checks");
    expect(isEmptyResult("")).toBe(true);
    expect(isEmptyResult("[]")).toBe(true);
    expect(isEmptyResult("resultados: items[0]:\n")).toBe(true);
    expect(isEmptyResult("resultados: items[0]:\n\nnota: Sin documentos sobre eso.")).toBe(true);
    expect(isEmptyResult("resultados: items[1]{fuente,texto}:\n  Doc,Hive SDK es un framework")).toBe(false);
    expect(isEmptyResult("nota: Sin documentos sobre eso.")).toBe(false);
  });
});
