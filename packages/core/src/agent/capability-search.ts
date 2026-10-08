/**
 * Capability Search — shared HiveDB search layer
 *
 * Single entry point for searching Hive's capability catalogs (native tools,
 * skills, playbook rules, MCP tools): one HiveDB index for all four, with the
 * catalog discriminated by the `type` field rather than by separate tables.
 *
 * Document convention (one index, type discrimination via filters):
 * - id:   `tool:${name}` | `skill:${id}` | `playbook:${rowid}` | `mcp:${id}` | `agent:${id}`
 * - name: tool/skill name or rule head        (BM25 boost 4.0)
 * - tags: category + triggers + keywords      (BM25 boost 3.0)
 * - body: description / rule text / content   (BM25 boost 2.0)
 * - filters: { type: "tool"|"skill"|"playbook"|"mcp" }
 *            plus { server_id } on MCP docs for per-server hot-reload.
 *
 * Score semantics: text-only queries return raw BM25 (positive, higher is
 * better). Never compare against an absolute floor — BM25 magnitude depends
 * on corpus and document length. Use applyRelativeCutoff() instead.
 */

import { createHash } from "node:crypto";
import type { IndexDoc } from "@johpaz/hive-db";
import { getHiveDb } from "../storage/hivedb";
import { currentTenant, qualifyDocId, unqualifyDocId, scopedFilterValue } from "../storage/tenant";
import { listCatalogActivations } from "../storage/catalog";
import { logger } from "../utils/logger";

const log = logger.child("capability-search");

/**
 * Ámbito de los documentos que no son de ningún inquilino: el catálogo.
 *
 * Es el mismo `"_"` que `scopedFilterValue()` usa cuando no hay tenant, y por
 * eso sirve de las dos maneras: como valor del filtro `tenant` para poder
 * BUSCAR el catálogo desde dentro de un inquilino, y como parte de
 * `tenant__type` para que un reindexado del catálogo BORRE sólo lo suyo.
 *
 * Antes el catálogo se indexaba sin filtro `tenant` alguno, y eso rompía las dos
 * cosas: desde un enjambre la búsqueda filtraba por su tenant y no encontraba
 * NADA del catálogo —ni una tool, ni una skill—, y un reindexado desde fuera
 * borraba por `type` a secas, llevándose por delante los documentos de todos los
 * inquilinos (las tools de sus endpoints, sus tools de MCP).
 */
const CATALOGO = "_";

export type CapabilityType = "tool" | "skill" | "playbook" | "mcp" | "agent";

export interface CapabilityHit {
  /** Namespaced id, e.g. "tool:web_search" */
  id: string;
  type: CapabilityType;
  /** Id without the type prefix, e.g. "web_search" */
  rawId: string;
  /** Raw BM25 score: positive, higher = more relevant */
  score: number;
}

export interface CapabilityDoc {
  type: CapabilityType;
  /** Id within the type namespace (tool name, skill id, playbook rowid, mcp id) */
  rawId: string;
  name?: string;
  body?: string;
  tags?: string;
  /** Extra filters besides `type` (e.g. { server_id } for MCP docs) */
  extraFilters?: Array<{ field: string; value: string }>;
}

const TYPE_PREFIXES: CapabilityType[] = ["tool", "skill", "playbook", "mcp", "agent"];

