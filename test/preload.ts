/**
 * Preload de la suite de tests.
 *
 * Cada archivo de test pone `process.env.HIVE_DB_PATH = ":memory:"` en su primera
 * línea, pero los `import` de ESM se evalúan ANTES que cualquier sentencia del
 * módulo: si algo de la cadena de imports resuelve la ruta de la BD al cargarse,
 * la asignación llega tarde y la suite termina abriendo la base real del usuario
 * (~/.hive/data/hivedb), escribiéndole contadores y filtrando estado entre
 * archivos. Un preload corre antes que todo, así que acá sí gana.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_DB_PATH ||= ":memory:";

// Lo mismo con la carpeta de hive: el logger (logs/) y los artifacts
// (artifacts/) resuelven getHiveDir(), y sin esto cada corrida le dejaba al
// usuario en ~/.hive un log de ~1 MB e imágenes de prueba.
if (!process.env.HIVE_HOME) {
  const testHome = mkdtempSync(join(tmpdir(), "hive-sdk-test-home-"));
  process.env.HIVE_HOME = testHome;
  process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
}

// Las herramientas dejan lo que crean para el usuario en una carpeta visible (~/Hive por
// defecto): los tests la redirigen a la carpeta temporal para no escribir en el equipo real.
process.env.HIVE_OUTPUT_DIR ||= join(process.env.HIVE_HOME!, "salidas");
