/**
 * HiveDB bootstrap — replaces initializeDatabase() + seedAllData() +
 * runStartupMigrations().
 *
 * A brand-new install never has legacy SQLite data to migrate, so there is
 * no version-gated migration list: ensureHiveDb() just makes sure every
 * collection's secondary indexes exist (idempotent, safe every boot) and
 * that the static catalogs are (re)seeded from their canonical source
 * (SEED_DATA / SkillLoader) — same "reseed every boot so code changes
 * always take effect" behavior `seedAllData()` had, just via `put()`
 * instead of `DELETE`+`INSERT`.
 */

import { getHiveDb, getOpenHiveDb } from "./hivedb";
import { col } from "./hive";
import { currentTenant } from "./tenant";
import { seedAllData, type SeedOptions } from "./seed";
import { ensureSecretsBackend } from "./crypto";
import { ensureLegacyThread } from "../agent/thread-store";

interface IndexSpec {
  collection: string;
  field: string;
  unique?: boolean;
}

/**
 * Every equality index used by `findBy()` across the codebase. Grouped by
 * the migration stage that introduces the collection; kept in one place so
 * a missing index is a loud error (`findBy` throws) rather than a silent
 * empty result.
 */
const INDEXES: IndexSpec[] = [
  // Stage 1 — identity/config core
  { collection: "models", field: "provider_id" },
  { collection: "models", field: "model_type" },
  { collection: "agents", field: "user_id" },
  { collection: "agents", field: "model_id" },
  { collection: "agents", field: "parent_id" },
  { collection: "agents", field: "role" },
  { collection: "agents", field: "status" },
  { collection: "agents", field: "source" },
  // Stage 2 — catalog
  { collection: "channels", field: "user_id" },
  { collection: "channels", field: "type" },
  { collection: "skills", field: "category" },
  { collection: "skills", field: "active" },
  { collection: "tools", field: "category" },
  { collection: "tools", field: "active" },
  { collection: "ethics", field: "active" },
  { collection: "mcpTools", field: "server_id" },
  { collection: "mcpTools", field: "active" },
  // Stage 3 — auth/identity
  { collection: "userChannels", field: "channel" },
  { collection: "refreshTokens", field: "token_hash", unique: true },
  { collection: "refreshTokens", field: "user_id" },
  { collection: "notifications", field: "user_id" },
  { collection: "notifications", field: "channel" },
  // Stage 4 — chat/ACE
  { collection: "traces", field: "thread_id" },
  { collection: "traces", field: "agent_id" },
  { collection: "traces", field: "success" },
  { collection: "playbook", field: "active" },
  { collection: "playbook", field: "category" },
  // Stage 5 — scheduler
  { collection: "cronJobs", field: "status" },
  { collection: "cronJobs", field: "task_type" },
  { collection: "cronJobs", field: "agent_id" },
  { collection: "agentRuns", field: "status" },
  { collection: "agentRuns", field: "thread_id" },
  { collection: "agentRuns", field: "agent_id" },
  { collection: "agentRuns", field: "kind" },
  { collection: "agentRuns", field: "catalog_agent_id" },
  { collection: "jobQueue", field: "status" },
  { collection: "jobQueue", field: "lane" },
  { collection: "jobQueue", field: "type" },
  { collection: "jobQueue", field: "run_id" },
  { collection: "jobQueue", field: "idempotency_key" },
  { collection: "proofPackets", field: "run_id" },
  { collection: "proofPackets", field: "agent_id" },
  { collection: "proofPackets", field: "catalog_agent_id" },
  { collection: "artifacts", field: "run_id" },
  { collection: "artifacts", field: "task_id" },
  { collection: "artifacts", field: "user_id" },
  { collection: "artifacts", field: "status" },
  { collection: "agentProposals", field: "agent_id" },
  { collection: "agentProposals", field: "status" },
  { collection: "agentProposals", field: "type" },
  // Stage 6 — orchestration
  { collection: "tasks", field: "agent_id" },
  { collection: "tasks", field: "status" },
  { collection: "tasks", field: "catalog_agent_id" },
  { collection: "tasks", field: "delegation_group_id" },
  { collection: "delegationGroups", field: "turn_id", unique: true },
  { collection: "delegationGroups", field: "thread_id" },
  { collection: "delegationGroups", field: "status" },
  { collection: "agentBusMessages", field: "to_worker_id" },
  { collection: "agentBusMessages", field: "from_worker_id" },
  { collection: "agentBusMessages", field: "event_type" },
  { collection: "narrationEvents", field: "turn_id" },
  { collection: "narrationEvents", field: "thread_id" },
  { collection: "narrationEvents", field: "user_id" },
  { collection: "narrationEvents", field: "kind" },
  // Stage 7 — meeting
  { collection: "meetingSessions", field: "user_id" },
  { collection: "meetingSessions", field: "status" },
  { collection: "conversationThreads", field: "user_id" },
  { collection: "conversationThreads", field: "channel" },
  { collection: "conversationThreads", field: "archived" },
  { collection: "swarms", field: "enabled" },
  { collection: "apiEndpoints", field: "enabled" },
  { collection: "memory", field: "user_id" },
  { collection: "playbook", field: "user_id" },
];

