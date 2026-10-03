/**
 * Proveedores de modelos — la API, no la ruta.
 *
 * Dos cosas que una UI necesita y que en hive viven inline en
 * `gateway/routes/providers.ts`:
 *
 *  1. **La cascada.** Activar o desactivar un proveedor arrastra a todos sus
 *     modelos. Sin eso quedan modelos "activos" de un proveedor apagado, que el
 *     selector ofrece y fallan al llamarse.
 *  2. **La API key nunca se devuelve.** Se guarda cifrada
 *     (`storage/crypto.ts`) y hacia afuera sólo salen `hasApiKey` y una versión
 *     enmascarada. Una UI necesita mostrar "hay clave configurada" sin poder
 *     leerla.
 */

import { col, updateManyByIndex } from "../storage/hive";
import type { ProviderDoc, ModelDoc } from "../storage/collections";
import {
  storeProviderApiKey, loadProviderApiKey, maskApiKey, deleteProviderSecrets, storeProviderHeaders,
} from "../storage/crypto";
import { logger } from "../utils/logger";

const log = logger.child("services/providers");

export interface ProviderSummary {
  id: string;
  name: string;
  baseUrl: string | null;
  category: ProviderDoc["category"];
  enabled: boolean;
  active: boolean;
  /** Nunca la clave: sólo si existe y su versión enmascarada. */
  hasApiKey: boolean;
  maskedApiKey: string | null;
  numCtx: number | null;
}

async function providersCol() {
  return col<ProviderDoc>("providers");
}

async function toSummary(doc: ProviderDoc): Promise<ProviderSummary> {
  const key = await loadProviderApiKey(doc.id).catch(() => "");
  return {
    id: doc.id,
    name: doc.name,
    baseUrl: doc.base_url,
    category: doc.category,
    enabled: doc.enabled,
    active: doc.active,
    hasApiKey: !!key,
    maskedApiKey: key ? maskApiKey(key) : null,
    numCtx: doc.num_ctx,
  };
}

export async function listProviders(opts?: { category?: ProviderDoc["category"]; includeInactive?: boolean }): Promise<ProviderSummary[]> {
  const rows = await (await providersCol()).scan({});
  const docs = rows
    .map((e) => e.doc)
    .filter((d) => (opts?.category ? d.category === opts.category : true))
    .filter((d) => (opts?.includeInactive ? true : d.active));
  return Promise.all(docs.map(toSummary));
}

export async function getProvider(id: string): Promise<ProviderSummary | null> {
  const entry = await (await providersCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

export async function createProvider(input: {
  id: string;
  name: string;
  baseUrl?: string | null;
  category?: ProviderDoc["category"];
  apiKey?: string;
  numCtx?: number | null;
}): Promise<ProviderSummary> {
  if (!input.id?.trim()) throw new Error("El proveedor necesita un id");

  const c = await providersCol();
  if (await c.get(input.id)) throw new Error(`Ya existe el proveedor "${input.id}"`);

  const doc: ProviderDoc = {
    id: input.id,
    name: input.name,
    base_url: input.baseUrl ?? null,
    category: input.category ?? "llm",
    num_ctx: input.numCtx ?? null,
    num_gpu: 0,
    enabled: true,
    active: false,
    created_at: Date.now(),
  };
  await c.put(input.id, doc, { expectedVersion: 0 });
  if (input.apiKey) await storeProviderApiKey(input.id, input.apiKey);
  return toSummary(doc);
}

export async function updateProvider(
  id: string,
  changes: { name?: string; baseUrl?: string | null; apiKey?: string; headers?: Record<string, unknown>; numCtx?: number | null },
): Promise<ProviderSummary> {
  const c = await providersCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el proveedor "${id}"`);

  const doc: ProviderDoc = { ...entry.doc };
  if (changes.name !== undefined) doc.name = changes.name;
  if (changes.baseUrl !== undefined) doc.base_url = changes.baseUrl;
  if (changes.numCtx !== undefined) doc.num_ctx = changes.numCtx;
  await c.put(id, doc, { expectedVersion: entry.version });

  if (changes.apiKey !== undefined) await storeProviderApiKey(id, changes.apiKey);
  if (changes.headers !== undefined) await storeProviderHeaders(id, changes.headers);
  return toSummary(doc);
}

/**
 * Activa o desactiva el proveedor **y todos sus modelos**.
 *
 * La cascada no es una comodidad: un modelo activo de un proveedor apagado
 * aparece en el selector y falla al llamarse, porque no hay credencial ni
 * endpoint que lo atienda.
 */
export async function toggleProvider(id: string, active: boolean): Promise<ProviderSummary> {
  const c = await providersCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el proveedor "${id}"`);

  const doc: ProviderDoc = { ...entry.doc, active, enabled: active ? true : entry.doc.enabled };
  await c.put(id, doc, { expectedVersion: entry.version });

  const n = await updateManyByIndex<ModelDoc>("models", "provider_id", id, { active });
  log.info(`proveedor ${id} ${active ? "activado" : "desactivado"} — ${n} modelo(s) en cascada`);
  return toSummary(doc);
}

/** Borra el proveedor y sus secretos. Falla si algún modelo suyo sigue en uso. */
export async function deleteProvider(id: string): Promise<boolean> {
  const c = await providersCol();
  if (!(await c.get(id))) return false;

  const modelos = await (await col<ModelDoc>("models")).findBy("provider_id", id);
  if (modelos.length > 0) {
    throw new Error(`El proveedor "${id}" todavía tiene ${modelos.length} modelo(s); bórralos primero`);
  }

  await c.delete(id);
  await deleteProviderSecrets(id).catch(() => {});
  return true;
}
