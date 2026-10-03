/**
 * Enjambre por roles — orquestador y trabajadores, con estrategia declarada.
 *
 * Es la tercera forma de armar un enjambre en Hive, y convive con las otras dos
 * a propósito:
 *
 *  - **Delegación por catálogo** (`agent/delegation-runtime.ts`, `task_delegate`):
 *    el coordinador decide a quién delegar en tiempo real, con criterios de
 *    aceptación y proof packets. El modelo elige la forma del trabajo.
 *  - **DAG de tareas** (`Coordinator.ts`): el grafo se conoce de antemano y el
 *    scheduler resuelve dependencias y concurrencia.
 *  - **Roles (esto)**: el enjambre es *configuración persistida* — una lista de
 *    agentes con rol y orden, y una estrategia. Quien lo define es un usuario en
 *    una UI, no el modelo ni el programador.
 *
 * La tercera no se puede expresar con las otras dos: un DAG exige conocer las
 * aristas, y acá la topología es la estrategia. Por eso existe.
 *
 * Este módulo no persiste nada: `onMessage` es el punto donde el consumidor
 * guarda cada paso donde quiera (Postgres, HiveDB, un log).
 */

import { runAgentIsolated } from "../agent/agent-loop"
import type { JevOption } from "../agent/jev-decisions"
import type { ProviderCredentials } from "../agent/llm-client"
import { logger } from "../utils/logger"

const log = logger.child("role-swarm")

export type SwarmStrategy = "sequential" | "parallel" | "hierarchical"

export interface RoleAgent {
  agentId: string
  role: "orchestrator" | "worker"
  /** Orden de ejecución en la estrategia secuencial. */
  orderIndex?: number
}

/** Un paso del enjambre, tal como se lo entrega a `onMessage`. */
export interface SwarmMessage {
  agentId: string
  role: "user" | "assistant"
  content: string
  stepIndex: number
}

/** Cómo se invoca a un agente. Se puede reemplazar para tests o para envolverlo. */
export type AgentInvoker = (input: {
  agentId: string
  message: string
  threadId: string
  channel?: string
  credentials?: ProviderCredentials
  jev?: JevOption
  signal?: AbortSignal
}) => Promise<string>

export const defaultInvoker: AgentInvoker = async (input) =>
  runAgentIsolated({
    agentId: input.agentId,
    taskDescription: input.message,
    threadId: input.threadId,
    channel: input.channel,
    credentials: input.credentials,
    jev: input.jev,
    signal: input.signal,
  })

export interface RoleSwarmOptions {
  /** Los agentes del enjambre, con su rol. */
  agents: RoleAgent[]
  strategy: SwarmStrategy
  input: string
  /** Identifica la corrida; también es el threadId del orquestador. */
  runId: string
  channel?: string
  /** Requerido por la estrategia jerárquica si ningún agente tiene rol orchestrator. */
  orchestratorAgentId?: string
  /**
   * Tope de delegaciones en la estrategia jerárquica.
   *
   * Sin esto, un orquestador que siga emitiendo `DELEGATE:` no termina nunca:
   * cada vuelta es una llamada al modelo, así que un bucle no es sólo lento, es
   * caro. Al agotarse se devuelve lo último que dijo el orquestador.
   */
  maxDelegations?: number
  /** Credenciales del inquilino, propagadas a cada agente. */
  credentials?: ProviderCredentials
  /** Jev del inquilino, propagado a cada agente igual que `credentials`. */
  jev?: JevOption
  signal?: AbortSignal
  /** Se llama en cada paso; acá persiste el consumidor si quiere. */
  onMessage?: (message: SwarmMessage) => void | Promise<void>
  /** Reemplaza la invocación real (tests, instrumentación). */
  invoke?: AgentInvoker
}

export interface RoleSwarmResult {
  output: string
  /** Llamadas al modelo, para contabilidad de uso. */
  agentCalls: number
  /** Delegaciones efectuadas (sólo jerárquica). */
  delegations: number
  /** true si la jerárquica se cortó por `maxDelegations`. */
  truncated: boolean
}

const DEFAULT_MAX_DELEGATIONS = 10

/**
 * `DELEGATE:<agente>:<subtarea>` y `FINAL:<respuesta>`.
 *
 * El `[\s\S]` en lugar de `.` es deliberado: una subtarea de varias líneas es lo
 * normal, y con `.` se cortaba en el primer salto de línea y el worker recibía
 * una instrucción truncada.
 */
const DELEGATE_RE = /DELEGATE:\s*([^\s:]+)\s*:\s*([\s\S]+?)(?=\nDELEGATE:|\nFINAL:|$)/
const FINAL_RE = /FINAL:\s*([\s\S]+)/

function orderedWorkers(agents: RoleAgent[]): RoleAgent[] {
  return [...agents].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
}