function splitId(id: string): { type: CapabilityType; rawId: string } | null {
  const sep = id.indexOf(":");
  if (sep === -1) return null;
  const type = id.slice(0, sep) as CapabilityType;
  if (!TYPE_PREFIXES.includes(type)) return null;
  return { type, rawId: id.slice(sep + 1) };
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchCapabilitiesOptions {
  /** Restrict to these types. Omit or empty = all types. */
  types?: CapabilityType[];
  /** Maximum hits to return (default 10). */
  k?: number;
  /** Per-field BM25 boosts (engine defaults: name 4, tags 3, body 2). */
  boosts?: { name?: number; body?: number; tags?: number };
}

/**
 * Search the capability index with raw user text. The engine parses leniently
 * (accents, quotes, operators and punctuation never throw) and applies
 * Spanish stemming + accent folding, so callers must NOT pre-sanitize.
 */
export async function searchCapabilities(
  query: string,
  opts: SearchCapabilitiesOptions = {}
): Promise<CapabilityHit[]> {
  const k = opts.k ?? 10;
  const types = opts.types?.length ? opts.types : undefined;
  const trimmed = query.trim();
  // hive-db >= 0.4 rejects k <= 0 instead of returning no hits.
  if (!trimmed || k <= 0) return [];

  const startTime = performance.now();
  const db = await getHiveDb();

  // Filters are AND-ed by the engine, so multi-type search runs one query per
  // type; the single-type and all-types cases are one engine call.
  //
  // El índice semántico es UNO solo para todos los inquilinos (no hay
  // "colección" que prefijar), así que el ámbito entra como un filtro más que el
  // motor AND-ea con el resto.
  //
  // Con inquilino activo se consulta DOS veces: lo suyo —las tools de sus
  // endpoints, sus tools de MCP— y el catálogo compartido, que se instala una
  // sola vez y es de todos (ver storage/catalog.ts). Sin inquilino se consulta
  // sin filtro de ámbito: una instalación local tiene una sola partición y así
  // un índice ya construido sigue respondiendo igual.
  const tenant = currentTenant();
  const ambitos = tenant ? [tenant, CATALOGO] : [null];
  const queries = ambitos.flatMap((ambito) => {
    const filtroAmbito = ambito ? [{ field: "tenant", value: ambito }] : [];
    return types
      ? types.map((t) => ({ filters: [...filtroAmbito, { field: "type", value: t }] }))
      : [{ filters: filtroAmbito.length ? filtroAmbito : undefined }];
  });

  const merged = new Map<string, CapabilityHit>();
  for (const q of queries) {
    const hits = await db.queryHybrid({
      text: trimmed,
      k,
      filters: q.filters,
      boosts: opts.boosts,
    });
    for (const hit of hits) {
      // El id indexado lleva el prefijo del tenant; quien consume esto espera
      // el id canónico ("tool:web_search"), no la forma física.
      const id = unqualifyDocId(hit.id);
      const parsed = splitId(id);
      if (!parsed) continue;
      const existing = merged.get(id);
      if (!existing || hit.score > existing.score) {
        merged.set(id, {
          id,
          type: parsed.type,
          rawId: parsed.rawId,
          score: hit.score,
        });
      }
    }
  }

  const apagados = tenant && merged.size > 0 ? await apagadosParaElInquilino() : null;

  const results = Array.from(merged.values())
    .filter((hit) => !apagados?.has(hit.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const timing = performance.now() - startTime;
  log.debug(
    `[capability-search] "${trimmed.substring(0, 60)}" → ${results.length} hits in ${timing.toFixed(1)}ms`
  );
  return results;
}

/**
 * Lo que este inquilino apagó del catálogo compartido.
 *
 * El índice del catálogo es uno solo, así que no puede llevar la elección de
 * nadie: se filtra al leer. Sólo se descarta lo que el inquilino decidió
 * explícitamente —apagar u ocultar—; lo que nunca tocó hereda lo que diga el
 * catálogo, igual que en la colección (ver storage/catalog.ts).
 *
 * Ofrecerle al modelo una capacidad que su workspace apagó es hacerle perder un
 * turno, además de contarle que existe algo que no puede usar.
 */
async function apagadosParaElInquilino(): Promise<Set<string>> {
  const apagados = new Set<string>();
  for (const [tipo, coleccion] of [["tool", "tools"], ["skill", "skills"]] as const) {
    for (const eleccion of await listCatalogActivations(coleccion)) {
      if (!eleccion.active || eleccion.hidden) apagados.add(`${tipo}:${eleccion.itemId}`);
    }
  }
  return apagados;
}

/**
 * Keep only hits scoring at least `ratio` of the top hit. This replaces the
 * old absolute negative-bm25 thresholds: relevance is relative to the best
 * match, never an absolute floor.
 */
export function applyRelativeCutoff(
  hits: CapabilityHit[],
  ratio = 0.3
): CapabilityHit[] {
  if (hits.length === 0) return hits;
  const top = hits[0]!.score;
  if (top <= 0) return [];
  return hits.filter((h) => h.score >= ratio * top);
}

// ─── Sync helpers ────────────────────────────────────────────────────────────

/**
 * Huellas del último sync por (ámbito, tipo): `{ [docId]: hash }`. Permite que
 * un reindexado idéntico no reescriba nada (con embeddings reindexar el catálogo
 * entero en cada arranque costaría segundos de CPU).
 */
const SYNC_COLLECTION = "capability_sync";

interface SyncRecord {
  hashes: Record<string, string>;
}

function syncKey(type: CapabilityType): string {
  return `${currentTenant() ?? CATALOGO}:${type}`;
}

function hashDoc(doc: IndexDoc): string {
  return createHash("sha1").update(JSON.stringify(doc)).digest("hex");
}

/**
 * Olvida las huellas de un tipo: el siguiente `replaceCapabilityDocs` hace un
 * reemplazo completo. Hay que llamarla cuando el índice cambia por fuera del sync.
 */
async function invalidateSync(type: CapabilityType): Promise<void> {
  const db = await getHiveDb();
  await db.collection<SyncRecord>(SYNC_COLLECTION).delete(syncKey(type));
}

/**
 * Replace all documents of a type. Si ya hay huellas del sync anterior solo se
 * reescriben los documentos nuevos o cambiados y se borran los que
 * desaparecieron; sin huellas (primer arranque) se borra el tipo y se reinserta.
 */
export async function replaceCapabilityDocs(
  type: CapabilityType,
  docs: CapabilityDoc[]
): Promise<void> {
  const db = await getHiveDb();
  const store = db.collection<SyncRecord>(SYNC_COLLECTION);
  const key = syncKey(type);
  const indexDocs = docs.map(toIndexDoc);
  const hashes: Record<string, string> = {};
  for (const d of indexDocs) hashes[d.id] = hashDoc(d);

  const previous = (await store.get(key))?.doc.hashes;
  if (!previous) {
    // `deleteByFilter` acepta UN SOLO filtro, así que en una base compartida
    // borrar por `type` se llevaría por delante los documentos de todos los
    // inquilinos. El campo sintético `tenant__type` (ver scopedFilterValue)
    // mantiene el borrado en un filtro y acotado a un ámbito.
    //
    // Sin inquilino el ámbito es el catálogo (`_`), no "todo": reindexar el
    // catálogo al arrancar borraba las tools de los endpoints y las de MCP de cada
    // inquilino, que nadie volvía a escribir hasta que ese enjambre se reconectara.
    await db.deleteByFilter({ field: "tenant__type", value: scopedFilterValue(type) });
    if (indexDocs.length > 0) await db.upsertBatch(indexDocs);
  } else {
    for (const id of Object.keys(previous)) {
      if (!(id in hashes)) await db.deleteDoc(id);
    }
    const changed = indexDocs.filter((d) => previous[d.id] !== hashes[d.id]);
    if (changed.length > 0) await db.upsertBatch(changed);
  }
  await store.put(key, { hashes });
}

/** Upsert documents without clearing the rest of their type. */
export async function upsertCapabilityDocs(docs: CapabilityDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const db = await getHiveDb();
  await db.upsertBatch(docs.map(toIndexDoc));
  // Estos documentos no están en las huellas: el próximo replace del tipo
  // debe ser completo para seguir limpiándolos.
  for (const type of new Set(docs.map((d) => d.type))) await invalidateSync(type);
}

/** Delete every MCP doc belonging to a server (hot-reload/disconnect). */
export async function deleteCapabilitiesByServer(serverId: string): Promise<void> {
  const db = await getHiveDb();
  await invalidateSync("mcp");
  await db.deleteByFilter(
    currentTenant()
      ? { field: "tenant__server_id", value: scopedFilterValue(serverId) }
      : { field: "server_id", value: serverId }
  );
}

function toIndexDoc(doc: CapabilityDoc): IndexDoc {
  const extra = doc.extraFilters ?? [];
  return {
    id: qualifyDocId(`${doc.type}:${doc.rawId}`),
    name: doc.name,
    body: doc.body,
    tags: doc.tags,
    filters: [
      { field: "type", value: doc.type },
      ...extra,
      // Todo documento declara su ámbito —el inquilino que lo escribió, o `_` si
      // es del catálogo—, y cada filtro lleva además su gemelo
      // `tenant__<campo>`. Con eso la búsqueda puede pedir un ámbito concreto y
      // los borrados masivos —que aceptan un solo filtro— quedan acotados a él.
      { field: "tenant", value: currentTenant() ?? CATALOGO },
      { field: "tenant__type", value: scopedFilterValue(doc.type) },
      ...extra.map((f) => ({
        field: `tenant__${f.field}`,
        value: scopedFilterValue(f.value),
      })),
    ],
  };
}
