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
/** Consecutive contradictions after which the oracle is ignored for {@link DISTRUST_MS}. */
export const DISTRUST_STRIKES = 3
export const DISTRUST_MS = 5 * 60_000
/** Where the user turns an MCP server on, when the host does not say otherwise. */
export const DEFAULT_JEV_MCP_SETTINGS_PATH = "Ajustes → Entorno → MCP Servers"
let decisionSequence = 0

/**
 * How a caller controls the decision oracle for one run. The oracle is Jev
 * (OpenRouter's Decisions API) or Kev (the HiveAgents lab's own System One model);
 * both answer the same closed questions, so the runtime treats them alike.
 *
 * - `false`: the oracle is off for this run; nothing is sent anywhere.
 * - `undefined` or `{ provider: "auto" }`: the first one configured wins — HiveAgents
 *   (Kev) if its API key is configured, otherwise OpenRouter (Jev), otherwise no oracle.
 * - `{ provider: "openrouter" | "hiveagents" }`: only that one.
 * - `{ apiKey }`: use this key. A multi-tenant host resolves its tenant's key and
 *   passes it here, exactly like `credentials`. With no `provider` the key is
 *   OpenRouter's, or the lab's when `endpoint` is given (the shape this option had
 *   before `provider` existed).
 */
export type JevOption = {
  /** Which oracle. Default `"auto"`. */
  provider?: "auto" | "openrouter" | "hiveagents"
  /** The provider's key. Omit it to use the one configured in the secret store or the environment. */
  apiKey?: string
  mcpSettingsPath?: string
  /**
   * Full URL of a System One decisions endpoint. Default: OpenRouter's, or
   * `<HiveAgents base>/v1/systemone` for Kev. Set it to a self-hosted decision
   * model (llama.cpp serves `/v1/systemone`) and the turn's text never leaves your
   * own machine.
   */
  endpoint?: string
  /** Decision model name sent in the request. Default: `typesafe/jev-1.13` (Jev) or `kev` (Kev). */
  model?: string
  /**
   * What of the turn may travel to the decision model. All `true` by default
   * (the objective of the turn — the user's message — always travels: the oracle
   * cannot decide anything without it). Turning one off costs the decisions
   * that need it, never correctness: the runtime falls back to the classic path for them.
   */
  share?: JevShare
  /** Checks of what tools and the model produced. See {@link resolveVerify}. */
  verify?: JevVerify
} | false

/** The name of the option in new code; `JevOption` is kept for the hosts that already use it. */
export type OracleOption = JevOption

export interface JevVerify {
  /**
   * After each batch of tools, ask whether the results answer the objective and send the agent back
   * when they do not. Default `false`: measured against a local model, sending the agent back after
   * an empty result made it search again for something the base does not have (a question with no
   * documented answer is a correct, empty result), 3 to 10 times slower for the same answer.
   */
  tools?: boolean
  /** Before delivering an answer that rests on tool results, ask whether the evidence supports it. Default `true`. */
  answer?: boolean
  /** How many times per turn the oracle may send the agent back to correct. Default `2`; `0` turns checks into pure observation. */
  maxCorrections?: number
}

export interface JevShare {
  /** The excerpt of the agent's own instructions (system prompt). Without it Jev judges a tool by its name alone. */
  instructions?: boolean
  /** Excerpts of earlier conversation messages. Without them history is not pruned: every message is kept. */
  history?: boolean
  /** Excerpts of tool results and tool-call arguments. Without them Jev does not prune results between iterations nor decide parallelism. */
  toolResults?: boolean
}

/** Resolves a `share` option to explicit flags (default: everything is shared). */
export function resolveShare(option?: JevOption): Required<JevShare> {
  const share = option ? option.share : undefined
  return { instructions: share?.instructions !== false, history: share?.history !== false, toolResults: share?.toolResults !== false }
}

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
  /** Consecutive times the runtime found the oracle wrong; {@link DISTRUST_STRIKES} of them put it aside for a while. */
  strikes: number
}

const states = new Map<string, JevTenantState>()

