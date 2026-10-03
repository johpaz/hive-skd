/**
 * Agentes — la API, no la tool.
 *
 * Crear y editar agentes sólo se podía por dos caminos, y ninguno servía para
 * una UI: `agentCreateTool` (argumentos con forma de LLM) o consultas crudas a
 * la colección `agents`. En hive el CRUD vive inline en `gateway/routes/agents.ts`.
 *
 * Una diferencia deliberada con hive: **acá se valida que las referencias
 * existan**. Su ruta guarda `tools_json`, `skills_json` y `mcp_server_ids_json`
 * tal cual llegan, sin comprobar nada, así que un id mal escrito no falla al
 * guardar sino más tarde, cuando el agente intenta usar una capacidad que no
 * existe — lejos de donde está el error. Validar al escribir cuesta tres
 * consultas y ahorra ese viaje.
 *
 * Lo que NO hace, a propósito: tocar las filas de `tools`/`skills` al crear o
 * borrar un agente. Son colecciones globales compartidas entre todos los
 * agentes; borrar las de uno rompería a otro que las usa.
 */

import { col, toIndexable, fromIndexable, NO_PARENT } from "../storage/hive";
import type { AgentDoc, ToolDoc, SkillDoc, McpServerDoc } from "../storage/collections";
import { deleteAgentSecrets } from "../storage/crypto";
import { expandToolAllowlist } from "../agent/delegation-runtime";
import { logger } from "../utils/logger";

const log = logger.child("services/agents");

