/**
 * La evaluación de extremo a extremo del modo de una acción (bench/single-action): tareas resolubles y
 * bien comprobadas, estadísticas y argumentos. Sin modelo ni red: un "solucionador perfecto" escrito a
 * mano recorre las mismas herramientas que el worker.
 */

import { describe, test, expect } from "bun:test";
import { TASK_KINDS, buildTask, numbersIn, repeatedFailures, type Task } from "../bench/single-action/tasks";
import { compare, groupBy, summarize, type RunRecord } from "../bench/single-action/stats";
import { parseArgs } from "../bench/single-action/run";

/** Resuelve la tarea como lo haría un worker perfecto y devuelve su respuesta y las llamadas hechas. */
function solve(task: Task): { answer: string; calls: Array<{ tool: string; args: Record<string, unknown>; ok: boolean }> } {
  const calls: Array<{ tool: string; args: Record<string, unknown>; ok: boolean }> = [];
  const call = (tool: string, args: Record<string, unknown>) => {
    const r = task.call(tool, args);
    calls.push({ tool, args, ok: r.ok });
    return r;
  };
  if (task.kind === "chain") {
    let key: string | null = /"(nodo-[^"]+)"/.exec(task.prompt)![1]!;
    let sum = 0;
    while (key) {
      const r = call("siguiente", { clave: key }).result as { valor: number; siguiente: string | null };
      sum += r.valor;
      key = r.siguiente;
    }
    return { answer: `La suma es ${sum}.`, calls };
  }
  if (task.kind === "inventory") {
    const items = /artículos: ([^.]+)\./.exec(task.prompt)![1]!.split(", ");
    const stock = items.map((a) => ({ a, n: (call("stock", { articulo: a }).result as { unidades: number }).unidades }));
    const best = stock.reduce((x, y) => (y.n > x.n ? y : x));
    return { answer: `${best.a} tiene más: ${best.n} unidades.`, calls };
  }
  const env = /entorno "([^"]+)"/.exec(task.prompt)![1]!;
  const methods = (call("metodos", {}).result as { metodos: string[] }).metodos;
  for (const metodo of methods) {
    const r = call("desplegar", { metodo, entorno: env });
    if (r.ok) return { answer: `Desplegado, código ${(r.result as { codigo: string }).codigo}`, calls };
  }
  return { answer: "no pude desplegar", calls };
}

describe("tareas", () => {
  test("son deterministas por semilla y distintas entre semillas", () => {
    for (const kind of TASK_KINDS) {
      expect(buildTask(kind, 3).prompt).toBe(buildTask(kind, 3).prompt);
      expect(buildTask(kind, 3).expected).toBe(buildTask(kind, 3).expected);
      expect(buildTask(kind, 3).expected).not.toBe(buildTask(kind, 4).expected);
    }
  });

  test("un solucionador perfecto las resuelve y la comprobación lo acepta (20 semillas)", () => {
    for (const kind of TASK_KINDS) {
      for (let seed = 1; seed <= 20; seed++) {
        const task = buildTask(kind, seed);
        expect(task.check(solve(task).answer)).toBe(true);
      }
    }
  });

  test("la comprobación rechaza lo casi correcto", () => {
    const chain = buildTask("chain", 1);
    expect(chain.check(`La suma es ${Number(chain.expected) - 1}.`)).toBe(false);
    expect(chain.check(`La suma es ${Number(chain.expected) + 10}.`)).toBe(false);
    expect(chain.check("No pude terminar")).toBe(false);

    const inv = buildTask("inventory", 1);
    const [name, units] = /^(.+) \((\d+)\)$/.exec(inv.expected)!.slice(1);
    expect(inv.check(`${name} tiene ${Number(units) - 1} unidades`)).toBe(false); // artículo bien, cifra mal
    expect(inv.check(`otro-A1 tiene ${units} unidades`)).toBe(false); // cifra bien, artículo mal

    const dep = buildTask("deploy", 1);
    expect(dep.check("Desplegado, código DEP-0000-XXX")).toBe(false);
  });

  test("las cadenas son largas y el inventario cubre ocho artículos", () => {
    expect(solve(buildTask("chain", 2)).calls.length).toBe(8);
    expect(solve(buildTask("inventory", 2)).calls.length).toBe(8);
  });

  test("en deploy solo un método funciona y los demás fallan sin servir reintentar", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const task = buildTask("deploy", seed);
      const env = /entorno "([^"]+)"/.exec(task.prompt)![1]!;
      const methods = (task.call("metodos", {}).result as { metodos: string[] }).metodos;
      const oks = methods.filter((m) => task.call("desplegar", { metodo: m, entorno: env }).ok);
      expect(oks.length).toBe(1);
      // Reintentar uno que falló vuelve a fallar.
      const bad = methods.find((m) => m !== oks[0])!;
      expect(task.call("desplegar", { metodo: bad, entorno: env }).ok).toBe(false);
      expect(task.call("desplegar", { metodo: oks[0]!, entorno: "otro" }).ok).toBe(false);
    }
  });

  test("las herramientas rechazan entradas que no existen", () => {
    expect(buildTask("chain", 1).call("siguiente", { clave: "nada" }).ok).toBe(false);
    expect(buildTask("inventory", 1).call("stock", { articulo: "nada" }).ok).toBe(false);
    expect(buildTask("deploy", 1).call("otra", {}).ok).toBe(false);
  });
});

