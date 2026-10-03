/**
 * Tools — la API, no la tool (valga la redundancia).
 *
 * Una tool es código con un `execute`, así que a diferencia de las skills **no
 * se puede dar de alta una desde una UI**: no hay dónde poner el código. hive
 * lo refleja exactamente así — su ruta expone listar, activar/desactivar y
 * editar metadatos, pero no tiene `POST /api/tools`.
 *
 * Las tres vías reales para sumar capacidades son otras, y ninguna pasa por acá:
 *  - `registerAppTool()` — código propio, para quien construye sobre el SDK.
 *  - Un servidor MCP — proceso externo que expone sus tools (`services/mcp.ts`).
 *  - Un endpoint HTTP declarativo (`services/endpoints.ts`), donde el ejecutor
 *    es genérico y lo que el usuario aporta son datos, no código.
 *
 * Lo que este servicio sí resuelve es lo que una UI necesita a diario: ver el
 * catálogo, encender y apagar, y corregir un nombre o una descripción.
 */

import { col } from "../storage/hive";
import type { ToolDoc } from "../storage/collections";
import { syncToolCatalogToIndex } from "../agent/tool-selector";
import { logger } from "../utils/logger";

const log = logger.child("services/tools");

export interface ToolSummary {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  /** `enabled` = disponible en la instalación; `active` = ofrecida ahora. */
  enabled: boolean;
  active: boolean;
}

function toSummary(doc: ToolDoc): ToolSummary {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    category: doc.category,
    enabled: doc.enabled,
    active: doc.active,
  };
}

async function toolsCol() {
  return col<ToolDoc>("tools");
}

export async function listTools(opts?: { category?: string; includeInactive?: boolean }): Promise<ToolSummary[]> {
  const rows = await (await toolsCol()).scan({});
  return rows
    .map((e) => e.doc)
    .filter((d) => (opts?.category ? d.category === opts.category : true))
    .filter((d) => (opts?.includeInactive ? true : d.active))
    .map(toSummary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTool(id: string): Promise<ToolSummary | null> {
  const entry = await (await toolsCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

/**
 * Enciende o apaga una tool.
 *
 * Reindexa después: el índice BM25 es lo que consulta `search_knowledge`, y una
 * tool apagada que siga indexada es una que el modelo encuentra y no puede usar.
 */
export async function toggleTool(id: string, active: boolean): Promise<ToolSummary> {
  const c = await toolsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe la tool "${id}"`);

  const doc: ToolDoc = { ...entry.doc, active, updated_at: Date.now() };
  await c.put(id, doc, { expectedVersion: entry.version });
  await syncToolCatalogToIndex().catch((e) => log.warn(`no pude reindexar: ${(e as Error).message}`));
  return toSummary(doc);
}

/**
 * Corrige nombre, descripción o categoría.
 *
 * No toca `execute`: la implementación vive en el código, no en la fila. La
 * descripción sí importa — es lo que el modelo lee para decidir si la tool le
 * sirve, así que cambiarla cambia el comportamiento y por eso se reindexa.
 */
export async function updateToolMetadata(
  id: string,
  changes: { name?: string; description?: string | null; category?: string | null },
): Promise<ToolSummary> {
  const c = await toolsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe la tool "${id}"`);

  const doc: ToolDoc = { ...entry.doc, updated_at: Date.now() };
  if (changes.name !== undefined) doc.name = changes.name;
  if (changes.description !== undefined) doc.description = changes.description;
  if (changes.category !== undefined) doc.category = changes.category;

  await c.put(id, doc, { expectedVersion: entry.version });
  await syncToolCatalogToIndex().catch((e) => log.warn(`no pude reindexar: ${(e as Error).message}`));
  return toSummary(doc);
}
