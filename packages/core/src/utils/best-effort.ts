import { logger } from "./logger";

const log = logger.child("best-effort");

/**
 * Ejecuta algo cuyo fallo no debe afectar a quien llama (marcar el estado de un
 * canal en la base, por ejemplo) sin tragárselo en silencio: el error queda en el
 * log a nivel `debug`, con la etiqueta de qué se intentaba.
 *
 * Antes cada canal repetía `try { await updateDoc(...) } catch { /* ignore DB errors *\/ }`
 * (diez veces): si la base fallaba de verdad, no quedaba ninguna pista.
 */
export async function bestEffort<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    log.debug(`[${label}] ignorado: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
