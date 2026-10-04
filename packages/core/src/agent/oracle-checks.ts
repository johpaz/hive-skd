/**
 * What the oracle (Jev or Kev) checks during one turn: do the tool results answer
 * the objective, and does the answer the model is about to deliver rest on them?
 *
 * The oracle only returns probabilities, never text, so the runtime owns what
 * happens next: a bounded number of fixed "go back and fix it" messages. Without
 * an oracle, or when it has no opinion, nothing here changes the turn.
 */

import { logger } from "../utils/logger"
import type { LLMMessage } from "./llm-client"
import { recordOracleAgreement, recordOracleOverruled, resolveOracle, resolveVerify, type JevOption } from "./jev-decisions"
import {
  verifyFinalAnswer,
  verifyToolResults,
  VERIFY_CONFIDENCE,
  type JevAgentProfile,
  type JevEvidence,
  type JevVerification,
} from "./jev-planner"

const log = logger.child("oracle-checks")

export type OracleCheckPublisher = (decision: { kind: "verify" | "answer" | "overruled"; summary: string; latencyMs: number; costUsd: number }) => Promise<void>

const MAX_EVIDENCE = 12

function percent(v: JevVerification): string {
  return `${Math.round(v.confidence * 100)}%`
}

/**
 * A result with nothing in it: `{}`, `[]`, `items[0]` (TOON) or a list-valued field that is empty.
 * It is a valid answer of the tool ("nothing about that"), not evidence for or against an answer.
 */
export function isEmptyResult(content: string): boolean {
  const text = content.trim()
  if (text.length === 0 || /^(\{\s*\}|\[\s*\]|null|undefined)$/.test(text)) return true
  // TOON writes an empty list as `field: items[0]:`; a lone `nota:` line is the tool saying why it is empty.
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean)
  const emptyList = (l: string) => /^\w+:\s*(?:items)?\[0\]:?$/.test(l)
  return lines.some(emptyList) && lines.every(l => emptyList(l) || /^(nota|note|message|mensaje):/i.test(l))
}

/** `name:arguments` of a tool call: what the loop compares to know "the same call again". */
export function toolCallSignature(call: { function: { name: string; arguments: unknown } }): string {
  return `${call.function.name}:${JSON.stringify(call.function.arguments)}`
}

export class TurnVerifier {
  private readonly config
  private active = false
  private readonly evidence: JevEvidence[] = []
  private readonly corrected = new Set<string>()
  private omittedSignatures = new Set<string>()
  private lastAction: string | null = null
  private lastBadEvidence: string | null = null
  /** How many times the oracle sent the agent back this turn. */
  corrections = 0
  /** The oracle still said `no_cumple` and there was nothing left to try: the host should say so honestly. */
  unsatisfied = false

  constructor(
    private readonly input: { jev?: JevOption; objective: string; agent: JevAgentProfile; publish: OracleCheckPublisher },
  ) {
    this.config = resolveVerify(input.jev)
  }

  /** Resolves once whether there is an oracle at all; every other method is a no-op without one. */
  async start(): Promise<void> {
    if (!this.config.tools && !this.config.answer) return
    this.active = !!(await resolveOracle(this.input.jev).catch(() => null))
  }

  /** The oracle was wrong about something the runtime could check: record it; enough in a row and it is set aside. */
  private async overruled(reason: string): Promise<void> {
    await this.input.publish({ kind: "overruled", summary: `Contradicción: ${reason}`.slice(0, 160), latencyMs: 0, costUsd: 0 })
    recordOracleOverruled(reason, this.input.jev)
  }

  /**
   * After the oracle planned an iteration: remember what it advised and which results it
   * omitted, as the calls that produced them. If the model asks for one of those again,
   * the result was needed after all.
   */
  noteIteration(plan: { action: string; omittedIds: number[] } | null, messages: LLMMessage[]): void {
    this.lastAction = plan?.action ?? null
    this.omittedSignatures = new Set()
    if (!plan) return
    for (const index of plan.omittedIds) {
      const id = messages[index]?.tool_call_id
      for (const message of messages) {
        const call = message.tool_calls?.find((tc) => tc.id === id)
        if (call) this.omittedSignatures.add(toolCallSignature(call))
      }
    }
  }

  /** The model asked for these tool calls. Repeating one the oracle had pruned is a contradiction. */
  async noteToolCalls(calls: Array<{ function: { name: string; arguments: unknown } }>): Promise<void> {
    if (!this.active || this.omittedSignatures.size === 0) return
    const again = calls.map(toolCallSignature).find((sig) => this.omittedSignatures.has(sig))
    this.omittedSignatures = new Set()
    if (again) await this.overruled(`pidió de nuevo un resultado omitido (${again.slice(0, 60)})`)
  }

  /** Remember a tool result as evidence for the answer check. Errors and empty results are not evidence. */
  collect(tool: string, content: string): void {
    if (!this.active || content.startsWith("[Tool Error]") || isEmptyResult(content)) return
    this.evidence.push({ tool, content })
    if (this.evidence.length > MAX_EVIDENCE) this.evidence.shift()
  }

