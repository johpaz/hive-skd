#!/usr/bin/env bun
/**
 * Guardián de drift entre `hive` y este SDK.
 *
 * El SDK es la fuente de verdad del cerebro de Hive, pero nada lo garantiza
 * estructuralmente: los dos repos son independientes y el cerebro se ha venido
 * portando a mano. El CHANGELOG 0.1.5 documenta hasta dónde llegó la última vez
 * — "el SDK y hive habían divergido hasta compartir sólo 87 de 224 nombres de
 * archivo". Este script existe para que eso se vea antes de que vuelva a doler.
 *
 * No es un sincronizador: no toca ningún archivo. Compara los módulos del
 * cerebro y reporta qué falta y qué difiere, para decidir a mano qué portar.
 *
 *   bun run drift                    # usa ../hive
 *   bun run drift -- --hive=/ruta    # o la ruta que se le pase
 *   bun run drift -- --strict        # sale con código 1 si hay drift
 *
 * Las diferencias esperadas se declaran en EXPECTED: son decisiones tomadas
 * (el SDK es autocontenido, hive depende de paquetes internos), no drift.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Los módulos que forman el cerebro. Lo demás (canales, UI) no se compara. */
const BRAIN = [
  "agent",
  "sessions",
  "storage",
  "harness",
  "tools",
  "tool-runtime",
  "skills",
  "mcp",
  "memory",
  "workers",
  "scheduler",
  "events",
];

/**
 * Diferencias deliberadas, con su motivo. Si una entrada deja de hacer falta,
 * borrarla: el objetivo es que esta lista sea corta y cada línea esté justificada.
 */
const EXPECTED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^sessions\//, reason: "módulo propio del SDK; hive lo tiene disperso en agent/" },
  { pattern: /^(harness|skills|memory|workers)\//, reason: "sólo existe en el SDK" },
  { pattern: /\.test\.ts$/, reason: "los tests no se portan" },
  { pattern: /\.generated\.ts$/, reason: "archivo generado; se regenera, no se copia" },
  { pattern: /^agent\/realtime-providers\//, reason: "portado; hive lo consume desde su gateway" },
  { pattern: /^gateway\//, reason: "hive tiene el servidor de la app; el SDK sólo la librería" },
];

function expectedFor(rel: string): string | null {
  return EXPECTED.find((e) => e.pattern.test(rel))?.reason ?? null;
}

function walk(root: string, dir: string, out: string[] = []): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) walk(root, join(dir, entry), out);
    else if (entry.endsWith(".ts")) out.push(relative(root, full));
  }
  return out;
}

/**
 * Diferencias de import que son decisiones, no drift.
 *
 * El SDK es autocontenido: resuelve MCP y skills dentro de su propio core,
 * mientras hive los toma de paquetes internos de su monorepo. Y el SDK escribe
 * los import con extensión `.ts` explícita. Comparar el texto crudo marcaría
 * cada archivo del cerebro como divergente por esas dos cosas, y un guardián
 * con 40 falsos positivos no lo corre nadie.
 */
function canonicalizeImports(line: string): string {
  return line
    .replace(/@johpaz\/hive-agents-mcp/g, "«mcp»")
    .replace(/@johpaz\/hive-agents-skills/g, "«skills»")
    // El mismo módulo, visto desde el SDK como ruta relativa a su propio core.
    .replace(/(?:\.\.\/)+mcp(?:\/index)?(?:\.ts)?/g, "«mcp»")
    .replace(/(?:\.\.\/)+skills(?:\/index)?(?:\.ts)?/g, "«skills»")
    // Cubre tanto `from "..."` como `await import("...")`: la extensión y el
    // `/index` son estilo, no divergencia.
    .replace(/(\.\.?\/[\w./-]*?)(?:\/index)?\.ts(["'])/g, "$1$2")
    .replace(/(import\s*\(\s*["'])(\.\.?\/[\w./-]*?)\/index(["'])/g, "$1$2$3")
    .replace(/(from\s+["'])(\.\.?\/[\w./-]*?)\/index(["'])/g, "$1$2$3");
}

/** Compara ignorando el ruido que no es drift real: espacios, líneas vacías, imports. */
function normalize(text: string): string {
  return text
    .split("\n")
    .map((l) => canonicalizeImports(l.trimEnd()))
    .filter((l) => l.trim() !== "")
    .join("\n");
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const hiveArg = args.find((a) => a.startsWith("--hive="))?.slice("--hive=".length);
const hiveRoot = join(hiveArg ?? join(import.meta.dir, "..", "..", "hive"), "packages/core/src");
const sdkRoot = join(import.meta.dir, "..", "packages/core/src");

if (!existsSync(hiveRoot)) {
  console.error(`No encuentro el core de hive en ${hiveRoot}`);
  console.error(`Pasá la ruta con: bun run drift -- --hive=/ruta/a/hive`);
  process.exit(2);
}

const missing: string[] = [];
const differing: Array<{ rel: string; hive: number; sdk: number }> = [];
const ignored: Array<[string, string]> = [];

for (const mod of BRAIN) {
  for (const rel of walk(hiveRoot, mod)) {
    const reason = expectedFor(rel);
    const sdkFile = join(sdkRoot, rel);

    if (!existsSync(sdkFile)) {
      if (reason) ignored.push([rel, reason]);
      else missing.push(rel);
      continue;
    }
    if (reason) continue; // existe en ambos: la excepción sólo cubre la ausencia

    const a = normalize(readFileSync(join(hiveRoot, rel), "utf-8"));
    const b = normalize(readFileSync(sdkFile, "utf-8"));
    if (a !== b) {
      differing.push({ rel, hive: a.split("\n").length, sdk: b.split("\n").length });
    }
  }
}

const total = missing.length + differing.length;

if (missing.length > 0) {
  console.log(`\n❌ ${missing.length} archivo(s) del cerebro están en hive y no en el SDK:`);
  for (const f of missing) console.log(`   ${f}`);
}
if (differing.length > 0) {
  // El SDK es la fuente de verdad, así que "difiere" no significa "hay que
  // portar": puede ser una mejora que sólo está acá. El tamaño relativo da la
  // pista; el diff decide. Se ordena poniendo primero donde hive va adelante,
  // que es el caso que sí pide acción.
  const ahead = (f: { hive: number; sdk: number }) => f.hive - f.sdk;
  differing.sort((a, b) => ahead(b) - ahead(a));

  console.log(`\n⚠️  ${differing.length} archivo(s) difieren (líneas hive → SDK):`);
  for (const f of differing) {
    const delta = f.hive - f.sdk;
    const hint = delta > 0 ? "hive va adelante" : delta < 0 ? "el SDK va adelante" : "mismo tamaño";
    console.log(`   ${f.rel.padEnd(46)} ${String(f.hive).padStart(5)} → ${String(f.sdk).padEnd(5)} ${hint}`);
  }
  console.log(`\n   Para ver uno:  diff ${sdkRoot}/<archivo> ${hiveRoot}/<archivo>`);
}
if (total === 0) {
  console.log("\n✅ Sin drift en los módulos del cerebro.");
}
console.log(`\n(${ignored.length} diferencia(s) declaradas como esperadas — ver EXPECTED en este script)`);

process.exit(strict && total > 0 ? 1 : 0);
