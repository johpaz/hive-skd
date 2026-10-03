export { DAGScheduler } from "./Coordinator";
export type { DAGSchedulerOptions, IAgentExecutor } from "./Coordinator";

export { TaskGraph } from "./TaskGraph";
export { TaskNode } from "./TaskNode";
export type { TaskNodeConfig, NodeStatus } from "./TaskNode";
export type { DAGResult, NodeSummary } from "./TaskResult";

export { AgentExecutor } from "./AgentExecutor";
export { EventBridge } from "./EventBridge";

export { CyclicDependencyError, TaskTimeoutError, TaskFailureError } from "./errors";

// Los buses viven en events/. `swarm/AgentBus.ts` y `swarm/EventBus.ts` eran
// copias que escribían a SQLite; se re-exportan desde acá para no romper a quien
// los importaba por el subpath ./swarm.
export type { AgentBusEventMap, AgentBusEventKey, AgentBusEventHandler, AgentBusMessage, AgentBus } from "../events/agent-bus";
export { getUnreadMessagesForWorker, agentBus } from "../events/agent-bus";

export type { EventMap, EventKey, EventHandler, TypedEventBus } from "../events/event-bus";
export { eventBus } from "../events/event-bus";

// Ejecución de tareas agendadas: `swarm/WorkerPool.ts` era una copia rezagada de
// scheduler/integration.ts (mismo archivo, 18 líneas de deriva).
export { setSchedulerForCleanup, notifyTaskCompletion, createTaskHandler } from "../scheduler/integration";

export type { ExecutionStrategy } from "./strategies/index";
export { ParallelStrategy, PriorityStrategy } from "./strategies/index";

export { createHiveLearnGraph } from "./presets/index";
export type { HiveLearnAgentIds, HiveLearnInput } from "./presets/index";
export { createResearchGraph } from "./presets/index";
export type { ResearchAgentIds } from "./presets/index";

// ─── Enjambre por roles (orquestador/trabajadores) ───────────────────────────
export { runRoleSwarm, defaultInvoker } from "./RoleSwarm";
export type {
  SwarmStrategy, RoleAgent, SwarmMessage, AgentInvoker,
  RoleSwarmOptions, RoleSwarmResult,
} from "./RoleSwarm";
