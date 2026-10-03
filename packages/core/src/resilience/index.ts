/**
 * Resilience — reintentos y circuit breakers.
 *
 * `withRetry` aplica backoff exponencial con jitter y respeta `Retry-After`
 * cuando el proveedor lo manda; `isRetryableError` decide qué merece otro
 * intento (429/5xx/timeout/red) y qué no (un 400 no mejora reintentando).
 *
 * El `CircuitBreaker` corta las llamadas a un servicio que ya viene fallando,
 * en vez de seguir gastando intentos contra algo caído.
 */

export * from "./retry";
export * from "./circuit-breaker";
