/** Optional decision plane. Jev is never used through the chat completions API. */
import { col } from "../storage/hive"
import type { ProviderDoc } from "../storage/collections"
import { envSecret, loadProviderApiKey } from "../storage/crypto"
import { recordJevDecision, recordUsage } from "../storage/usage"
import { catalogModelKey } from "../storage/model-id"
import { currentTenant } from "../storage/tenant"
import { logger } from "../utils/logger"
import { emitCanvas, type CanvasJevDecision } from "../canvas/emitter"

const log = logger.child("jev-decisions")
export const JEV_MODEL = "typesafe/jev-1.13"
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
const TIMEOUT_MS = 3000
const COOLDOWN_MS = 60_000
/** Where the user turns an MCP server on, when the host does not say otherwise. */
export const DEFAULT_JEV_MCP_SETTINGS_PATH = "Ajustes → Entorno → MCP Servers"
let decisionSequence = 0

/**
 * How a caller controls Jev for one run.
 *
 * - `{ apiKey }`: use this OpenRouter key. A multi-tenant host resolves its
 *   tenant's key and passes it here, exactly like `credentials`.
 *   `mcpSettingsPath` names where that host's users turn an MCP server on.
 * - `false`: Jev is off for this run; nothing is sent to OpenRouter.
 * - `undefined`: the `openrouter` provider row of the current tenant decides.
 */
export type JevOption = {
  apiKey: string
  mcpSettingsPath?: string
  /**
   * Full URL of a System One decisions endpoint. Default: OpenRouter's. Set it
   * to a self-hosted decision model (llama.cpp serves `/v1/systemone`) and the
   * turn's text never leaves your own machine. `apiKey` is still required (any
   * non-empty string when the server does not check it).
   */
  endpoint?: string
  /** Decision model name sent in the request. Default: `typesafe/jev-1.13`. */
  model?: string
} | false

/**
 * Failure and cooldown bookkeeping, per tenant: one tenant's invalid key must
 * not put every other tenant in the same process into fallback.
 */
interface JevTenantState {
  failures: number
  cooldownUntil: number
  lastError: string | null
  lastSuccessAt: number | null
  /** Since process start; the office shows them as the oracle's running contribution. */
  totals: { decisions: number; savedTokens: number; costUsd: number }
}

const states = new Map<string, JevTenantState>()

function tenantState(): JevTenantState {
  const key = currentTenant() ?? "default"
  let state = states.get(key)
  if (!state) {
    state = { failures: 0, cooldownUntil: 0, lastError: null, lastSuccessAt: null, totals: { decisions: 0, savedTokens: 0, costUsd: 0 } }
    states.set(key, state)
  }
  return state
}

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }

export interface JevResult {
  answers: Record<string, JevAnswer>
  inputTokens: number
  costUsd: number
  latencyMs: number
}

/**
 * The OpenRouter key Jev would use, or null when Jev is off.
 *
 * With a tenant in scope the key comes only from that tenant's secrets —
 * never from `OPENROUTER_API_KEY`, which is the platform's.
 */
export async function getJevKey(option?: JevOption): Promise<string | null> {
  if (option === false) return null
  if (option) return option.apiKey || null
  const provider = await (await col<ProviderDoc>("providers")).get("openrouter")
  if (!provider?.doc.enabled || !provider.doc.active) return null
  return (await loadProviderApiKey("openrouter")) || envSecret("OPENROUTER_API_KEY") || null
}

export interface JevStatus {
  state: "off" | "ready" | "fallback"
  lastError: string | null
  lastSuccessAt: number | null
  totals: { decisions: number; savedTokens: number; costUsd: number }
}

export async function getJevStatus(option?: JevOption): Promise<JevStatus> {
  const key = await getJevKey(option).catch(() => null)
  const state = tenantState()
  return {
    state: !key ? "off" : Date.now() < state.cooldownUntil || state.lastError ? "fallback" : "ready",
    lastError: key ? state.lastError : null,
    lastSuccessAt: key ? state.lastSuccessAt : null,
    totals: { ...state.totals },
  }
}

function broadcastStatus(option?: JevOption): void {
  getJevStatus(option).then(status => emitCanvas("canvas:jev_status", status)).catch(() => { /* best effort */ })
}

/**
 * Publishes a served decision to the office and persists it for the dashboard.
 * Callers estimate savings; Jev itself only answers questions. `provider`/`model`
 * are the advised agent's main model, used to price the avoided tokens.
 * Returns the published event so the caller can forward it to its own host.
 */
