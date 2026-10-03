/**
 * Contrato de `exports`: todo subpath declarado tiene que importarse.
 *
 * Los deep-imports del SDK se han roto entre versiones sin aviso (ver el commit
 * "fix deep-imports" y el comentario de hive-cloud sobre el subpath `/tools`
 * roto). El consumidor se defendió pineando la versión exacta en tres
 * package.json distintos, que es el síntoma, no la solución: nada verificaba que
 * lo declarado en `exports` resolviera de verdad.
 *
 * Este test recorre `exports` del package.json y realmente importa cada entrada.
 * Un subpath que apunte a un archivo movido o borrado falla acá, no en el build
 * de quien consume el paquete.
 *
 * Uses HIVE_DB_PATH=":memory:" so no state persists between runs.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { describe, test, expect } from "bun:test";
import pkg from "../package.json";

const SUBPATHS = Object.keys(pkg.exports).filter((k) => k !== "./package.json");

/** `.` → el nombre del paquete; `./agent` → `@johpaz/hive-sdk/agent`. */
function specifierFor(subpath: string): string {
  return subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
}

describe("contrato de exports", () => {
  test("declara al menos los subpaths del cerebro", () => {
    // Las cinco piezas que el SDK expone como cerebro de Hive.
    for (const required of ["./agent", "./sessions", "./swarm", "./harness", "./models"]) {
      expect(SUBPATHS).toContain(required);
    }
  });

/**
 * Subpaths que sólo exportan tipos.
 *
 * Los tipos no existen en runtime, así que su módulo importa correctamente pero
 * con cero claves. Es legítimo —`Provider` y `ModelResponse` son parte del
 * contrato público— pero hay que declararlo, o la comprobación de "un barrel
 * vacío suele ser un barrel roto" no serviría para los demás.
 */
const SOLO_TIPOS = new Set(["./agent/providers"]);

  test.each(SUBPATHS)("%s se puede importar", async (subpath) => {
    const mod = await import(specifierFor(subpath));
    if (SOLO_TIPOS.has(subpath)) return;   // resolvió, que es lo que se comprueba
    // Un módulo que resuelve pero no exporta nada casi siempre es un barrel
    // apuntando a un archivo equivocado.
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  test("./agent expone el plano de decisión Jev", async () => {
    const agent = await import(specifierFor("./agent"));
    for (const name of [
      "askJev", "getJevKey", "getJevStatus", "emitJevDecision", "resetJevStatus", "JEV_MODEL",
      "planJevContext", "planJevIteration", "jevWantsParallel", "jevRoute", "flushTraces", "describeSwarmCapabilities", "renderSpecialistLine",
    ]) {
      expect(agent).toHaveProperty(name);
    }
  });

  test("cada subpath apunta a un archivo que existe", async () => {
    const missing: string[] = [];
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target !== "string") continue;
      if (!(await Bun.file(target).exists())) missing.push(`${subpath} → ${target}`);
    }
    expect(missing).toEqual([]);
  });
});