  /**
   * Hold the streamed tokens of the next call until the answer is checked? Only when
   * a rejection could still change something: there is evidence and corrections left.
   */
  holdTokens(): boolean {
    return this.active && this.config.answer && this.evidence.length > 0 && this.corrections < this.config.maxCorrections
  }

  private reject(v: JevVerification | null, key: string): boolean {
    if (v?.verdict !== "no_cumple" || v.confidence < VERIFY_CONFIDENCE) return false
    if (this.corrections >= this.config.maxCorrections || this.corrected.has(key)) {
      this.unsatisfied = true
      return false
    }
    this.corrections++
    this.corrected.add(key)
    return true
  }

  /** After a batch of tools. Returns the message that sends the agent back, or null. */
  async afterTools(batch: JevEvidence[], signature: string): Promise<string | null> {
    if (!this.active || !this.config.tools || batch.length === 0) return null
    const verification = await verifyToolResults({ ...this.input, results: batch }).catch((err) => {
      log.warn(`verifyToolResults failed: ${(err as Error).message}`)
      return null
    })
    if (!verification) return null
    await this.input.publish({
      kind: "verify",
      summary: `Resultado de ${[...new Set(batch.map(b => b.tool))].join(", ")}: ${verification.verdict} (${percent(verification)})`,
      latencyMs: verification.decision.latencyMs,
      costUsd: verification.decision.costUsd,
    })
    const digest = batch.map(b => b.content).join("\u0000")
    if (verification.verdict === "cumple" && verification.confidence >= VERIFY_CONFIDENCE) {
      this.lastBadEvidence = null
      recordOracleAgreement()
    } else if (verification.verdict === "no_cumple" && verification.confidence >= VERIFY_CONFIDENCE) {
      // It sent the agent back and the retry found exactly the same: the correction led nowhere.
      if (this.lastBadEvidence === digest) await this.overruled("la corrección pedida devolvió la misma evidencia")
      this.lastBadEvidence = digest
    }
    if (!this.reject(verification, `tools:${signature}`)) return null
    return "[Verificación] Los resultados de las herramientas no responden a lo que se pidió. "
      + "Antes de contestar, busca de nuevo con otras palabras clave o usa otra fuente; "
      + "si ya agotaste las opciones, dilo con honestidad en vez de inventar."
  }

  /** Before delivering an answer that rests on tool results. Returns the message that asks for a rewrite, or null. */
  async checkAnswer(answer: string): Promise<string | null> {
    if (!this.active || !this.config.answer || this.evidence.length === 0 || !answer.trim()) return null
    const verification = await verifyFinalAnswer({ ...this.input, evidence: this.evidence, answer }).catch((err) => {
      log.warn(`verifyFinalAnswer failed: ${(err as Error).message}`)
      return null
    })
    if (!verification) return null
    await this.input.publish({
      kind: "answer",
      summary: `Respuesta: ${verification.verdict} (${percent(verification)})`,
      latencyMs: verification.decision.latencyMs,
      costUsd: verification.decision.costUsd,
    })
    if (verification.verdict === "cumple" && verification.confidence >= VERIFY_CONFIDENCE) recordOracleAgreement()
    else if (verification.verdict === "no_cumple" && verification.confidence >= VERIFY_CONFIDENCE && this.lastAction === "finish") {
      await this.overruled("aconsejó terminar y la respuesta no tenía respaldo")
    }
    if (!this.reject(verification, `answer:${this.corrections}`)) return null
    return "[Verificación] Tu respuesta no coincide con lo que devolvieron las herramientas "
      + "(dice que no hay información aunque la hay, la contradice o no responde). "
      + "Vuelve a escribirla usando únicamente esos resultados."
  }
}

/** What a worker's turn tells whoever delegated it about how far the oracle trusted the delivery. */
export interface OracleOutcome {
  corrections: number
  unsatisfied: boolean
}

export interface DelegationVerification {
  /** `unsupported`: the oracle never accepted the answer; `corrected`: it sent the worker back and the final version held. */
  status: "unsupported" | "corrected"
  corrections: number
  /** Written for the delegating agent (usually the coordinator), who is the one that speaks to the user. */
  note: string
}

/**
 * The part of a delegated result the coordinator needs to answer honestly. `null` when the oracle
 * had nothing to say (no oracle, nothing to check, or it agreed at the first attempt): then
 * the coordinator behaves exactly as it did before.
 */
export function describeVerification(outcome: OracleOutcome | null | undefined): DelegationVerification | null {
  if (!outcome) return null
  if (outcome.unsatisfied) {
    return {
      status: "unsupported",
      corrections: outcome.corrections,
      note: "La verificación no pudo confirmar que esta respuesta esté respaldada por la evidencia que recogió el especialista. "
        + "No la presentes como un hecho comprobado: dile al usuario con honestidad qué parte sí está respaldada y cuál no, "
        + "o que no pudiste comprobarla.",
    }
  }
  if (outcome.corrections > 0) {
    return {
      status: "corrected",
      corrections: outcome.corrections,
      note: "La verificación pidió corregir esta entrega y la versión final quedó respaldada. No hace falta mencionarlo.",
    }
  }
  return null
}