function tenantState(): JevTenantState {
  const key = currentTenant() ?? "default"
  let state = states.get(key)
  if (!state) {
    state = { failures: 0, cooldownUntil: 0, lastError: null, lastSuccessAt: null, totals: { decisions: 0, savedTokens: 0, costUsd: 0 }, strikes: 0 }
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

export function resolveVerify(option?: JevOption): { tools: boolean; answer: boolean; maxCorrections: number } {
  const verify = option ? option.verify : undefined
  const max = verify?.maxCorrections
  return {
    tools: verify?.tools === true,
    answer: verify?.answer !== false,
    maxCorrections: typeof max === "number" && Number.isFinite(max) && max >= 0 ? Math.floor(max) : 2,
  }
}

/** A decision server ready to be asked. `kind` is only a label: Jev and Kev speak the same protocol. */
export interface ResolvedOracle {
  kind: "jev" | "kev"
  apiKey: string
  endpoint: string
  model: string
  /** A server that is not OpenRouter's: no per-call tariff. */
  selfHosted: boolean
}

const HIVEAGENTS_DEFAULT_BASE = "https://llm.hiveagents.io"

async function hiveAgentsBase(): Promise<string> {
  const row = await (await col<ProviderDoc>("providers")).get("hiveagents").catch(() => null)
  const base = row?.doc.base_url || envSecret("HIVEAGENTS_BASE_URL") || HIVEAGENTS_DEFAULT_BASE
  return base.replace(/\/+$/, "").replace(/\/v1$/, "")
}

async function kev(apiKey: string, option: Exclude<JevOption, false> | undefined): Promise<ResolvedOracle> {
  return { kind: "kev", apiKey, endpoint: option?.endpoint ?? `${await hiveAgentsBase()}/v1/systemone`, model: option?.model ?? "kev", selfHosted: true }
}

function jev(apiKey: string, option: Exclude<JevOption, false> | undefined): ResolvedOracle {
  return { kind: "jev", apiKey, endpoint: option?.endpoint ?? ENDPOINT, model: option?.model ?? JEV_MODEL, selfHosted: !!option?.endpoint }
}

/** The key of a provider from the tenant's secrets or, outside a tenant, from the environment. */
async function configuredKey(providerId: "hiveagents" | "openrouter"): Promise<string | null> {
  const envName = providerId === "hiveagents" ? "HIVEAGENTS_API_KEY" : "OPENROUTER_API_KEY"
  return (await loadProviderApiKey(providerId)) || envSecret(envName) || null
}

/**
 * Which oracle this run asks, or null when there is none (the classic path runs).
 *
 * With a tenant in scope keys come only from that tenant's secrets — never from
 * `OPENROUTER_API_KEY` / `HIVEAGENTS_API_KEY`, which are the platform's.
 */
export async function resolveOracle(option?: JevOption): Promise<ResolvedOracle | null> {
  if (option === false) return null
  const provider = option?.provider ?? "auto"

  if (option?.apiKey) {
    // An explicit key never falls through to another provider's.
    if (provider === "hiveagents" || (provider === "auto" && option.endpoint && option.endpoint !== ENDPOINT)) return kev(option.apiKey, option)
    return jev(option.apiKey, option)
  }

  if (provider === "hiveagents" || provider === "auto") {
    const key = await configuredKey("hiveagents")
    if (key) return kev(key, option)
    if (provider === "hiveagents") return null
  }

  // OpenRouter: its provider row (enabled and active) in the tenant's HiveDB decides.
  const row = await (await col<ProviderDoc>("providers")).get("openrouter")
  if (!row?.doc.enabled || !row.doc.active) return null
  const key = await configuredKey("openrouter")
  return key ? jev(key, option) : null
}

/**
 * The key of the oracle this run would ask, or null when there is none.
 * Kept for the hosts that call it; `resolveOracle` says which oracle it is.
 */
export async function getJevKey(option?: JevOption): Promise<string | null> {
  return (await resolveOracle(option))?.apiKey ?? null
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

/**
 * The runtime caught the oracle contradicting itself or the evidence: it said
 * "finish" and the answer did not hold, it pruned a result the model then asked
 * for again, it demanded a retry that produced the same evidence. One is noise;
 * {@link DISTRUST_STRIKES} in a row mean its decisions are not helping, so it is
 * ignored for {@link DISTRUST_MS} and every turn runs the classic path.
 * Returns true when this strike put the oracle aside.
 */
export function recordOracleOverruled(reason: string, option?: JevOption): boolean {
  const state = tenantState()
  state.strikes++
  log.warn(`Oracle overruled (${state.strikes}/${DISTRUST_STRIKES}): ${reason}`)
  if (state.strikes < DISTRUST_STRIKES) return false
  state.strikes = 0
  state.cooldownUntil = Date.now() + DISTRUST_MS
  state.lastError = `Oracle set aside after ${DISTRUST_STRIKES} contradictions in a row (last: ${reason})`
  log.warn(state.lastError)
  broadcastStatus(option)
  return true
}

/** The oracle's verdict held up (a `cumple` that nothing contradicted): the streak of contradictions ends. */
export function recordOracleAgreement(): void {
  tenantState().strikes = 0
}

/** Clears the current tenant's failure state (after its key changed, for instance). */
export function resetJevStatus(option?: JevOption): void {
  const state = tenantState()
  state.failures = 0
  state.cooldownUntil = 0
  state.lastError = null
  state.lastSuccessAt = null
  state.strikes = 0
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
  const oracle = await resolveOracle(options.jev).catch(() => null)
  const tenant = tenantState()
  if (!oracle || Date.now() < tenant.cooldownUntil || Object.keys(questions).length === 0) return null
  const started = performance.now()
  try {
    const { selfHosted } = oracle
    const response = await (options.fetcher ?? fetch)(oracle.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${oracle.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: oracle.model, state, questions }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) tenant.cooldownUntil = Date.now() + COOLDOWN_MS
      throw new Error(`${oracle.kind === "kev" ? "Kev" : "OpenRouter"} HTTP ${response.status}`)
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