export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  role: AgentDoc["role"];
  status: string;
  enabled: boolean;
  providerId: string | null;
  modelId: string | null;
  /** Patrones declarados (`fs_*`), no la expansión. */
  toolPatterns: string[];
  skills: string[];
  mcpServerIds: string[];
  /** `"catalog"` = persona sembrada; `"user"` = creada por alguien. */
  source: "user" | "catalog";
  systemPrompt: string | null;
  thinking: "off" | "auto" | "on";
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentInput {
  id?: string;
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  role?: AgentDoc["role"];
  providerId?: string | null;
  modelId?: string | null;
  /** Acepta globs (`fs_*`); se validan tras expandir. */
  toolPatterns?: string[];
  skills?: string[];
  mcpServerIds?: string[];
  userId?: string;
  maxIterations?: number;
  /** Ver `AgentDoc.thinking`. */
  thinking?: "off" | "auto" | "on";
  /** Ver `AgentDoc.max_output_tokens`. */
  maxOutputTokens?: number | null;
  enabled?: boolean;
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "id">>;

/**
 * Convierte un nombre en id.
 *
 * Normaliza los acentos antes de filtrar: sin eso "Efímero" queda como
 * `ef_mero` y "Diseño" como `dise_o`, porque la í y la ñ no son `[a-z0-9]`.
 * Para un producto en español eso no es un detalle cosmético.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function parseList(json: string | null | undefined): string[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toSummary(doc: AgentDoc): AgentSummary {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    role: doc.role,
    status: doc.status,
    enabled: doc.enabled,
    providerId: fromIndexable(doc.provider_id),
    modelId: fromIndexable(doc.model_id),
    toolPatterns: parseList(doc.tool_allowlist_json ?? doc.tools_json),
    skills: parseList(doc.skills_json),
    mcpServerIds: parseList(doc.mcp_server_ids_json),
    source: doc.source ?? "user",
    systemPrompt: doc.system_prompt,
    thinking: doc.thinking ?? "on",
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

async function agentsCol() {
  return col<AgentDoc>("agents");
}

/**
 * Comprueba que lo que se le asigna al agente exista de verdad.
 *
 * Los patrones de tools se expanden primero contra el registro vivo
 * (`expandToolAllowlist`): un `fs_*` que no case con ninguna tool es un error
 * de quien lo escribió, no una lista vacía silenciosa.
 */
async function validateReferences(input: {
  toolPatterns?: string[];
  skills?: string[];
  mcpServerIds?: string[];
}): Promise<void> {
  const problemas: string[] = [];

  if (input.toolPatterns?.length) {
    const expandidas = expandToolAllowlist(input.toolPatterns);
    if (expandidas.length === 0) {
      problemas.push(`ninguna tool coincide con ${JSON.stringify(input.toolPatterns)}`);
    } else {
      const c = await col<ToolDoc>("tools");
      const faltan: string[] = [];
      for (const name of expandidas) if (!(await c.get(name))) faltan.push(name);
      if (faltan.length) problemas.push(`tools inexistentes: ${faltan.join(", ")}`);
    }
  }

  if (input.skills?.length) {
    const c = await col<SkillDoc>("skills");
    const faltan: string[] = [];
    for (const id of input.skills) if (!(await c.get(id))) faltan.push(id);
    if (faltan.length) problemas.push(`skills inexistentes: ${faltan.join(", ")}`);
  }

  if (input.mcpServerIds?.length) {
    const c = await col<McpServerDoc>("mcpServers");
    const faltan: string[] = [];
    for (const id of input.mcpServerIds) if (!(await c.get(id))) faltan.push(id);
    if (faltan.length) problemas.push(`servidores MCP inexistentes: ${faltan.join(", ")}`);
  }

  if (problemas.length) throw new Error(problemas.join("; "));
}

export async function createAgent(input: CreateAgentInput): Promise<AgentSummary> {
  if (!input.name?.trim()) throw new Error("El agente necesita un nombre");
  await validateReferences(input);

  const c = await agentsCol();
  const id = input.id ?? slugify(input.name);
  if (await c.get(id)) throw new Error(`Ya existe un agente con id "${id}"`);

  const now = Date.now();
  const doc: AgentDoc = {
    id,
    user_id: input.userId ?? "",
    name: input.name,
    description: input.description ?? null,
    system_prompt: input.systemPrompt ?? null,
    tone: null,
    role: input.role ?? "worker",
    status: "idle",
    enabled: input.enabled ?? true,
    provider_id: toIndexable(input.providerId ?? null),
    model_id: toIndexable(input.modelId ?? null),
    tools_json: input.toolPatterns ? JSON.stringify(expandToolAllowlist(input.toolPatterns)) : null,
    skills_json: input.skills ? JSON.stringify(input.skills) : null,
    parent_id: NO_PARENT,
    max_iterations: input.maxIterations ?? 10,
    thinking: input.thinking,
    max_output_tokens: input.maxOutputTokens ?? null,
    workspace: null,
    lastTraceAt: null,
    created_at: now,
    updated_at: now,
    source: "user",
    // Los patrones se guardan sin expandir: `task_delegate` los vuelve a
    // expandir en cada delegación, así una tool registrada después igual entra.
    tool_allowlist_json: input.toolPatterns ? JSON.stringify(input.toolPatterns) : null,
    mcp_server_ids_json: input.mcpServerIds ? JSON.stringify(input.mcpServerIds) : null,
  };

  await c.put(id, doc, { expectedVersion: 0 });
  log.info(`agente "${input.name}" creado (${id})`);
  return toSummary(doc);
}

export async function getAgent(id: string): Promise<AgentSummary | null> {
  const entry = await (await agentsCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

export interface ListAgentsOptions {
  role?: AgentDoc["role"];
  source?: "user" | "catalog";
  includeDisabled?: boolean;
}

export async function listAgents(opts?: ListAgentsOptions): Promise<AgentSummary[]> {
  const rows = await (await agentsCol()).scan({});
  return rows
    .map((e) => e.doc)
    .filter((d) => (opts?.role ? d.role === opts.role : true))
    .filter((d) => (opts?.source ? (d.source ?? "user") === opts.source : true))
    .filter((d) => (opts?.includeDisabled ? true : d.enabled))
    .map(toSummary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateAgent(id: string, changes: UpdateAgentInput): Promise<AgentSummary> {
  await validateReferences(changes);

  const c = await agentsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el agente "${id}"`);

  const doc: AgentDoc = { ...entry.doc, updated_at: Date.now() };
  if (changes.name !== undefined) doc.name = changes.name;
  if (changes.description !== undefined) doc.description = changes.description;
  if (changes.systemPrompt !== undefined) doc.system_prompt = changes.systemPrompt;
  if (changes.role !== undefined) doc.role = changes.role;
  if (changes.enabled !== undefined) doc.enabled = changes.enabled;
  if (changes.thinking !== undefined) doc.thinking = changes.thinking;
  if (changes.maxOutputTokens !== undefined) doc.max_output_tokens = changes.maxOutputTokens;
  if (changes.maxIterations !== undefined) doc.max_iterations = changes.maxIterations;
  if (changes.providerId !== undefined) doc.provider_id = toIndexable(changes.providerId);
  if (changes.modelId !== undefined) doc.model_id = toIndexable(changes.modelId);
  if (changes.toolPatterns !== undefined) {
    doc.tool_allowlist_json = JSON.stringify(changes.toolPatterns);
    doc.tools_json = JSON.stringify(expandToolAllowlist(changes.toolPatterns));
  }
  if (changes.skills !== undefined) doc.skills_json = JSON.stringify(changes.skills);
  if (changes.mcpServerIds !== undefined) doc.mcp_server_ids_json = JSON.stringify(changes.mcpServerIds);

  await c.put(id, doc, { expectedVersion: entry.version });
  return toSummary(doc);
}

/** Atajos legibles sobre `updateAgent`, que es lo que una UI llama al editar. */
export const assignTools = (id: string, toolPatterns: string[]) => updateAgent(id, { toolPatterns });
export const assignSkills = (id: string, skills: string[]) => updateAgent(id, { skills });
export const assignMcpServers = (id: string, mcpServerIds: string[]) => updateAgent(id, { mcpServerIds });

export const enableAgent = (id: string) => updateAgent(id, { enabled: true });
export const disableAgent = (id: string) => updateAgent(id, { enabled: false });

/**
 * Borra el agente y sus secretos. **No toca sus tools ni sus skills**: son
 * filas globales que otros agentes comparten.
 */
export async function deleteAgent(id: string): Promise<boolean> {
  const c = await agentsCol();
  if (!(await c.get(id))) return false;
  await c.delete(id);
  await deleteAgentSecrets(id).catch(() => {});
  log.info(`agente ${id} borrado (sus tools y skills quedan: son compartidas)`);
  return true;
}
