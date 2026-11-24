#!/usr/bin/env bun
/**
 * Benchmark de compactación: ¿cuánto de lo importante sobrevive a varias compactaciones seguidas?
 *
 *   # Validar la tubería, sin red ni gasto (resultados NO interpretables):
 *   bun bench/compaction/run.ts --fake
 *
 *   # Corrida real con la credencial que guarda hive (se lee en memoria con el código de hive):
 *   bun bench/compaction/run.ts --hive-credentials --provider gemini --model gemini-3.8-flash --probe
 *
 *   # Corrida real con la clave en una variable de entorno; nunca se imprime:
 *   GEMINI_API_KEY=... bun bench/compaction/run.ts --provider gemini --model gemini-3.8-flash --probe
 *
 * Opciones: --seeds 3 (cuántos escenarios, o una lista 1,2,3) · --segments 4 · --per-segment 30
 *           --variants handoff-v1,handoff (solo esas) · --probe (además, preguntas respondidas solo con el resumen)
 *           --out resultados.json
 *           --api-key-env NOMBRE (por defecto <PROVEEDOR>_API_KEY) · --hive-repo RUTA (por defecto ../hive)
 */

import { writeFileSync } from "node:fs"
import { estimateTokens } from "../../packages/core/src/utils/toon"
import { resolve } from "node:path"
import { fakeLlm, hiveCredentialLlm, probe, realLlm } from "./llm"
import { buildScenario, type ItemKind } from "./scenario"
import { aggregate, scoreRetention, type Aggregate, type Retention } from "./score"
import { VARIANTS, type Llm } from "./variants"

interface Args {
  provider: string
  model: string
  seeds: number[]
  segments: number
  perSegment: number
  variants?: string[]
  probe: boolean
  fake: boolean
  hiveCredentials: boolean
  hiveRepo: string
  out?: string
  apiKeyEnv?: string
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const seedsArg = get("seeds") ?? "3"
  const seeds = seedsArg.includes(",")
    ? seedsArg.split(",").map((s) => Number(s.trim()))
    : Array.from({ length: Number(seedsArg) }, (_, i) => i + 1)
  if (seeds.some((s) => !Number.isFinite(s))) throw new Error(`--seeds inválido: ${seedsArg}`)
  return {
    provider: get("provider") ?? "gemini",
    model: get("model") ?? "gemini-3.8-flash",
    seeds,
    segments: Number(get("segments") ?? 4),
    perSegment: Number(get("per-segment") ?? 30),
    variants: get("variants")?.split(",").map((v) => v.trim()),
    probe: argv.includes("--probe"),
    fake: argv.includes("--fake"),
    hiveCredentials: argv.includes("--hive-credentials"),
    hiveRepo: resolve(get("hive-repo") ?? `${import.meta.dir}/../../../hive`),
    out: get("out"),
    apiKeyEnv: get("api-key-env"),
  }
}

