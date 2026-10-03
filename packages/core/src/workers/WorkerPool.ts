/**
 * WorkerPool — Manages a pool of Bun Workers for parallel task execution.
 *
 * Creates workers on demand, reuses idle workers, and handles task queuing.
 */

import { logger } from "../utils/logger";
import { createWorker, type WorkerConfig, type WorkerInstance } from "./createWorker";

const log = logger.child("worker-pool");

export interface WorkerPoolConfig {
  maxWorkers?: number;
  taskTimeoutMs?: number;
  workerConfig?: WorkerConfig;
}

export interface PoolTask {
  id: string;
  message: string;
  agentId?: string;
  threadId?: string;
  channel?: string;
  systemPrompt?: string;
}

export interface PoolTaskResult {
  taskId: string;
  result: string;
  error?: string;
  durationMs: number;
}

export class WorkerPool {
  private maxWorkers: number;
  private taskTimeoutMs: number;
  private workerConfig: WorkerConfig;
  private workers: Map<string, WorkerInstance> = new Map();
  private idleWorkers: string[] = [];
  private taskQueue: Array<{ task: PoolTask; resolve: (result: PoolTaskResult) => void }> = [];
  private busyWorkers: Set<string> = new Set();

  constructor(config: WorkerPoolConfig = {}) {
    this.maxWorkers = config.maxWorkers ?? 4;
    this.taskTimeoutMs = config.taskTimeoutMs ?? 120000;
    this.workerConfig = config.workerConfig ?? { name: "pool-worker" };
  }

  /**
   * Execute a single task in a worker.
   */
  async execute(task: PoolTask): Promise<PoolTaskResult> {
    const worker = await this.acquireWorker();
    const startedAt = performance.now();

    try {
      const result = await worker.run(task.message, {
        threadId: task.threadId,
        channel: task.channel,
      });
      return {
        taskId: task.id,
        result,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (err) {
      return {
        taskId: task.id,
        result: "",
        error: (err as Error).message,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } finally {
      this.releaseWorker(worker.id);
    }
  }

  /**
   * Execute multiple tasks in parallel, up to maxWorkers at a time.
   */
  async executeBatch(tasks: PoolTask[]): Promise<PoolTaskResult[]> {
    return Promise.all(tasks.map((task) => this.execute(task)));
  }

  /**
   * Execute tasks with a limit on concurrency.
   */
  async executeWithConcurrency(tasks: PoolTask[], concurrency: number): Promise<PoolTaskResult[]> {
    const results: PoolTaskResult[] = [];
    const executing = new Set<Promise<void>>();

    for (const task of tasks) {
      const promise = this.execute(task).then((result) => {
        results.push(result);
      });
      executing.add(promise);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
        executing.delete(promise);
      }
    }

    await Promise.all(executing);
    return results;
  }

  /**
   * Get or create a worker.
   */
  private acquireWorker(): Promise<WorkerInstance> {
    return new Promise((resolve) => {
      // Try to reuse an idle worker
      if (this.idleWorkers.length > 0) {
        const workerId = this.idleWorkers.pop()!;
        this.busyWorkers.add(workerId);
        resolve(this.workers.get(workerId)!);
        return;
      }

      // Create a new worker if under limit
      if (this.workers.size < this.maxWorkers) {
        const worker = createWorker(this.workerConfig);
        this.workers.set(worker.id, worker);
        this.busyWorkers.add(worker.id);
        resolve(worker);
        return;
      }

      // Queue the request
      const checkInterval = setInterval(() => {
        if (this.idleWorkers.length > 0) {
          clearInterval(checkInterval);
          const workerId = this.idleWorkers.pop()!;
          this.busyWorkers.add(workerId);
          resolve(this.workers.get(workerId)!);
        }
      }, 50);
    });
  }

  private releaseWorker(workerId: string): void {
    this.busyWorkers.delete(workerId);
    this.idleWorkers.push(workerId);
  }

  /**
   * Terminate all workers in the pool.
   */
  shutdown(): void {
    log.info(`[WorkerPool] Shutting down ${this.workers.size} workers`);
    for (const worker of this.workers.values()) {
      worker.terminate();
    }
    this.workers.clear();
    this.idleWorkers = [];
    this.busyWorkers.clear();
  }

  get stats(): { total: number; busy: number; idle: number } {
    return {
      total: this.workers.size,
      busy: this.busyWorkers.size,
      idle: this.idleWorkers.length,
    };
  }
}