export function emitJevDecision({ provider, model, ...decision }: Omit<CanvasJevDecision, "eventId" | "totals"> & { provider: string; model: string }): CanvasJevDecision {
  recordJevDecision({ agentId: decision.agentId, provider, model, savedTokens: decision.savedTokens, costUsd: decision.costUsd })
  const { totals } = tenantState()
  totals.decisions++
  totals.savedTokens += decision.savedTokens
  totals.costUsd += decision.costUsd
  const event = {
    ...decision,
    eventId: `jev:${Date.now().toString(36)}:${++decisionSequence}`,
    summary: decision.summary.slice(0, 160),
    totals: { ...totals },
  } satisfies CanvasJevDecision
  emitCanvas("canvas:jev_decision", event)
  return event
}

/** Clears the current tenant's failure state (after its key changed, for instance). */
export function resetJevStatus(option?: JevOption): void {
  const state = tenantState()
  state.failures = 0
  state.cooldownUntil = 0
  state.lastError = null
  state.lastSuccessAt = null
  broadcastStatus(option)
}

/**
 * Servers differ in how they spell the same answer. OpenRouter returns
 * `{ type, choice, confidence }` / `{ type, noul }`; llama.cpp's System One
 * returns `{ choice, probabilities }`, where the confidence of the choice is its
 * own probability. Accept both so the validation below stays strict.
 */
function normalizeAnswer(question: JevQuestion, raw: unknown): JevAnswer | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const answer = raw as Record<string, unknown>
  if (question.type === "choice") {
    const choice = answer.choice
    const probabilities = answer.probabilities as Record<string, number> | undefined
    const confidence = typeof answer.confidence === "number"
      ? answer.confidence
      : typeof choice === "string" ? probabilities?.[choice] : undefined
    return { type: "choice", choice: choice as string, confidence: confidence as number, probabilities: probabilities ?? {} } as JevAnswer
  }
  const noul = typeof answer.noul === "number" ? answer.noul : answer.probability
  return { type: "noul", noul: noul as number } as JevAnswer
}

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: { fetcher?: typeof fetch; signal?: AbortSignal; jev?: JevOption } = {},
): Promise<JevResult | null> {
  const key = await getJevKey(options.jev).catch(() => null)
  const tenant = tenantState()
  if (!key || Date.now() < tenant.cooldownUntil || Object.keys(questions).length === 0) return null
  const started = performance.now()
  try {
    const custom = options.jev ? options.jev : undefined
    const endpoint = custom?.endpoint ?? ENDPOINT
    const selfHosted = !!custom?.endpoint
    const response = await (options.fetcher ?? fetch)(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: custom?.model ?? JEV_MODEL, state, questions }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) tenant.cooldownUntil = Date.now() + COOLDOWN_MS
      throw new Error(`OpenRouter HTTP ${response.status}`)
    }
    const data = await response.json() as {
      answers?: Record<string, JevAnswer>
      usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
    }
    const answers: Record<string, JevAnswer> = {}
    for (const [name, question] of Object.entries(questions)) {
      const answer = normalizeAnswer(question, data.answers?.[name])
      if (question.type === "choice") {
        if (answer?.type !== "choice" || !Object.hasOwn(question.criteria, answer.choice) ||
          !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
          throw new Error(`Invalid choice answer: ${name}`)
        }
      } else if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
        throw new Error(`Invalid noul answer: ${name}`)
      }
      answers[name] = answer
    }
    const recovered = tenant.lastError !== null
    tenant.failures = 0
    tenant.lastError = null
    tenant.lastSuccessAt = Date.now()
    if (recovered) broadcastStatus(options.jev)
    const inputTokens = data.usage?.input_tokens ?? 0
    // A self-hosted decision model costs nothing per call and has no OpenRouter tariff.
    const costUsd = selfHosted ? 0 : data.usage?.cost ?? inputTokens * 0.042 / 1_000_000
    log.info(`Decision served: questions=${Object.keys(questions).join(",")} latency_ms=${Math.round(performance.now() - started)} input_tokens=${inputTokens} cost_usd=${costUsd}`)
    if (inputTokens > 0 && !selfHosted) {
      recordUsage({ provider: "openrouter", model: catalogModelKey("openrouter", JEV_MODEL), inputTokens, outputTokens: data.usage?.output_tokens ?? 0, latencyMs: Math.round(performance.now() - started) })
    }
    return { answers, inputTokens, costUsd, latencyMs: Math.round(performance.now() - started) }
  } catch (error) {
    if (options.signal?.aborted) return null
    tenant.failures++
    tenant.lastError = error instanceof Error ? error.message : "Jev unavailable"
    if (tenant.failures >= 3) tenant.cooldownUntil = Date.now() + COOLDOWN_MS
    log.warn(`Decision fallback: ${tenant.lastError}`)
    broadcastStatus(options.jev)
    return null
  }
}