const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(0)} %`)

async function main() {
  const args = parseArgs(process.argv.slice(2))

  let llm: Llm
  if (args.fake) {
    llm = fakeLlm()
    console.log("⚠ MODELO FALSO: valida la tubería, los números NO significan nada.\n")
  } else if (args.hiveCredentials) {
    try {
      const hive = await hiveCredentialLlm({ provider: args.provider, model: args.model, hiveRepo: args.hiveRepo })
      llm = hive.llm
      console.log(`Credencial de hive: ${args.provider}, clave presente (${hive.keyChars} caracteres, no se muestra).\n`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : err)
      process.exit(2)
    }
  } else {
    const envName = args.apiKeyEnv ?? `${args.provider.toUpperCase()}_API_KEY`
    const apiKey = process.env[envName]
    if (!apiKey) {
      console.error(
        `Falta la clave: define ${envName} en el entorno (no se imprime ni se guarda).\n` +
          `Ejemplo:  ${envName}=... bun bench/compaction/run.ts --provider ${args.provider} --model ${args.model}`,
      )
      process.exit(2)
    }
    llm = realLlm({ provider: args.provider, model: args.model, apiKey })
  }

  const variants = args.variants ? VARIANTS.filter((v) => args.variants!.includes(v.name)) : VARIANTS
  if (variants.length === 0) {
    console.error(`--variants no coincide con ninguna: ${VARIANTS.map((v) => v.name).join(", ")}`)
    process.exit(2)
  }
  const callsPer = args.segments
  const planned = args.seeds.length * variants.length * (callsPer + (args.probe ? 1 : 0))
  console.log(
    `Modelo: ${args.fake ? "fake" : `${args.provider}/${args.model}`} · escenarios: ${args.seeds.length} ` +
      `· ${args.segments} tramos de ${args.perSegment} mensajes · llamadas previstas: ~${planned}\n`,
  )

  type RunRecord = { seed: number; summary: string; retention: Retention; probe?: Retention; summaryTokens: number; calls: number; failures: number }
  const results: Record<string, RunRecord[]> = {}
  for (const seed of args.seeds) {
    const scenario = buildScenario(seed, { segments: args.segments, messagesPerSegment: args.perSegment })
    for (const variant of variants) {
      const run = await variant.run(scenario, llm)
      const retention = scoreRetention(run.summary, scenario.items, run.finalCutIndex)
      let probeScore: Retention | undefined
      let extraCalls = 0
      if (args.probe && run.summary) {
        extraCalls = 1
        const considered = scenario.items.filter((i) => i.messageIndex < run.finalCutIndex)
        const answers = await probe(llm, run.summary, considered)
        probeScore = scoreRetention(run.summary, scenario.items, run.finalCutIndex, answers)
      }
      ;(results[variant.name] ??= []).push({
        seed,
        summary: run.summary,
        retention,
        probe: probeScore,
        summaryTokens: estimateTokens(run.summary),
        calls: run.calls + extraCalls,
        failures: run.failures,
      })
      console.log(`  semilla ${seed} · ${variant.name}: retención ${pct(retention.rate)}${probeScore ? ` · preguntas ${pct(probeScore.rate)}` : ""}`)
    }
  }

  const summary: Record<string, Aggregate> = Object.fromEntries(
    Object.entries(results).map(([name, runs]) => [name, aggregate(runs)]),
  )
  report(summary, args)
  reportLostItems(results)
  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ args, summary, runs: results }, null, 2))
    console.log(`\nResultados guardados en ${args.out}`)
  }
}

/** Qué datos se pierden, y en cuántos escenarios: dice DÓNDE falla cada variante, no solo cuánto. */
function reportLostItems(results: Record<string, Array<{ seed: number; retention: Retention }>>) {
  console.log("\n## Datos plantados: en cuántos escenarios sobrevivió cada uno\n")
  const ids = [...new Set(Object.values(results).flatMap((runs) => runs.flatMap((r) => Object.keys(r.retention.perItem))))]
  console.log(`| dato | ${Object.keys(results).join(" | ")} |`)
  console.log(`|---|${Object.keys(results).map(() => "---").join("|")}|`)
  for (const id of ids) {
    const cells = Object.values(results).map((runs) => {
      const seen = runs.filter((r) => id in r.retention.perItem)
      return `${seen.filter((r) => r.retention.perItem[id]).length}/${seen.length}`
    })
    console.log(`| ${id} | ${cells.join(" | ")} |`)
  }
}

function report(summary: Record<string, Aggregate>, args: Args) {
  const names = Object.keys(summary)
  console.log("\n## Retención de datos tras las compactaciones\n")
  console.log(`| variante | retención | ${args.probe ? "preguntas | " : ""}tokens del resumen | llamadas | fallos |`)
  console.log(`|---|---|${args.probe ? "---|" : ""}---|---|---|`)
  for (const n of names) {
    const a = summary[n]!
    console.log(`| ${n} | ${pct(a.retention)} | ${args.probe ? `${pct(a.probe)} | ` : ""}${a.summaryTokens.toFixed(0)} | ${a.calls} | ${a.failures} |`)
  }

  const kinds: ItemKind[] = ["fact", "preference", "decision", "dead_end", "plan"]
  console.log("\n## Por tipo de dato\n")
  console.log(`| variante | ${kinds.join(" | ")} |`)
  console.log(`|---|${kinds.map(() => "---").join("|")}|`)
  for (const n of names) console.log(`| ${n} | ${kinds.map((k) => pct(summary[n]!.byKind[k])).join(" | ")} |`)

  const segs = [...new Set(names.flatMap((n) => Object.keys(summary[n]!.bySegment).map(Number)))].sort((a, b) => a - b)
  console.log("\n## Por antigüedad (tramo 0 = el más antiguo, el que más compactaciones sufrió)\n")
  console.log(`| variante | ${segs.map((s) => `tramo ${s}`).join(" | ")} |`)
  console.log(`|---|${segs.map(() => "---").join("|")}|`)
  for (const n of names) console.log(`| ${n} | ${segs.map((s) => pct(summary[n]!.bySegment[s])).join(" | ")} |`)

  console.log(
    "\nQué mide: si el dato plantado aparece, literal, en el texto que verá la siguiente instancia" +
      `${args.probe ? ", y si alguien con SOLO ese texto responde bien la pregunta" : ""}. ` +
      "No mide si una tarea se resolvería: eso pide la evaluación de extremo a extremo.",
  )
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
