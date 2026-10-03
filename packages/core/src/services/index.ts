/**
 * Services — la superficie que maneja una interfaz, no el modelo.
 *
 * El SDK nació para que lo condujera un LLM: casi todo el CRUD vivía dentro de
 * las tools (`cronCreateTool`, `memoryWriteTool`, `agentCreateTool`…), con
 * argumentos con forma de LLM y respuestas escritas para un prompt. Montar una
 * UI encima obligaba a llamar `tool.execute({...})` y parsear prosa, o a
 * escribir consultas crudas contra HiveDB conociendo un esquema privado.
 *
 * Acá vive la implementación y las tools pasan a envolverla: una sola
 * implementación con dos consumidores, el modelo y la aplicación.
 *
 * Es deliberadamente **agnóstico del framework** — funciones, no rutas HTTP.
 * Una app móvil o de escritorio que embeba el runtime no quiere un servidor; y
 * quien haga una UI web monta sus rutas encima en unas pocas líneas, que es
 * exactamente lo que hace hive (ver `gateway/routes/conversations.ts`, delgada
 * porque toda su lógica está en `agent/thread-store.ts`).
 *
 * Convención: estas funciones **lanzan** ante un error en vez de devolver
 * `{ok:false}`. Quien construye una UI quiere `try/catch`, no inspeccionar un
 * campo. La traducción al formato del modelo la hace el envoltorio de la tool.
 */

export * as memory from "./memory";
export * as agents from "./agents";
export * as skills from "./skills";
export * as cron from "./cron";
export * as tools from "./tools";
export * as ethics from "./ethics";
export * as providers from "./providers";
export * as models from "./models";
export * as mcp from "./mcp";
export * as swarms from "./swarms";
export * as endpoints from "./endpoints";
export * as setup from "./setup";
export * as images from "./images";

// También sueltas, para quien prefiera importar la función directa.
export {
  writeMemory, readMemory, listMemories, searchMemories, deleteMemory,
  type MemoryEntry, type MemorySearchHit,
} from "./memory";

export {
  createAgent, getAgent, listAgents, updateAgent, deleteAgent,
  assignTools, assignSkills, assignMcpServers, enableAgent, disableAgent,
  type AgentSummary, type CreateAgentInput, type UpdateAgentInput, type ListAgentsOptions,
} from "./agents";

export {
  createSkill, getSkill, listSkills, updateSkill, deleteSkill, toggleSkill,
  importSkillFromDisk,
  type SkillSummary, type CreateSkillInput, type UpdateSkillInput,
} from "./skills";

export {
  createCronJob, getCronJob, listCronJobs, updateCronJob, deleteCronJob,
  pauseCronJob, resumeCronJob, triggerCronJob, getCronHistory, hasScheduler,
  type CronJobSummary, type CreateCronInput, type UpdateCronInput,
} from "./cron";

export {
  listTools, getTool, toggleTool, updateToolMetadata,
  type ToolSummary,
} from "./tools";

export {
  listEthics, getEthics, createEthics, updateEthics, toggleEthics, deleteEthics,
  type EthicsSummary,
} from "./ethics";

export {
  listProviders, getProvider, createProvider, updateProvider, toggleProvider, deleteProvider,
  type ProviderSummary,
} from "./providers";

export {
  listModels, getModel, createModel, toggleModel, deleteModel, renameModel, agentsUsingModel,
  type ModelSummary,
} from "./models";

export {
  listMcpServers, getMcpServer, createMcpServer, updateMcpServer,
  testMcpServer, toggleMcpServer, deleteMcpServer,
  type McpServerSummary, type CreateMcpInput,
} from "./mcp";

export {
  createSwarm, getSwarm, listSwarms, updateSwarm, deleteSwarm, toggleSwarm, runSwarm,
  type SwarmSummary, type SwarmMember, type CreateSwarmInput, type UpdateSwarmInput,
  type RunSwarmOptions,
} from "./swarms";

export {
  createEndpoint, getEndpoint, listEndpoints, updateEndpoint, deleteEndpoint,
  toggleEndpoint, testEndpoint, registerEndpointTools, buildEndpointTool, toolNameFor,
  type EndpointSummary, type CreateEndpointInput,
} from "./endpoints";

export {
  planSeedFor, applySeedPlan, enableCatalogAgent, enableCatalogAgents,
  disableCatalogAgent, listEnabledCatalogAgents, listCatalogPersonas,
  planActivationFor, CATALOG_AGENT_IDS,
  type SeedPlan, type ActivationGap,
} from "./setup";

export {
  uploadImage, transformStoredImage, getImageBytes, listImages,
  setImageRetention, deleteImage, applyPreset, IMAGE_PRESETS,
  type StoredImage, type TransformResult, type TransformSource,
  type UploadOptions, type ServiceTransformOptions, type ImagePreset,
} from "./images";