export async function runRoleSwarm(opts: RoleSwarmOptions): Promise<RoleSwarmResult> {
  const invoke = opts.invoke ?? defaultInvoker
  const emit = async (m: SwarmMessage) => { await opts.onMessage?.(m) }
  let agentCalls = 0

  const call = async (agentId: string, message: string, threadId: string) => {
    agentCalls++
    return invoke({
      agentId,
      message,
      threadId,
      channel: opts.channel,
      credentials: opts.credentials,
      jev: opts.jev,
      signal: opts.signal,
    })
  }

  if (opts.agents.length === 0) {
    throw new Error("Un enjambre necesita al menos un agente")
  }

  // ── Secuencial: la salida de cada uno es la entrada del siguiente ──────────
  if (opts.strategy === "sequential") {
    const agents = orderedWorkers(opts.agents)
    let context = opts.input
    for (const [i, agent] of agents.entries()) {
      await emit({ agentId: agent.agentId, role: "user", content: context, stepIndex: i })
      context = await call(agent.agentId, context, opts.runId)
      await emit({ agentId: agent.agentId, role: "assistant", content: context, stepIndex: i })
    }
    return { output: context, agentCalls, delegations: 0, truncated: false }
  }

  // ── Paralelo: todos ven la misma entrada; se concatenan las salidas ────────
  if (opts.strategy === "parallel") {
    const agents = orderedWorkers(opts.agents)
    const outputs = await Promise.all(
      agents.map(async (agent, i) => {
        await emit({ agentId: agent.agentId, role: "user", content: opts.input, stepIndex: i })
        // Hilo propio por agente: comparten la entrada, no la conversación.
        const out = await call(agent.agentId, opts.input, `${opts.runId}-${agent.agentId}`)
        await emit({ agentId: agent.agentId, role: "assistant", content: out, stepIndex: i })
        return out
      }),
    )
    return { output: outputs.join("\n\n---\n\n"), agentCalls, delegations: 0, truncated: false }
  }

  // ── Jerárquica: el orquestador delega hasta dar una respuesta final ────────
  const orchestratorId =
    opts.orchestratorAgentId ?? opts.agents.find((a) => a.role === "orchestrator")?.agentId
  if (!orchestratorId) {
    throw new Error("La estrategia jerárquica necesita un agente con rol orchestrator")
  }

  const workers = opts.agents.filter((a) => a.role === "worker")
  const workerIds = new Set(workers.map((w) => w.agentId))
  if (workerIds.size === 0) {
    throw new Error("La estrategia jerárquica necesita al menos un agente con rol worker")
  }

  const protocol = [
    `Eres el orquestador de un enjambre de agentes.`,
    `Agentes disponibles: ${[...workerIds].join(", ")}.`,
    `Para delegar usa el formato: DELEGATE:<agent_id>:<subtarea>`,
    `Cuando hayas terminado responde con: FINAL:<respuesta>`,
  ].join("\n")

  const firstInput = `${protocol}\n\nTarea: ${opts.input}`
  await emit({ agentId: orchestratorId, role: "user", content: firstInput, stepIndex: 0 })
  let output = await call(orchestratorId, firstInput, opts.runId)
  await emit({ agentId: orchestratorId, role: "assistant", content: output, stepIndex: 0 })

  const maxDelegations = opts.maxDelegations ?? DEFAULT_MAX_DELEGATIONS
  let delegations = 0
  let step = 1
  let truncated = false

  while (true) {
    const match = output.match(DELEGATE_RE)
    if (!match) break

    const delegateId = match[1]!.trim()
    const subtask = match[2]!.trim()

    if (!workerIds.has(delegateId)) {
      log.warn(`el orquestador delegó a "${delegateId}", que no está en el enjambre — se corta`)
      break
    }
    if (delegations >= maxDelegations) {
      log.warn(`tope de ${maxDelegations} delegaciones alcanzado — se corta con lo último del orquestador`)
      truncated = true
      break
    }

    await emit({ agentId: delegateId, role: "user", content: subtask, stepIndex: step })
    const workerOutput = await call(delegateId, subtask, `${opts.runId}-${delegateId}`)
    await emit({ agentId: delegateId, role: "assistant", content: workerOutput, stepIndex: step })
    delegations++
    step++

    const followUp = `Resultado de ${delegateId}: ${workerOutput}\n\nContinúa o responde con FINAL:<respuesta>`
    await emit({ agentId: orchestratorId, role: "user", content: followUp, stepIndex: step })
    output = await call(orchestratorId, followUp, opts.runId)
    await emit({ agentId: orchestratorId, role: "assistant", content: output, stepIndex: step })
    step++
  }

  const final = output.match(FINAL_RE)
  return {
    output: final ? final[1]!.trim() : output,
    agentCalls,
    delegations,
    truncated,
  }
}
