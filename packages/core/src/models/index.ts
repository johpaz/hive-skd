/**
 * Models — el catálogo de proveedores y modelos con el que arranca una colmena.
 *
 * El "seed de modelos" ya existía, pero repartido en `storage/`: los datos en
 * `seed.ts`, las claves en `model-id.ts`, el precio en `usage.ts`. Quien quería
 * consumirlo tenía que saber que un catálogo de modelos vive bajo "storage".
 * Esto le da nombre y un punto de entrada; no mueve la implementación ni
 * duplica nada.
 *
 * `SEED_DATA` es la fuente de verdad del catálogo (18 proveedores, ~110 modelos)
 * y `seedAllData()` la aplica de forma idempotente en cada arranque — la llama
 * `ensureHiveDb()`, así que normalmente no hace falta invocarla a mano.
 *
 * Nota de precios: cada modelo LLM declara `inputPer1M`/`outputPer1M`. Un modelo
 * sin ellos no es "gratis", es un modelo cuyo costo no se puede calcular.
 */

// ─── Catálogo ────────────────────────────────────────────────────────────────
export { SEED_DATA, seedAllData, seedToolsAndSkills } from "../storage/seed";
export type { SeedData } from "../storage/seed";
export { activateElement, deactivateElement, getAllElements, getActiveElements } from "../storage/seed";

// ─── Identidad de modelo ─────────────────────────────────────────────────────
/**
 * Los revendedores (openrouter, nvidia, groq, opencode-go, modelscope) sirven
 * modelos de terceros bajo su propio endpoint, así que el id del wire colisiona
 * entre proveedores. `catalogModelKey` prefija; `wireModelId` deshace el prefijo
 * antes de salir a la API.
 */
export { catalogModelKey, wireModelId, isResellerProvider } from "../storage/model-id";

// ─── Costos ──────────────────────────────────────────────────────────────────
export { calculateCost, invalidateModelPricingCache } from "../storage/usage";

// ─── Shapes ──────────────────────────────────────────────────────────────────
export type { ModelDoc, ProviderDoc } from "../storage/collections";
