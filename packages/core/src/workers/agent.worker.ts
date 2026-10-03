/**
 * Agent Worker — Bun Worker that runs an agent task in isolation.
 *
 * Receives: { type: "AGENT_TASK", taskId, message, agentId, threadId, channel, systemPrompt }
 * Sends:    { type: "AGENT_RESULT", taskId, result } | { type: "AGENT_CHUNK", taskId, chunk }
 */

import { runAgent } from "../agent/agent-loop";
import type { StreamChunk } from "../agent/agent-loop";

declare var self: {
  onmessage: ((event: { data: WorkerMessage }) => void) | null;
  postMessage(message: WorkerResponse): void;
};

type WorkerMessage = {
  type: "AGENT_TASK";
  taskId: string;
  message: string;
  agentId: string;
  threadId?: string;
  channel?: string;
  systemPrompt?: string;
};

type WorkerResponse =
  | { type: "AGENT_CHUNK"; taskId: string; chunk: StreamChunk }
  | { type: "AGENT_RESULT"; taskId: string; result: string; error?: string };

self.onmessage = async (event) => {
  const { type, taskId, message, agentId, threadId, channel, systemPrompt } = event.data;

  if (type !== "AGENT_TASK") return;

  try {
    const stream = runAgent({
      agentId,
      userMessage: message,
      threadId: threadId ?? `worker-${taskId}`,
      channel: channel ?? "worker",
      isolated: true,
      systemPromptOverride: systemPrompt,
    });

    let fullResponse = "";

    for await (const chunk of stream) {
      self.postMessage({ type: "AGENT_CHUNK", taskId, chunk });

      if (chunk.agent?.messages) {
        for (const msg of chunk.agent.messages) {
          if (msg.content && typeof msg.content === "string") {
            fullResponse = msg.content;
          }
        }
      }
    }

    self.postMessage({ type: "AGENT_RESULT", taskId, result: fullResponse });
  } catch (err) {
    self.postMessage({
      type: "AGENT_RESULT",
      taskId,
      result: "",
      error: (err as Error).message,
    });
  }
};