async function ensureIndexes(): Promise<void> {
  for (const spec of INDEXES) {
    const c = await col(spec.collection);
    await c.createIndex(spec.field, { unique: spec.unique });
  }
}

/**
 * Seeds the static catalogs (tools, skills, providers, models, mcp servers,
 * channels, ethics, ACE playbook) from their canonical source every boot —
 * same "reseed every boot so code changes always take effect" behavior the
 * old SQLite seedAllData() had. Fully idempotent: uses putIfAbsent for
 * user-toggleable fields (enabled/active) and doesn't touch `users`, so it's
 * safe to call unconditionally before any onboarding has happened.
 */
async function ensureSeedData(opts?: SeedOptions): Promise<void> {
  await seedAllData(opts);
}

// Bootstrap state belongs to a specific database instance. A boolean that
// survives closeHiveDb() can report a closed/replaced database as ready when
// tests or long-running processes open a fresh instance in the same runtime.
let bootstrappedDb: Awaited<ReturnType<typeof getHiveDb>> | null = null;

// ...y, dentro de esa instancia, a un tenant concreto. Una sola base compartida
// por muchos enjambres significa que "ya arrancó" no es una propiedad de la
// base: el enjambre A puede tener sus 72 índices creados y el B ninguno.
const bootstrappedTenants = new Set<string>();

/** Clave de bootstrap del tenant activo ("_" en modo local/escritorio). */
function bootstrapScope(): string {
  return currentTenant() ?? "_";
}

/**
 * Antes de la separación por canal todos los canales compartían un solo hilo cuyo
 * `thread_id` era el `userId`. Esa conversación se registra —sin mover un solo
 * mensaje— como una conversación más de la web, para que siga siendo legible desde
 * la lista. Idempotente: no hace nada si ya está registrada o si no hay historial.
 */
/**
 * Reasigna las memorias anteriores al aislamiento por usuario.
 *
 * Antes la colección era global: `id` era el título y no había `user_id`. Al
 * introducir el aislamiento esas filas quedarían invisibles —nadie las
 * encontraría, porque toda lectura filtra por dueño— así que se les asigna el
 * usuario existente y se re-clavean a `${userId}:${title}`.
 *
 * Idempotente: una fila que ya tiene `user_id` no se toca. Si todavía no hay
 * usuario (onboarding sin terminar) se deja para el próximo arranque, cuando lo
 * haya, en vez de asignarlas a `""` y tener que deshacerlo.
 */
