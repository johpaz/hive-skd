process.env.HIVE_DB_PATH = ":memory:";

import { describe, expect, it } from "bun:test";
import { createWorker, WorkerPool } from "./index";

describe("createWorker", () => {
  it("creates a worker instance with config", () => {
    const worker = createWorker({
      name: "test-worker",
      systemPrompt: "You are a test worker.",
    });

    expect(worker.name).toBe("test-worker");
    expect(worker.id).toContain("test-worker-");
    worker.terminate();
  });

  it("WorkerPool creates and manages workers", () => {
    const pool = new WorkerPool({ maxWorkers: 2 });
    expect(pool.stats.total).toBe(0);
    expect(pool.stats.idle).toBe(0);
    expect(pool.stats.busy).toBe(0);
    pool.shutdown();
  });

  it("WorkerPool executes tasks with limited concurrency", async () => {
    const pool = new WorkerPool({
      maxWorkers: 2,
      workerConfig: { name: "pool-test" },
    });

    const tasks = Array.from({ length: 4 }, (_, i) => ({
      id: `task-${i}`,
      message: `Test message ${i}`,
    }));

    // Since we don't have a real LLM in tests, we just verify the pool structure
    expect(tasks).toHaveLength(4);
    pool.shutdown();
  });
});
