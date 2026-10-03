/**
 * Superficie pública de storage.
 *
 * HiveDB es la única fuente de verdad. La capa SQLite síncrona (`SQLiteStorage`,
 * `schema.ts`, `hiveSeed.ts`) desapareció en 0.1.5: convivían dos backends y el
 * seed de HiveDB salía fire-and-forget desde el de SQLite, así que cuál de los
 * dos ganaba dependía del timing.
 */

// ─── Conexión y bootstrap ────────────────────────────────────────────────────
export { getHiveDbPath, getHiveDb, closeHiveDb } from "./hivedb";
export { ensureHiveDb, isBootstrapped } from "./bootstrap";

// ─── Aislamiento multi-inquilino ─────────────────────────────────────────────
// Varios enjambres dentro de una sola HiveDB, prefijando el nombre de colección.
// Sin tenant en scope todo se comporta como siempre — ver storage/tenant.ts.
export {
  runInTenant,
  currentTenant,
  requireTenant,
  tenantKeyFromId,
  isTenantKey,
  qualify,
  unqualify,
  qualifyDocId,
  unqualifyDocId,
  scopedFilterValue,
} from "./tenant";

// ─── Acceso a colecciones ────────────────────────────────────────────────────
export {
  col,
  nextId,
  updateDoc,
  updateManyByIndex,
  findByAny,
  bumpRollup,
  toIndexable,
  fromIndexable,
  NO_PARENT,
  BROADCAST,
} from "./hive";

// ─── Catálogo compartido y activación por inquilino ──────────────────────────
// El contenido del catálogo (tools, skills, ética) se instala una sola vez; cada
// inquilino guarda sólo lo que activó — ver storage/catalog.ts.
export {
  CATALOG_COLLECTIONS,
  setCatalogActivation,
  clearCatalogActivation,
  listCatalogActivations,
  sharedCatalogCol,
  esCatalogoCompartido,
} from "./catalog";
export type { DocStore } from "./catalog";

// ─── Shapes de documento ─────────────────────────────────────────────────────
export type * from "./collections";

// ─── Claves del catálogo de modelos ──────────────────────────────────────────
// El prefijo de revendedor evita que dos providers que sirven el mismo modelo
// se pisen la fila entre sí — ver el JSDoc de model-id.ts.
export { catalogModelKey, wireModelId, isResellerProvider } from "./model-id";

// ─── Seed del catálogo ───────────────────────────────────────────────────────
export type { SeedData, SeedOptions, SpecialistSeedMode } from "./seed";
export {
  SEED_DATA,
  seedAllData,
  seedToolsAndSkills,
  activateElement,
  deactivateElement,
  getAllElements,
  getActiveElements,
} from "./seed";

// ─── Consumo y costos ────────────────────────────────────────────────────────
// El precio vive en la fila del modelo (`input_per_1m` / `output_per_1m`), no en
// un mapa hardcodeado: `MODEL_PRICING` era una segunda lista que se desfasaba
// del catálogo en silencio.
export type { UsageRecord, UsageSummary } from "./usage";
export {
  recordUsage,
  getUsageStats,
  calculateCost,
  invalidateModelPricingCache,
  recordToonSavings,
  hourBucket,
} from "./usage";

// ─── Secretos ────────────────────────────────────────────────────────────────
export {
  ensureSecretsBackend,
  storeSecret,
  loadSecret,
  deleteSecret,
  storeProviderApiKey,
  loadProviderApiKey,
  envSecret,
  storeProviderHeaders,
  loadProviderHeaders,
  deleteProviderSecrets,
  storeChannelConfig,
  loadChannelConfig,
  deleteChannelSecrets,
  storeMcpHeaders,
  loadMcpHeaders,
  storeMcpEnv,
  loadMcpEnv,
  deleteMcpSecrets,
  storeAgentHeaders,
  loadAgentHeaders,
  deleteAgentSecrets,
  maskApiKey,
  hashPassword,
  verifyPassword,
} from "./crypto";

// ─── Onboarding e identidad ──────────────────────────────────────────────────
export type { OnboardingSection } from "./onboarding";
export { activateBrowserTools } from "./onboarding";
export {
  resolveUserId,
  resolveAgentId,
  initOnboardingDb,
  saveUserProfile,
  saveProviderConfig,
  saveAgentConfig,
  activateProvider,
  activateModel,
  deactivateProvider,
  deactivateModel,
  getAllProviders,
  getAllModels,
} from "./onboarding";
export { normalizeUserEmail } from "./user-email";

// ─── Durabilidad entre arranques ─────────────────────────────────────────────
export { getBootId, resetBootId } from "./boot-id";
export type { ReconcileResult } from "./reconcile";
export { reconcileOnBoot } from "./reconcile";

// ─── Log causal (G9) ─────────────────────────────────────────────────────────
export type { CausalEvent, CausalEventPattern } from "./causal-events";
export { watchCausalEvents, formatCausalEvent, causalAgentKey, causalScope } from "./causal-events";
