/**
 * Modelos — la API, no la ruta.
 *
 * Dos operaciones tienen trampa y por eso están acá y no en una consulta suelta:
 *
 *  - **Borrar** un modelo que algún agente usa lo dejaría apuntando a la nada,
 *    y el fallo aparecería en el próximo turno de ese agente. Se bloquea con el
 *    nombre de quiénes lo usan.
 *  - **Renombrar** significa cambiar el id, así que hay que mover la fila *y*
 *    re-apuntar a cada agente que la referenciaba, en un solo `batch()`. A
 *    medias dejaría agentes huérfanos.
 *
 * El id de catálogo no es el id del wire: los revendedores (openrouter, nvidia,
 * groq…) sirven modelos de terceros y colisionan entre sí, así que `catalogModelKey`
 * prefija y `wireModelId` deshace el prefijo antes de salir a la API.
 */

import { col, toIndexable, fromIndexable } from "../storage/hive";
import { qualify } from "../storage/tenant";
import { getHiveDb } from "../storage/hivedb";
import type { BatchOp } from "@johpaz/hive-db";
import type { ModelDoc, AgentDoc } from "../storage/collections";
import { catalogModelKey, wireModelId } from "../storage/model-id";
import { logger } from "../utils/logger";

const log = logger.child("services/models");

export interface ModelSummary {
  id: string;
  providerId: string;
  name: string;
  modelType: ModelDoc["model_type"];
  contextWindow: number;
  enabled: boolean;
  active: boolean;
  /** El id tal como lo espera la API del proveedor, sin el prefijo del revendedor. */
  wireId: string;
  source: string;
}

const toSummary = (d: ModelDoc): ModelSummary => ({
  id: d.id,
  providerId: d.provider_id,
  name: d.name,
  modelType: d.model_type,
  contextWindow: d.context_window,
  enabled: d.enabled,
  active: d.active,
  wireId: wireModelId(d.provider_id, d.id),
  source: (d as { source?: string }).source ?? "catalog",
});

async function modelsCol() {
  return col<ModelDoc>("models");
}

export async function listModels(opts?: {
  providerId?: string;
  modelType?: ModelDoc["model_type"];
  includeInactive?: boolean;
}): Promise<ModelSummary[]> {
  const rows = await (await modelsCol()).scan({});
  return rows
    .map((e) => e.doc)
    .filter((d) => (opts?.providerId ? d.provider_id === opts.providerId : true))
    .filter((d) => (opts?.modelType ? d.model_type === opts.modelType : true))
    .filter((d) => (opts?.includeInactive ? true : d.active))
    .map(toSummary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getModel(id: string): Promise<ModelSummary | null> {
  const entry = await (await modelsCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

/**
 * Da de alta un modelo propio.
 *
 * Se marca `source: "discovered"` a propósito: el reseed del arranque borra y
 * recrea sólo las filas `"catalog"`, así que un modelo agregado a mano
 * sobrevive a los reinicios.
 */
export async function createModel(input: {
  name: string;
  providerId: string;
  modelType?: ModelDoc["model_type"];
  contextWindow?: number;
  active?: boolean;
}): Promise<ModelSummary> {
  if (!input.name?.trim()) throw new Error("El modelo necesita un nombre");
  if (!input.providerId?.trim()) throw new Error("El modelo necesita un proveedor");

  const c = await modelsCol();
  const id = catalogModelKey(input.providerId, input.name);
  if (await c.get(id)) throw new Error(`Ya existe el modelo "${id}"`);

  const doc = {
    id,
    provider_id: input.providerId,
    name: input.name,
    model_type: input.modelType ?? "llm",
    context_window: input.contextWindow ?? 0,
    capabilities: null,
    enabled: true,
    active: input.active ?? false,
    source: "discovered",
  } as ModelDoc;

  await c.put(id, doc, { expectedVersion: 0 });
  return toSummary(doc);
}

export async function toggleModel(id: string, active: boolean): Promise<ModelSummary> {
  const c = await modelsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el modelo "${id}"`);

  const doc: ModelDoc = { ...entry.doc, active };
  await c.put(id, doc, { expectedVersion: entry.version });
  return toSummary(doc);
}

/** Los agentes que apuntan a este modelo. Es lo que bloquea un borrado. */
export async function agentsUsingModel(id: string): Promise<string[]> {
  const rows = await (await col<AgentDoc>("agents")).findBy("model_id", toIndexable(id));
  return rows.map((e) => e.doc.name);
}

export async function deleteModel(id: string): Promise<boolean> {
  const c = await modelsCol();
  if (!(await c.get(id))) return false;

  const enUso = await agentsUsingModel(id);
  if (enUso.length > 0) {
    throw new Error(`El modelo "${id}" lo usan: ${enUso.join(", ")}. Cámbialos antes de borrarlo`);
  }

  await c.delete(id);
  return true;
}

/**
 * Renombra un modelo re-apuntando a los agentes que lo usaban.
 *
 * Va en un solo `batch()` porque son dos escrituras que deben ocurrir juntas:
 * si se moviera la fila sin actualizar los agentes, cada uno de ellos quedaría
 * apuntando a un id inexistente hasta que alguien lo notara.
 */
export async function renameModel(id: string, nuevoNombre: string): Promise<ModelSummary> {
  const c = await modelsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el modelo "${id}"`);

  const nuevoId = catalogModelKey(entry.doc.provider_id, nuevoNombre);
  if (nuevoId !== id && (await c.get(nuevoId))) {
    throw new Error(`Ya existe un modelo con id "${nuevoId}"`);
  }

  const doc: ModelDoc = { ...entry.doc, id: nuevoId, name: nuevoNombre };
  const agentesCol = await col<AgentDoc>("agents");
  const afectados = await agentesCol.findBy("model_id", toIndexable(id));

  const db = await getHiveDb();
  // `batch()` va contra el handle crudo de la base, así que no pasa por `col()`:
  // los nombres de colección hay que resolverlos contra el tenant a mano o el
  // rename escribiría en la partición de otro inquilino.
  const MODELS = qualify("models");
  const AGENTS = qualify("agents");
  const ops: BatchOp[] = [
    { op: "put", collection: MODELS, id: nuevoId, doc },
    ...(nuevoId !== id ? [{ op: "delete" as const, collection: MODELS, id }] : []),
    ...afectados.map((a) => ({
      op: "put" as const,
      collection: AGENTS,
      id: a.id,
      doc: { ...a.doc, model_id: toIndexable(nuevoId), updated_at: Date.now() },
      expectedVersion: a.version,
    })),
  ];
  await db.batch(ops);

  log.info(`modelo ${id} → ${nuevoId} (${afectados.length} agente(s) re-apuntados)`);
  return toSummary(doc);
}
