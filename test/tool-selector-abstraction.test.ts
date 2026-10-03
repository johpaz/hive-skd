/**
 * Desempate por abstracción entre tools con el mismo puntaje.
 *
 * El comparador anterior solo miraba el nivel de `a`: dos tools atómicas daban
 * "a antes que b" en los dos sentidos, así que el orden de los empates quedaba
 * indefinido. Un comparador tiene que ser antisimétrico: cmp(a,b) = -cmp(b,a).
 */
import { describe, expect, test } from "bun:test";
import { compareByAbstraction } from "../packages/core/src/agent/tool-selector";

type Level = "atomic" | "orchestration";
const LEVELS: Level[] = ["atomic", "orchestration"];

describe("compareByAbstraction", () => {
  test("la abstracción preferida va primero", () => {
    expect(compareByAbstraction("atomic", "orchestration", "atomic")).toBe(-1);
    expect(compareByAbstraction("orchestration", "atomic", "atomic")).toBe(1);
    expect(compareByAbstraction("orchestration", "atomic", "orchestration")).toBe(-1);
    expect(compareByAbstraction("atomic", "orchestration", "orchestration")).toBe(1);
  });

  test("del mismo nivel empata (antes devolvía -1 en los dos sentidos)", () => {
    for (const level of LEVELS) for (const pref of LEVELS) expect(compareByAbstraction(level, level, pref)).toBe(0);
  });

  test("es antisimétrico para toda combinación", () => {
    for (const a of LEVELS) for (const b of LEVELS) for (const pref of LEVELS) {
      expect(compareByAbstraction(a, b, pref)).toBe(-compareByAbstraction(b, a, pref) || 0);
    }
  });

  test("ordena una lista de forma estable respecto al orden de entrada", () => {
    const tools = [
      { n: "o1", l: "orchestration" as Level }, { n: "a1", l: "atomic" as Level },
      { n: "a2", l: "atomic" as Level }, { n: "o2", l: "orchestration" as Level },
    ];
    const sorted = [...tools].sort((x, y) => compareByAbstraction(x.l, y.l, "atomic")).map((t) => t.n);
    expect(sorted).toEqual(["a1", "a2", "o1", "o2"]);
  });
});