describe("numbersIn", () => {
  test("lee números con y sin separador de miles", () => {
    expect(numbersIn("son 1.234 unidades")).toContain(1234);
    expect(numbersIn("son 1,234 unidades")).toContain(1234);
    expect(numbersIn("son 1234 unidades")).toContain(1234);
    expect(numbersIn("costó 12,5 euros")).toContain(12.5);
    expect(numbersIn("sin números")).toEqual([]);
  });
});

describe("repeatedFailures", () => {
  test("cuenta solo los fallos idénticos repetidos", () => {
    const c = (tool: string, metodo: string, ok: boolean) => ({ tool, args: { metodo }, ok });
    expect(repeatedFailures([c("d", "a", false), c("d", "b", false), c("d", "c", true)])).toBe(0);
    expect(repeatedFailures([c("d", "a", false), c("d", "a", false), c("d", "a", false)])).toBe(2);
    expect(repeatedFailures([c("d", "a", true), c("d", "a", true)])).toBe(0);
  });
});

describe("estadísticas", () => {
  const run = (over: Partial<RunRecord>): RunRecord => ({
    kind: "chain", seed: 1, mode: "history", success: true, answer: "", iterations: 5, modelCalls: 5, toolCalls: 4,
    inputTokens: 1000, outputTokens: 100, elapsedMs: 4000, peakRequestKb: 20, repeatedFailures: 0, ...over,
  });

  test("summarize promedia y trata lo no medido como ausente, no como cero", () => {
    const s = summarize([run({}), run({ success: false, modelCalls: null, peakRequestKb: null, inputTokens: 3000 })]);
    expect(s.runs).toBe(2);
    expect(s.successRate).toBe(0.5);
    expect(s.avgInputTokens).toBe(2000);
    expect(s.avgModelCalls).toBe(5);
    expect(s.avgPeakRequestKb).toBe(20);
    expect(summarize([run({ modelCalls: null, peakRequestKb: null })]).avgModelCalls).toBeNull();
    expect(summarize([]).successRate).toBe(0);
  });

  test("las corridas no concluyentes (fallo del proveedor) no cuentan ni como acierto ni como fallo", () => {
    const s = summarize([
      run({}),
      run({ success: false }),
      run({ success: false, inconclusive: true, inputTokens: 0, modelCalls: 4 }),
      run({ success: false, inconclusive: true }),
    ]);
    expect(s.runs).toBe(2);
    expect(s.excluded).toBe(2);
    expect(s.successRate).toBe(0.5);
    expect(s.avgInputTokens).toBe(1000); // las excluidas no arrastran el promedio a cero

    const none = summarize([run({ inconclusive: true })]);
    expect(none.runs).toBe(0);
    expect(none.excluded).toBe(1);
    expect(none.successRate).toBe(0);
  });

  test("compare da el cambio de éxito y los cocientes sac/history", () => {
    const h = summarize([run({}), run({}), run({ success: false })]);
    const s = summarize([run({ mode: "sac", inputTokens: 500, peakRequestKb: 5, modelCalls: 10 }), run({ mode: "sac" }), run({ mode: "sac" })]);
    const c = compare(h, s);
    expect(c.successDeltaPp).toBeCloseTo(33.3, 0);
    expect(c.inputTokensRatio).toBeCloseTo(0.833, 2);
    expect(c.peakRequestRatio).toBeCloseTo(0.75, 2);
    expect(c.modelCallsRatio).toBeCloseTo(1.333, 2);
    expect(compare(summarize([run({ peakRequestKb: null })]), s).peakRequestRatio).toBeNull();
  });

  test("groupBy agrupa por clave", () => {
    const g = groupBy([run({}), run({ mode: "sac" }), run({ mode: "sac" })], (r) => r.mode);
    expect(g.history.length).toBe(1);
    expect(g.sac.length).toBe(2);
  });
});

describe("argumentos", () => {
  test("valores por defecto", () => {
    const a = parseArgs([]);
    expect(a.provider).toBe("gemini");
    expect(a.seeds).toEqual([1, 2, 3, 4, 5]);
    expect(a.kinds).toEqual(TASK_KINDS);
    expect(a.modes).toEqual(["history", "sac"]);
    expect(a.hiveCredentials).toBe(false);
    expect(a.retries).toBe(3);
  });

  test("--seeds acepta una cuenta o una lista, y se rechazan valores inválidos", () => {
    expect(parseArgs(["--seeds", "3"]).seeds).toEqual([1, 2, 3]);
    expect(parseArgs(["--seeds", "11,12"]).seeds).toEqual([11, 12]);
    expect(() => parseArgs(["--seeds", "a,b"])).toThrow();
    expect(() => parseArgs(["--kinds", "nada"])).toThrow();
    expect(() => parseArgs(["--modes", "otro"])).toThrow();
  });
});

describe("CLI", () => {
  test("sin clave termina con error claro y sin tocar ninguna base", async () => {
    const proc = Bun.spawn(["bun", "bench/single-action/run.ts", "--provider", "gemini"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
      cwd: import.meta.dir + "/..",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(err).toContain("GEMINI_API_KEY");
  });

  test("--hive-credentials con una ruta de hive inexistente falla claro", async () => {
    const proc = Bun.spawn(["bun", "bench/single-action/run.ts", "--hive-credentials", "--hive-repo", "/no/existe"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
      cwd: import.meta.dir + "/..",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(err).toContain("No pude cargar el código de hive");
  });
});
