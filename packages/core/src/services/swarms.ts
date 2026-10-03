/**
 * Enjambres — guardarlos, no sólo correrlos.
 *
 * `runRoleSwarm()` (swarm/RoleSwarm.ts) recibe los agentes en la llamada y no
 * persiste nada: un enjambre existía sólo mientras se ejecutaba. Quien armara
 * uno desde una interfaz lo perdía al cerrar la ventana. Ese era el bloqueador
 * real para poner una UI encima del SDK — más que cualquier CRUD faltante.
 *
 * Este servicio guarda la definición y `runSwarm()` la carga y la ejecuta. La
 * ejecución en sí no cambia: sigue siendo `runRoleSwarm`.
 *
 * Se valida al guardar, no al correr. Un enjambre jerárquico sin orquestador, o
 * con un agente que ya no existe, es un error de configuración: descubrirlo
 * cuando alguien lo ejecuta —posiblemente semanas después— es descubrirlo tarde.
 */

import { col } from "../storage/hive";
import type { SwarmDoc, SwarmMemberSpec, AgentDoc } from "../storage/collections";
import { runRoleSwarm, type RoleSwarmResult, type SwarmMessage } from "../swarm/RoleSwarm";
import type { ProviderCredentials } from "../agent/llm-client";
import type { JevOption } from "../agent/jev-decisions";
import { slugify } from "./agents";
import { logger } from "../utils/logger";
import { enableCatalogAgents, planActivationFor, CATALOG_AGENT_IDS, type ActivationGap } from "./setup";

const log = logger.child("services/swarms");

export interface SwarmMember {
  agentId: string;
  role: "orchestrator" | "worker";
  orderIndex: number;
}

export interface SwarmSummary {
  id: string;
  name: string;
  description: string | null;
  strategy: SwarmDoc["strategy"];
  orchestratorAgentId: string | null;
  members: SwarmMember[];
  enabled: boolean;
  maxDelegations: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Lo que hace falta encender para que este enjambre pueda trabajar.
   *
   * Un enjambre puede nombrar especialistas que el usuario no activó al
   * instalar: la fila del agente existe igual (el seed las crea todas y sólo
   * cambia `enabled`), así que sin esto el enjambre se guardaría sin una queja
   * y correría con agentes apagados y sus tools inactivas. Vacío = listo para
   * correr. Sólo lo traen `createSwarm` y `updateSwarm`.
   */
  pendingActivation?: ActivationGap;
}

export interface CreateSwarmInput {
  id?: string;
  name: string;
  description?: string | null;
  strategy: SwarmDoc["strategy"];
  members: Array<{ agentId: string; role?: "orchestrator" | "worker"; orderIndex?: number }>;
  orchestratorAgentId?: string | null;
  maxDelegations?: number | null;
  enabled?: boolean;
  /**
   * Encender los especialistas del enjambre y sembrar sus tools y skills.
   *
   * `false` por defecto **a propósito**: crear un enjambre no debería cambiar
   * en silencio qué capacidades tiene la instalación entera. Con `false` el
   * enjambre se crea igual y el faltante vuelve en `pendingActivation`, para
   * que la UI lo muestre y el usuario decida. Con `true` se activa la unión con
   * lo que ya estaba: encender un especialista nunca apaga los de otro enjambre.
   */
  activateMembers?: boolean;
}

export type UpdateSwarmInput = Partial<Omit<CreateSwarmInput, "id">>;

function parseMembers(json: string): SwarmMember[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as SwarmMemberSpec[]) : [];
  } catch {
    return [];
  }
}

