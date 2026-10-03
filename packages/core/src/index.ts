// ─── API ─────────────────────────────────────────────────────────────────────
export { createAgent } from "./api/index";
export type { AgentConfig, Agent, AgentEvent, AgentTurnUsage, AgentCallOptions } from "./api/index";

// ─── Tools ───────────────────────────────────────────────────────────────────
export { defineTool } from "./tools/ToolRegistry";
export type { ToolDefinition } from "./tools/ToolRegistry";
export { ToolRegistry } from "./tools/ToolRegistry";
export { ToolExecutor } from "./tools/ToolExecutor";
export { validateToolArgs } from "./tools/validate-args";
export type { ToolExecutionResult } from "./tools/ToolExecutor";
export { createAllTools, createToolsByCategory, registerAppTool, clearAppTools, listAppTools } from "./tools/index";
export type { Tool, ToolParameter, ToolResult } from "./tools/types";
export { apiRequestTool } from "./tools/api/index";

// ─── Skills ──────────────────────────────────────────────────────────────────
export { defineSkill } from "./skills/defineSkill";
export type { SkillDefinition } from "./skills/defineSkill";
export { SkillLoader } from "./skills/index";
export type { Skill, SkillStep, OutputFormat, SkillsConfig } from "./skills/index";

// ─── Agent ───────────────────────────────────────────────────────────────────
export { runAgent, runAgentIsolated, AgentLoop, getAgentLoop, buildAgentLoop, rebuildAgentLoop } from "./agent/agent-loop";
export type { AgentLoopOptions, StepEvent, StreamChunk } from "./agent/agent-loop";
export type { Provider } from "./agent/providers/index";
export { AgentRunner, createAgentRunner } from "./agent/providers/index";

// El cliente LLM es parte de la superficie pública: hasta 0.1.5 sólo se exportaba
// el wrapper `AgentRunner`, así que no había forma de llamar a un provider ni de
// leer el error tipado sin importar por ruta profunda.
export { callLLM, getDefaultLLM, resolveProviderConfig } from "./agent/llm-client";
export type { LLMMessage, LLMToolCall, LLMToolDef, LLMCallOptions, LLMResponse, ContentPart } from "./agent/llm-client";

// Control de prompt y contexto.
export { buildSystemPrompt, buildSystemPromptWithProjects } from "./agent/prompt-builder";
export { compileContext } from "./agent/context-compiler";
export type { CompiledContext } from "./agent/context-compiler";
export { maybeCompact, clearOldToolResults } from "./agent/compaction";
export { selectTools } from "./agent/tool-selector";
export { selectSkills, getMinimalSkills } from "./agent/skill-selector";
export { selectPlaybookRules } from "./agent/playbook-selector";
export { MINIMAL_TOOLS } from "./agent/minimal-loadout";

// ─── Swarm / Scheduler ───────────────────────────────────────────────────────
export { DAGScheduler } from "./swarm/index";
export type { DAGSchedulerOptions, IAgentExecutor } from "./swarm/index";
export { TaskGraph, TaskNode } from "./swarm/index";
export type { TaskNodeConfig, NodeStatus, DAGResult, NodeSummary } from "./swarm/index";
export { CronScheduler } from "./scheduler/index";
export type { CronJob } from "./scheduler/index";

// ─── MCP ─────────────────────────────────────────────────────────────────────
export { MCPClientManager } from "./mcp/index";
export type { MCPTool, MCPResource, MCPPrompt, MCPConfig, MCPServerConfig } from "./mcp/index";

// ─── Ethics ──────────────────────────────────────────────────────────────────
export { EthicsGuard } from "./ethics/index";
export type { EthicsRule } from "./ethics/index";

// ─── Memory ──────────────────────────────────────────────────────────────────
export { Scratchpad } from "./memory/index";
export type { IStorage } from "./memory/index";

// ─── Storage ─────────────────────────────────────────────────────────────────
// `ensureHiveDb()` reemplaza a `initializeDatabase()`: abre HiveDB, crea los
// índices y siembra el catálogo. Idempotente — se llama en cada arranque.
export { ensureHiveDb, col, seedAllData, SEED_DATA } from "./storage/index";
export type { SeedData } from "./storage/index";
export { catalogModelKey, wireModelId, isResellerProvider } from "./storage/index";
export { calculateCost, invalidateModelPricingCache, recordUsage, getUsageStats } from "./storage/index";
export type { UsageRecord, UsageSummary } from "./storage/index";
export type { AgentDoc, ModelDoc, ProviderDoc, SkillDoc, ToolDoc, EthicsDoc, UserDoc } from "./storage/collections";

// ─── Config ──────────────────────────────────────────────────────────────────
export { loadConfig, loadEnv, getHiveDir } from "./config/index";
export type { Config } from "./config/index";

// ─── Gateway ─────────────────────────────────────────────────────────────────
export { startGateway } from "./gateway/index";
export type { GatewayConfig } from "./gateway/index";

// ─── Channels ────────────────────────────────────────────────────────────────
export { ChannelManager } from "./channels/manager";
export { BaseChannel } from "./channels/base";
export { TelegramChannel } from "./channels/telegram";
export { DiscordChannel } from "./channels/discord";
export { WhatsAppChannel } from "./channels/whatsapp";
export {
  WhatsAppCloudChannel,
  WhatsAppCloudClient,
  WhatsAppCloudError,
  splitWhatsAppText,
  parseWebhook as parseWhatsAppWebhook,
  verifySignature as verifyWhatsAppSignature,
  verifyChallenge as verifyWhatsAppChallenge,
} from "./channels/whatsapp-cloud/index";
export type {
  WhatsAppCloudConfig,
  WhatsAppTemplate,
  WhatsAppInbound,
  WhatsAppWebhookEvent,
  WhatsAppStatusEvent,
  WhatsAppReferral,
} from "./channels/whatsapp-cloud/index";
export { SlackChannel } from "./channels/slack";
export { WebChatChannel } from "./channels/webchat";

// ─── Canvas ──────────────────────────────────────────────────────────────────
export { CanvasManager } from "./canvas/canvas-manager";
export { emitCanvas } from "./canvas/emitter";

// ─── Tool Runtime ────────────────────────────────────────────────────────────
export { executeToolBatch } from "./tool-runtime/index";
export type { ToolBatchResult, ExecuteToolBatchOptions } from "./tool-runtime/index";

// ─── Events ──────────────────────────────────────────────────────────────────
export { eventBus } from "./events/event-bus";
export { agentBus } from "./events/agent-bus";

// ─── Workers ─────────────────────────────────────────────────────────────────
export { createWorker, WorkerPool } from "./workers/index";
export type { WorkerConfig, WorkerInstance, WorkerChunk, WorkerPoolConfig, PoolTask, PoolTaskResult } from "./workers/index";

// ─── Utils ───────────────────────────────────────────────────────────────────
export { logger } from "./utils/logger";
export { retry } from "./utils/retry";

// ─── Harness (durable task execution) ───────────────────────────────────────
// Namespaced to avoid flooding the top-level barrel with ~50 harness exports —
// see docs/HIVE-HARNESS.md. Also available as a flat import from
// "@johpaz/hive-sdk/harness".
export * as harness from "./harness/index";