async function migrateLegacyMemories(): Promise<void> {
  try {
    const memories = await col<{ id: string; user_id?: string; title: string }>("memory");
    const legacy = (await memories.scan({})).filter((e) => !e.doc.user_id);
    if (legacy.length === 0) return;

    const users = await col<{ id: string }>("users");
    const primero = (await users.scan({ limit: 1 }))[0];
    if (!primero) return;

    for (const entry of legacy) {
      const nuevoId = `${primero.id}:${entry.doc.title}`;
      await memories.put(nuevoId, { ...entry.doc, id: nuevoId, user_id: primero.id });
      if (nuevoId !== entry.id) await memories.delete(entry.id).catch(() => {});
    }
  } catch {
    // La memoria no es crítica para arrancar: si falla, se reintenta al próximo boot.
  }
}

/**
 * Reglas del playbook anteriores a `user_id`.
 *
 * Se aprendieron cuando la instalación era de un solo usuario, así que son de
 * él. Dejarlas sin dueño las volvería globales y se las inyectaría a cualquier
 * usuario que se dé de alta después, que es exactamente el aislamiento que este
 * campo viene a cerrar. Las sembradas no pasan por acá: `seedAllData()` les
 * pone `user_id: ""` en cada arranque.
 */
async function migrateLegacyPlaybook(): Promise<void> {
  try {
    const playbook = await col<{ id: string; user_id?: string }>("playbook");
    const legacy = (await playbook.scan({})).filter((e) => e.doc.user_id === undefined);
    if (legacy.length === 0) return;

    const users = await col<{ id: string }>("users");
    const primero = (await users.scan({ limit: 1 }))[0];
    if (!primero) return;

    for (const entry of legacy) {
      await playbook.put(
        entry.id,
        { ...entry.doc, user_id: primero.id },
        { expectedVersion: entry.version },
      );
    }
  } catch {
    // El playbook no es crítico para arrancar: se reintenta al próximo boot.
  }
}

async function ensureLegacyThreads(): Promise<void> {
  try {
    const users = await col<{ id: string }>("users");
    for (const user of await users.scan({})) {
      await ensureLegacyThread(user.id);
    }
  } catch {
    // Base sin usuarios todavía (onboarding pendiente) — nada que registrar.
  }
}

/**
 * Idempotent entry point: opens the database, ensures indexes, reseeds the
 * static catalogs, and records the schema version. Safe to call on every
 * gateway boot.
 */
export async function ensureHiveDb(opts?: SeedOptions): Promise<void> {
  const db = await getHiveDb();
  if (db !== bootstrappedDb) bootstrappedTenants.clear();
  const scope = bootstrapScope();

  // Con varios inquilinos en la misma base, esto se llama una vez por enjambre
  // y por proceso, no una vez por proceso: repetir los ~72 `createIndex` más el
  // seed en cada llamada es exactamente el coste que la consolidación viene a
  // quitar. En modo local (sin tenant) no se cortocircuita nada, para conservar
  // el "reseed en cada arranque" del que dependen los cambios de catálogo.
  if (currentTenant() && bootstrappedDb === db && bootstrappedTenants.has(scope)) return;

  await ensureIndexes();
  // Mint the master key before anything can save an API key, so a fresh
  // install is durable from the first keystroke rather than after a restart
  // has already dropped the secret.
  ensureSecretsBackend();
  await ensureSeedData(opts);

  await ensureLegacyThreads();
  await migrateLegacyMemories();
  await migrateLegacyPlaybook();

  const meta = await col<{ value: number }>("meta");
  const existing = await meta.get("schemaVersion");
  if (!existing) await meta.put("schemaVersion", { value: 1 }, { expectedVersion: 0 });

  bootstrappedDb = db;
  bootstrappedTenants.add(scope);
}

export function isBootstrapped(): boolean {
  return (
    bootstrappedDb !== null &&
    bootstrappedDb === getOpenHiveDb() &&
    bootstrappedTenants.has(bootstrapScope())
  );
}
