/**
 * createWorker — Factory for creating specialized Bun Workers.
 *
 * Creates a dedicated worker thread that runs an agent with a custom system prompt.
 * Useful for parallel task execution and specialized agent roles.
 */

import { logger } from "../utils/logger";

const log = logger.child("createWorker");

export interface WorkerConfig {
  name: string;
  agentId?: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
}

export interface WorkerInstance {
  readonly name: string;
  readonly id: string;
  run(message: string, opts?: { threadId?: string; channel?: string }): Promise<string>;
  runStream(message: string, opts?: { threadId?: string; channel?: string }): AsyncGenerator<WorkerChunk>;
  terminate(): void;
}

export interface WorkerChunk {
  type: "chunk" | "result" | "error";
  content?: string;
  chunk?: any;
  error?: string;
}

const WORKER_EXT = import.meta.url.endsWith(".ts") ? ".worker.ts" : ".worker.js";

function resolveWorkerPath(): string {
  return new URL(`./agent${WORKER_EXT}`, import.meta.url).pathname;
}

export function createWorker(config: WorkerConfig): WorkerInstance {
  const workerId = `${config.name}-${crypto.randomUUID().slice(0, 8)}`;
  const workerPath = resolveWorkerPath();

  log.info(`[createWorker] Spawning worker ${workerId} from ${workerPath}`);

  const worker = new Worker(workerPath, { smol: true });

  return {
    name: config.name,
    id: workerId,

    async run(message, opts) {
      return new Promise((resolve, reject) => {
        const taskId = crypto.randomUUID();
        const timeout = setTimeout(() => {
          reject(new Error(`Worker ${workerId} timed out`));
        }, 120000);

        const handler = (event: MessageEvent) => {
          const data = event.data;
          if (data.taskId !== taskId) return;

          if (data.type === "AGENT_RESULT") {
            clearTimeout(timeout);
            worker.removeEventListener("message", handler);
            if (data.error) {
              reject(new Error(data.error));
            } else {
              resolve(data.result);
            }
          }
        };

        worker.addEventListener("message", handler);
        worker.postMessage({
          type: "AGENT_TASK",
          taskId,
          message,
          agentId: config.agentId ?? config.name,
          threadId: opts?.threadId,
          channel: opts?.channel ?? config.name,
          systemPrompt: config.systemPrompt,
        });
      });
    },

    async *runStream(message, opts) {
      const taskId = crypto.randomUUID();

      worker.postMessage({
        type: "AGENT_TASK",
        taskId,
        message,
        agentId: config.agentId ?? config.name,
        threadId: opts?.threadId,
        channel: opts?.channel ?? config.name,
        systemPrompt: config.systemPrompt,
      });

      let resolved = false;
      const pending: WorkerResponse[] = [];

      const handler = (event: MessageEvent) => {
        const data = event.data as WorkerResponse;
        if (data.taskId !== taskId) return;
        pending.push(data);
      };

      worker.addEventListener("message", handler);

      try {
        while (!resolved) {
          while (pending.length === 0) {
            await new Promise((r) => setTimeout(r, 10));
          }
          const data = pending.shift()!;

          if (data.type === "AGENT_CHUNK") {
            yield { type: "chunk" as const, chunk: data.chunk };
          } else if (data.type === "AGENT_RESULT") {
            resolved = true;
            if (data.error) {
              yield { type: "error" as const, error: data.error };
            } else {
              yield { type: "result" as const, content: data.result };
            }
          }
        }
      } finally {
        worker.removeEventListener("message", handler);
      }
    },

    terminate() {
      log.info(`[createWorker] Terminating worker ${workerId}`);
      worker.terminate();
    },
  };
}

type WorkerResponse =
  | { type: "AGENT_CHUNK"; taskId: string; chunk: any }
  | { type: "AGENT_RESULT"; taskId: string; result: string; error?: string };
