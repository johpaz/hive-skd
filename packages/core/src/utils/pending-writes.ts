/**
 * Escrituras en segundo plano (trazas, uso de tokens) que no deben bloquear al
 * loop del agente. Se registran aquí para poder esperarlas antes de cerrar la
 * base: una escritura en vuelo cuando se cierra falla con `database is closed`
 * y el dato se pierde.
 */

const pending = new Set<Promise<void>>();

/** Registra una escritura en vuelo; se quita sola al terminar (con o sin error). */
export function trackWrite(write: Promise<void>): void {
  pending.add(write);
  void write.finally(() => pending.delete(write));
}

/** Espera a que termine todo lo registrado, incluido lo que se registre mientras espera. */
export async function flushPendingWrites(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/** Una escritura que llega con la base ya cerrada no es un fallo de quien escribe. */
export function isClosedDatabase(err: unknown): boolean {
  return /database is closed/i.test(err instanceof Error ? err.message : String(err));
}
