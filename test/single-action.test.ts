/**
 * Modo de una acción por contexto (single-action.ts): activación, transcripción de lo ocurrido,
 * reinicio del contexto y, sobre todo, que un fallo NUNCA recorta el historial. Sin red: el modelo
 * entra como función.
 */

import { describe, test, expect } from "bun:test";
import type { LLMMessage, LLMResponse } from "../packages/core/src/agent/llm-client";
import type { Handoff } from "../packages/core/src/agent/handoff";
import {
  MAX_RESULT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  collapseMessages,
  renderActionTranscript,
  singleActionEnabled,
  stateMessage,
  updateTaskState,
} from "../packages/core/src/agent/single-action";

const state: Handoff = {
  objective: "Migrar la facturación",
  facts: ["API base: https://api.example/v2"],
  changes: [],
  verification: [],
  dead_ends: ["Basic auth falla con 401"],
  plan: ["Mapear impuestos", "Probar nota crédito"],
};

const ok = (h: Partial<Handoff>, usage = { input_tokens: 100, output_tokens: 40 }): LLMResponse => ({
  content: JSON.stringify({ ...state, ...h }),
  stop_reason: "stop",
  usage,
});

const action = (name: string, args: unknown, result: string, id = "c1"): LLMMessage[] => [
  { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
  { role: "tool", content: result, tool_call_id: id },
];

describe("singleActionEnabled", () => {
  const on = { agent: { context: { singleActionMode: true } } };

  test("solo en workers y con el flag encendido", () => {
    expect(singleActionEnabled({ isolated: true }, on)).toBe(true);
    expect(singleActionEnabled({ isolated: false }, on)).toBe(false);
    expect(singleActionEnabled({}, on)).toBe(false);
    expect(singleActionEnabled({ isolated: true }, {})).toBe(false);
    expect(singleActionEnabled({ isolated: true }, { agent: { context: { singleActionMode: false } } })).toBe(false);
  });
});

describe("renderActionTranscript", () => {
  test("incluye lo dicho, la herramienta llamada con sus argumentos y el resultado", () => {
    const t = renderActionTranscript([
      { role: "assistant", content: "Reviso el endpoint", tool_calls: [{ id: "a", type: "function", function: { name: "http_get", arguments: '{"url":"https://x.test"}' } }] },
      { role: "tool", content: "200 OK", tool_call_id: "a" },
    ]);
    expect(t).toContain("[ASISTENTE]: Reviso el endpoint");
    expect(t).toContain('[LLAMADA http_get]: {"url":"https://x.test"}');
    expect(t).toContain("[RESULTADO]: 200 OK");
  });

  test("rotula los avisos del sistema aparte, no como la persona", () => {
    const t = renderActionTranscript([{ role: "user", content: "ADVERTENCIA: sin progreso" }]);
    expect(t).toContain("[AVISO DEL SISTEMA]: ADVERTENCIA: sin progreso");
    expect(t).not.toContain("[USER]");
  });

  test("recorta un resultado largo conservando cabeza y cola", () => {
    const long = "INICIO" + "x".repeat(MAX_RESULT_CHARS * 3) + "FIN-ERROR";
    const t = renderActionTranscript(action("run", {}, long));
    expect(t).toContain("INICIO");
    expect(t).toContain("FIN-ERROR");
    expect(t).toContain("caracteres omitidos");
    expect(t.length).toBeLessThan(MAX_RESULT_CHARS + 400);
  });

  test("acota el total y se queda con lo más reciente", () => {
    const many = Array.from({ length: 40 }, (_, i) => action("run", {}, `resultado-${i} ` + "y".repeat(2000), `c${i}`)).flat();
    const t = renderActionTranscript(many);
    expect(t.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    expect(t).toContain("resultado-39");
    expect(t).not.toContain("resultado-0 ");
  });

  test("tolera contenido multimodal", () => {
    const t = renderActionTranscript([{ role: "tool", content: [{ type: "text", text: "hay una imagen" }, { type: "image_url", image_url: { url: "u" } }] }]);
    expect(t).toContain("hay una imagen");
    expect(t).toContain("[image_url]");
  });
});

describe("collapseMessages / stateMessage", () => {
  const base: LLMMessage[] = [
    { role: "system", content: "Eres un worker" },
    { role: "user", content: "Migra la facturación" },
  ];

  test("reinicia a la tarea más el estado, sin mutar lo de partida", () => {
    const out = collapseMessages(base, state);
    expect(out.length).toBe(3);
    expect(out.slice(0, 2)).toEqual(base);
    expect(out[2]).toEqual(stateMessage(state));
    expect(base.length).toBe(2);
  });

  test("el mensaje de estado lleva el plan y los callejones sin salida", () => {
    const text = String(stateMessage(state).content);
    expect(text).toContain("ESTADO ACTUAL DE LA TAREA");
    expect(text).toContain("Mapear impuestos");
    expect(text).toContain("Basic auth falla con 401");
  });
});

describe("updateTaskState", () => {
  const delta = action("http_get", { url: "https://x.test" }, "200 OK");

  test("la primera vez parte de la tarea original y devuelve estado y tokens", async () => {
    let seen: LLMMessage[] = [];
    const r = await updateTaskState({
      task: "Migra la facturación a Alegra",
      previous: null,
      delta,
      call: async (m) => {
        seen = m;
        return ok({}, { input_tokens: 321, output_tokens: 45 });
      },
    });
    expect(r?.state.objective).toBe("Migrar la facturación");
    expect([r?.inputTokens, r?.outputTokens]).toEqual([321, 45]);
    expect(seen[0]!.role).toBe("system");
    expect(String(seen[1]!.content)).toContain("Tarea original:\nMigra la facturación a Alegra");
    expect(String(seen[1]!.content)).toContain("[LLAMADA http_get]");
  });

  test("después incorpora el estado anterior, no la tarea", async () => {
    let user = "";
    await updateTaskState({
      task: "Migra la facturación",
      previous: state,
      delta,
      call: async (m) => {
        user = String(m[1]!.content);
        return ok({});
      },
    });
    expect(user).toContain("Previous handoff");
    expect(user).toContain("Basic auth falla con 401");
    expect(user).not.toContain("Tarea original");
  });

  test("si el modelo deja el objetivo vacío, manda el de la tarea", async () => {
    const r = await updateTaskState({
      task: "  Migra   la facturación\na Alegra ",
      previous: null,
      delta,
      call: async () => ok({ objective: "" }),
    });
    expect(r?.state.objective).toBe("Migra la facturación a Alegra");
  });

  test("devuelve null —y el llamador conserva el historial— ante cualquier fallo", async () => {
    const run = (call: () => Promise<LLMResponse>) => updateTaskState({ task: "t", previous: state, delta, call });

    expect(await run(async () => ({ content: "boom", stop_reason: "error" }))).toBeNull();
    expect(await run(async () => { throw new Error("429"); })).toBeNull();
    expect(await run(async () => ({ content: "no es json", stop_reason: "stop" }))).toBeNull();
    expect(await run(async () => ({ content: '{"objective": "x"', stop_reason: "stop" }))).toBeNull();
    expect(await run(async () => ({ content: '{"changes":["a"]}', stop_reason: "stop" }))).toBeNull();
  });

  test("sin nada nuevo que contar no llama al modelo", async () => {
    let calls = 0;
    const r = await updateTaskState({
      task: "t",
      previous: state,
      delta: [],
      call: async () => {
        calls++;
        return ok({});
      },
    });
    expect(r).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("el contexto deja de crecer", () => {
  test("con reinicio por acción el tamaño es casi constante; sin él crece linealmente", async () => {
    const base: LLMMessage[] = [
      { role: "system", content: "worker" },
      { role: "user", content: "tarea larga" },
    ];
    const size = (ms: LLMMessage[]) => ms.reduce((n, m) => n + String(typeof m.content === "string" ? m.content : "").length, 0);
    const result = "r".repeat(2500);

    // Como lo hace el bucle: cada iteración añade acción + resultado; con el modo, se destila y se reinicia.
    let collapsed = [...base];
    let cutoff = collapsed.length;
    let prev: Handoff | null = null;
    const full = [...base];
    const collapsedSizes: number[] = [];
    const fullSizes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const step = action("run", { i }, result, `c${i}`);
      collapsed.push(...step);
      full.push(...step);
      const upd = await updateTaskState({ task: "tarea larga", previous: prev, delta: collapsed.slice(cutoff), call: async () => ok({ plan: [`paso ${i + 1}`] }) });
      expect(upd).not.toBeNull();
      prev = upd!.state;
      collapsed = collapseMessages(base, prev);
      cutoff = collapsed.length;
      collapsedSizes.push(size(collapsed));
      fullSizes.push(size(full));
    }
    expect(Math.max(...collapsedSizes) - Math.min(...collapsedSizes)).toBeLessThan(300);
    expect(fullSizes[11]!).toBeGreaterThan(fullSizes[0]! * 8);
    expect(collapsedSizes[11]!).toBeLessThan(fullSizes[11]! / 8);
  });

  test("si una actualización falla el historial se conserva y la siguiente recoge ambos pasos", async () => {
    const base: LLMMessage[] = [{ role: "system", content: "w" }, { role: "user", content: "t" }];
    let messages = [...base];
    let cutoff = messages.length;
    let prev: Handoff | null = null;
    const seenDeltas: string[] = [];
    const attempts = [false, true];
    for (let i = 0; i < 2; i++) {
      messages.push(...action("run", {}, `resultado-${i}`, `c${i}`));
      const upd = await updateTaskState({
        task: "t",
        previous: prev,
        delta: messages.slice(cutoff),
        call: async (m) => {
          seenDeltas.push(String(m[1]!.content));
          if (!attempts[i]) throw new Error("fallo del proveedor");
          return ok({});
        },
      });
      if (upd) {
        prev = upd.state;
        messages = collapseMessages(base, prev);
        cutoff = messages.length;
      } else {
        expect(messages.length).toBe(4); // no se recortó
      }
    }
    expect(seenDeltas[1]).toContain("resultado-0");
    expect(seenDeltas[1]).toContain("resultado-1");
    expect(messages.length).toBe(3);
  });
});
