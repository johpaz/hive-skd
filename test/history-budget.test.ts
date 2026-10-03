/**
 * El historial se recorta a la ventana del modelo (portado de hive).
 *
 * Antes salía entero fuera cual fuera su tamaño y, si el proveedor truncaba
 * (Ollama con num_ctx), cortaba a ciegas. Los últimos mensajes —el turno actual
 * y el intercambio al que se refiere— se conservan aunque se pasen del
 * presupuesto, y el historial siempre abre con un turno de usuario.
 */
import { describe, expect, test } from "bun:test";
import { fitMessagesToBudget } from "../packages/core/src/agent/context-compiler";
import type { LLMMessage } from "../packages/core/src/agent/llm-client";

const msg = (role: LLMMessage["role"], chars: number): LLMMessage => ({ role, content: "x".repeat(chars) } as LLMMessage);

describe("fitMessagesToBudget", () => {
  test("lo que cabe se devuelve tal cual (misma referencia)", () => {
    const history = [msg("user", 40), msg("assistant", 40)];
    expect(fitMessagesToBudget(history, 1000)).toBe(history);
  });

  test("descarta lo más viejo hasta caber y conserva los últimos mensajes", () => {
    const history = Array.from({ length: 12 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", 400)); // ~100 tokens c/u
    const fitted = fitMessagesToBudget(history, 450);
    expect(fitted.length).toBeLessThan(history.length);
    expect(fitted.at(-1)).toBe(history.at(-1));
    expect(fitted.length).toBeGreaterThanOrEqual(4);
  });

  test("el historial abre con un turno de usuario", () => {
    const history = [msg("user", 400), msg("assistant", 400), msg("user", 400), msg("assistant", 400), msg("user", 400), msg("assistant", 400), msg("user", 40)];
    expect(fitMessagesToBudget(history, 300)[0]?.role).toBe("user");
  });

  test("un solo mensaje enorme se recorta por el medio, no se pierde", () => {
    const [only] = fitMessagesToBudget([msg("user", 40_000)], 500);
    const text = only!.content as string;
    expect(text.length).toBeLessThan(40_000);
    expect(text).toContain("recortado para caber");
  });

  test("sin mensajes no hace nada", () => {
    expect(fitMessagesToBudget([], 10)).toEqual([]);
  });
});