function toSummary(doc: SwarmDoc): SwarmSummary {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    strategy: doc.strategy,
    orchestratorAgentId: doc.orchestrator_agent_id,
    members: parseMembers(doc.agents_json),
    enabled: doc.enabled,
    maxDelegations: doc.max_delegations,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

async function swarmsCol() {
  return col<SwarmDoc>("swarms");
}

/**
 * Normaliza y valida los integrantes.
 *
 * Un enjambre jerárquico necesita un orquestador y al menos un trabajador; los
 * otros dos modos no admiten orquestador, porque no hay a quién delegar.
 */
async function normalizeMembers(
  input: CreateSwarmInput | UpdateSwarmInput,
  strategy: SwarmDoc["strategy"],
): Promise<{ members: SwarmMember[]; orchestratorId: string | null }> {
  const raw = input.members ?? [];
  if (raw.length === 0) throw new Error("Un enjambre necesita al menos un agente");

  // Un id del catálogo es válido aunque todavía no tenga fila: con el seed en
  // `"none"` los especialistas no se crean hasta que alguien los pide, y este
  // enjambre es justamente el pedido. La fila la crea `withActivation`.
  // Rechazarlos acá haría imposible armar un enjambre en una instalación limpia.
  const delCatalogo = new Set<string>(CATALOG_AGENT_IDS);
  const agentsCol = await col<AgentDoc>("agents");
  const faltan: string[] = [];
  for (const m of raw) {
    if (delCatalogo.has(m.agentId)) continue;
    if (!(await agentsCol.get(m.agentId))) faltan.push(m.agentId);
  }
  if (faltan.length) throw new Error(`agentes inexistentes: ${faltan.join(", ")}`);

  const members: SwarmMember[] = raw.map((m, i) => ({
    agentId: m.agentId,
    role: m.role ?? "worker",
    orderIndex: m.orderIndex ?? i,
  }));

  const declarado = input.orchestratorAgentId ?? null;
  const porRol = members.find((m) => m.role === "orchestrator")?.agentId ?? null;
  const orchestratorId = declarado ?? porRol;

  if (strategy === "hierarchical") {
    if (!orchestratorId) throw new Error("La estrategia jerárquica necesita un orquestador");
    if (!members.some((m) => m.role === "worker")) {
      throw new Error("La estrategia jerárquica necesita al menos un agente con rol worker");
    }
    if (!members.some((m) => m.agentId === orchestratorId)) {
      members.push({ agentId: orchestratorId, role: "orchestrator", orderIndex: -1 });
    }
  }

  return { members, orchestratorId: strategy === "hierarchical" ? orchestratorId : null };
}

export async function createSwarm(input: CreateSwarmInput): Promise<SwarmSummary> {
  if (!input.name?.trim()) throw new Error("El enjambre necesita un nombre");

  const c = await swarmsCol();
  const id = input.id ?? slugify(input.name);
  if (await c.get(id)) throw new Error(`Ya existe un enjambre con id "${id}"`);

  const { members, orchestratorId } = await normalizeMembers(input, input.strategy);
  const now = Date.now();
  const doc: SwarmDoc = {
    id,
    name: input.name,
    description: input.description ?? null,
    strategy: input.strategy,
    orchestrator_agent_id: orchestratorId,
    agents_json: JSON.stringify(members),
    enabled: input.enabled ?? true,
    max_delegations: input.maxDelegations ?? null,
    created_at: now,
    updated_at: now,
  };

  await c.put(id, doc, { expectedVersion: 0 });
  log.info(`enjambre "${input.name}" guardado (${id}, ${input.strategy}, ${members.length} agentes)`);
  return withActivation(doc, members, input.activateMembers);
}

/**
 * Resuelve la activación de los especialistas del enjambre y adjunta el
 * faltante al resumen.
 *
 * Corre DESPUÉS de guardar la fila: si el sembrado fallara a mitad, el enjambre
 * ya está persistido y el usuario puede reintentar la activación desde la UI.
 * Al revés perdería la definición del enjambre por un problema del catálogo.
 */
async function withActivation(
  doc: SwarmDoc,
  members: SwarmMember[],
  activar: boolean | undefined,
): Promise<SwarmSummary> {
  const ids = members.map((m) => m.agentId);
  if (activar) {
    const gap = await planActivationFor(ids);
    if (gap.agents.length > 0) {
      await enableCatalogAgents(gap.agents);
      log.info(`enjambre "${doc.id}": activados ${gap.agents.join(", ")}`);
    }
  }
  // Se recalcula después de activar: así `pendingActivation` refleja lo que
  // quedó pendiente de verdad, no lo que faltaba antes de encender nada.
  return { ...toSummary(doc), pendingActivation: await planActivationFor(ids) };
}

export async function getSwarm(id: string): Promise<SwarmSummary | null> {
  const entry = await (await swarmsCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

export async function listSwarms(opts?: { includeDisabled?: boolean }): Promise<SwarmSummary[]> {
  const rows = await (await swarmsCol()).scan({});
  return rows
    .map((e) => e.doc)
    .filter((d) => (opts?.includeDisabled ? true : d.enabled))
    .map(toSummary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateSwarm(id: string, changes: UpdateSwarmInput): Promise<SwarmSummary> {
  const c = await swarmsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el enjambre "${id}"`);

  const doc: SwarmDoc = { ...entry.doc, updated_at: Date.now() };
  if (changes.name !== undefined) doc.name = changes.name;
  if (changes.description !== undefined) doc.description = changes.description;
  if (changes.enabled !== undefined) doc.enabled = changes.enabled;
  if (changes.maxDelegations !== undefined) doc.max_delegations = changes.maxDelegations;

  const estrategia = changes.strategy ?? entry.doc.strategy;
  if (changes.strategy !== undefined) doc.strategy = changes.strategy;

  // Cambiar la estrategia revalida los integrantes: pasar a jerárquico sin
  // orquestador tiene que fallar acá, no al ejecutarlo.
  if (changes.members !== undefined || changes.strategy !== undefined || changes.orchestratorAgentId !== undefined) {
    const { members, orchestratorId } = await normalizeMembers(
      { ...changes, members: changes.members ?? parseMembers(entry.doc.agents_json) },
      estrategia,
    );
    doc.agents_json = JSON.stringify(members);
    doc.orchestrator_agent_id = orchestratorId;
  }

  await c.put(id, doc, { expectedVersion: entry.version });
  // Agregar un especialista a un enjambre que ya existe pasa por el mismo
  // camino que crearlo: si no, el enjambre editado quedaría con un miembro
  // apagado y nadie se enteraría.
  return withActivation(doc, parseMembers(doc.agents_json), changes.activateMembers);
}

export const toggleSwarm = (id: string, enabled: boolean) => updateSwarm(id, { enabled });

export async function deleteSwarm(id: string): Promise<boolean> {
  const c = await swarmsCol();
  if (!(await c.get(id))) return false;
  await c.delete(id);
  // Los agentes no se tocan: pertenecen a la colmena, no al enjambre.
  return true;
}

export interface RunSwarmOptions {
  /** Identifica la corrida; por defecto se genera uno. */
  runId?: string;
  channel?: string;
  /** Credenciales del inquilino, propagadas a cada agente. */
  credentials?: ProviderCredentials;
  /** Jev del inquilino, propagado a cada agente igual que `credentials`. */
  jev?: JevOption;
  signal?: AbortSignal;
  /** Se llama en cada paso; acá persiste el consumidor si quiere. */
  onMessage?: (message: SwarmMessage) => void | Promise<void>;
}

/**
 * Carga un enjambre guardado y lo ejecuta.
 *
 * Un enjambre deshabilitado no corre: apagarlo tiene que significar algo, o el
 * interruptor de la UI es decorativo.
 */
export async function runSwarm(
  swarmId: string,
  input: string,
  opts?: RunSwarmOptions,
): Promise<RoleSwarmResult> {
  const swarm = await getSwarm(swarmId);
  if (!swarm) throw new Error(`No existe el enjambre "${swarmId}"`);
  if (!swarm.enabled) throw new Error(`El enjambre "${swarmId}" está deshabilitado`);

  return runRoleSwarm({
    agents: swarm.members.map((m) => ({
      agentId: m.agentId,
      role: m.role,
      orderIndex: m.orderIndex,
    })),
    strategy: swarm.strategy,
    input,
    runId: opts?.runId ?? `swarm-${swarmId}-${Date.now()}`,
    channel: opts?.channel,
    orchestratorAgentId: swarm.orchestratorAgentId ?? undefined,
    maxDelegations: swarm.maxDelegations ?? undefined,
    credentials: opts?.credentials,
    jev: opts?.jev,
    signal: opts?.signal,
    onMessage: opts?.onMessage,
  });
}
