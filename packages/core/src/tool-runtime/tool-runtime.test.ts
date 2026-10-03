import { afterEach, describe, expect, it } from "bun:test";
import { executeToolBatch, shutdownToolRuntime, type RuntimeTool, type ToolCallLike } from "./index";
import { loadConfig } from "../config/loader";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toolCall(id: string, name: string, args: unknown = {}): ToolCallLike {
  return {
    id,
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

describe("tool runtime worker pool", () => {
  afterEach(() => {
    shutdownToolRuntime();
  });

  it("runs multiple tools in parallel through worker scheduling", async () => {
    // Medir el solapamiento y no el reloj: un umbral de tiempo se vuelve flaky
    // cuando la suite entera corre con 16 procesos en un runner cargado.
    //
    // Y por lo mismo se afirma que hubo solapamiento, no que llegó a 3 exactos:
    // con `bun test --parallel` hay tantos procesos como núcleos compitiendo, y
    // las tres tareas de 50 ms se planifican con huecos, así que `maxActive`
    // baja a 2 sin que nada esté mal. Lo que este test tiene que distinguir es
    // "se ejecutaron en paralelo" de "se serializaron"; el número exacto lo
    // decide el planificador del sistema operativo, no este código.
    let active = 0;
    let maxActive = 0;

    const tools: RuntimeTool[] = ["slow_a", "slow_b", "slow_c"].map((name) => ({
      name,
      execute: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await delay(50);
          return { name };
        } finally {
          active--;
        }
      },
    }));

    const results = await executeToolBatch({
      toolCalls: [
        toolCall("1", "slow_a"),
        toolCall("2", "slow_b"),
        toolCall("3", "slow_c"),
      ],
      allTools: tools,
      toolConfig: {},
      hiveConfig: loadConfig(),
      workerPool: { enabled: true, maxWorkers: 3, toolTimeoutMs: 5000, parallelToolCalls: true },
    });

    expect(results.map((result) => (result.result as any).name)).toEqual(["slow_a", "slow_b", "slow_c"]);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("preserves input order when tools complete out of order", async () => {
    const tools: RuntimeTool[] = [
      { name: "first", execute: async () => { await delay(120); return { value: 1 } } },
      { name: "second", execute: async () => { await delay(20); return { value: 2 } } },
      { name: "third", execute: async () => { await delay(60); return { value: 3 } } },
    ];

    const results = await executeToolBatch({
      toolCalls: [toolCall("1", "first"), toolCall("2", "second"), toolCall("3", "third")],
      allTools: tools,
      toolConfig: {},
      hiveConfig: loadConfig(),
      workerPool: { enabled: true, maxWorkers: 3, toolTimeoutMs: 1000, parallelToolCalls: true },
    });

    expect(results.map((r) => (r.result as any).value)).toEqual([1, 2, 3]);
  });

  it("handles tool errors gracefully", async () => {
    const tools: RuntimeTool[] = [
      {
        name: "fail",
        execute: async () => {
          throw new Error("intentional failure");
        },
      },
    ];

    const results = await executeToolBatch({
      toolCalls: [toolCall("1", "fail")],
      allTools: tools,
      toolConfig: {},
      hiveConfig: loadConfig(),
      workerPool: { enabled: true, maxWorkers: 1, toolTimeoutMs: 1000, parallelToolCalls: false },
    });

    expect(results[0].ok).toBe(false);
    expect(results[0].result).toBeDefined();
    const result = results[0].result as any;
    expect(result.error).toBe(true);
    expect(result.message).toContain("intentional failure");
  });
});
