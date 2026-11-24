/**
 * Estadísticas de la evaluación: agrupar corridas por modo y por tipo de tarea y comparar los dos modos.
 * Puro: sin modelo ni red.
 */

import type { TaskKind } from "./tasks"

export type Mode = "history" | "sac"

export interface RunRecord {
  kind: TaskKind
  seed: number
  mode: Mode
  success: boolean
  /** Lo que respondió el worker, recortado. */
  answer: string
  /** Por qué no terminó (excepción, tiempo), si aplica. */
  error?: string
  /** Iteraciones del bucle del agente. */
  iterations: number
  /** Llamadas al modelo medidas en la red (acciones + actualizaciones de estado); null si no se pudieron medir. */
  modelCalls: number | null
  toolCalls: number
  inputTokens: number
  outputTokens: number
  elapsedMs: number
  /** Tamaño de la petición más grande a una llamada de acción, en KB; null si no se midió. */
  peakRequestKb: number | null
  /** Llamadas de herramienta fallidas repetidas idénticas. */
  repeatedFailures: number
  /**
   * El proveedor falló (503, 429…) y la tarea nunca llegó a evaluarse: no cuenta ni como acierto ni como fallo.
   * Se reintenta antes de rendirse; `attempts` dice cuántos intentos hicieron falta.
   */
  inconclusive?: boolean
  attempts?: number
}

export interface Summary {
  /** Corridas concluyentes: las únicas que entran en los promedios. */
  runs: number
  /** Corridas descartadas por fallo del proveedor. */
  excluded: number
  successRate: number
  avgModelCalls: number | null
  avgToolCalls: number
  avgInputTokens: number
  avgOutputTokens: number
  avgElapsedS: number
  avgPeakRequestKb: number | null
  avgRepeatedFailures: number
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** Promedio de los valores presentes; null si ninguna corrida lo midió. */
const meanOrNull = (xs: Array<number | null>): number | null => {
  const present = xs.filter((x): x is number => x !== null)
  return present.length ? mean(present) : null
}

export function summarize(all: RunRecord[]): Summary {
  const runs = all.filter((r) => !r.inconclusive)
  return {
    runs: runs.length,
    excluded: all.length - runs.length,
    successRate: runs.length ? runs.filter((r) => r.success).length / runs.length : 0,
    avgModelCalls: meanOrNull(runs.map((r) => r.modelCalls)),
    avgToolCalls: mean(runs.map((r) => r.toolCalls)),
    avgInputTokens: mean(runs.map((r) => r.inputTokens)),
    avgOutputTokens: mean(runs.map((r) => r.outputTokens)),
    avgElapsedS: mean(runs.map((r) => r.elapsedMs)) / 1000,
    avgPeakRequestKb: meanOrNull(runs.map((r) => r.peakRequestKb)),
    avgRepeatedFailures: mean(runs.map((r) => r.repeatedFailures)),
  }
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const item of items) (out[key(item)] ??= []).push(item)
  return out
}

export interface Comparison {
  /** Diferencia de la tasa de éxito en puntos porcentuales (sac − history). */
  successDeltaPp: number
  /** Cociente de tokens de entrada (sac / history); < 1 es ahorro. */
  inputTokensRatio: number | null
  /** Cociente del pico de tamaño de petición (sac / history). */
  peakRequestRatio: number | null
  /** Cociente de llamadas al modelo (sac / history). */
  modelCallsRatio: number | null
}

const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? a / b : null)

export function compare(history: Summary, sac: Summary): Comparison {
  return {
    successDeltaPp: (sac.successRate - history.successRate) * 100,
    inputTokensRatio: ratio(sac.avgInputTokens, history.avgInputTokens),
    peakRequestRatio: ratio(sac.avgPeakRequestKb, history.avgPeakRequestKb),
    modelCallsRatio: ratio(sac.avgModelCalls, history.avgModelCalls),
  }
}
