import { describe, expect, it } from "bun:test";
import { TaskGraph } from "./TaskGraph";

describe("TaskGraph", () => {
  it("creates a graph with nodes", () => {
    const graph = new TaskGraph([
      { id: "a", agentId: "agent-a", name: "Task A", taskDescription: "Task A", deps: [] },
      { id: "b", agentId: "agent-b", name: "Task B", taskDescription: "Task B", deps: ["a"] },
    ]);

    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.get("a")?.deps).toEqual([]);
    expect(graph.nodes.get("b")?.deps).toEqual(["a"]);
  });

  it("validates node existence", () => {
    const graph = new TaskGraph([
      { id: "a", agentId: "agent-a", name: "Task A", taskDescription: "Task A", deps: [] },
    ]);

    expect(graph.nodes.has("a")).toBe(true);
    expect(graph.nodes.has("missing")).toBe(false);
  });
});
