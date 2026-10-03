/**
 * Código de ética — la API, no la ruta.
 *
 * Es el texto que se le inyecta al agente como marco obligatorio y que no puede
 * ignorar. En hive el CRUD vive inline en `gateway/routes/ethics.ts`.
 *
 * `is_default` marca la plantilla que trae el sistema: se puede desactivar, pero
 * borrarla dejaría la instalación sin ninguna referencia si el usuario no
 * escribió la suya, así que se protege.
 */

import { col } from "../storage/hive";
import type { EthicsDoc } from "../storage/collections";

export interface EthicsSummary {
  id: string;
  name: string;
  description: string | null;
  content: string;
  isDefault: boolean;
  enabled: boolean;
  active: boolean;
}

const toSummary = (d: EthicsDoc): EthicsSummary => ({
  id: d.id,
  name: d.name,
  description: d.description,
  content: d.content,
  isDefault: d.is_default,
  enabled: d.enabled,
  active: d.active,
});

async function ethicsCol() {
  return col<EthicsDoc>("ethics");
}

export async function listEthics(opts?: { includeInactive?: boolean }): Promise<EthicsSummary[]> {
  const rows = await (await ethicsCol()).scan({});
  return rows
    .map((e) => e.doc)
    .filter((d) => (opts?.includeInactive ? true : d.active))
    .map(toSummary);
}

export async function getEthics(id: string): Promise<EthicsSummary | null> {
  const entry = await (await ethicsCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

export async function createEthics(input: {
  id?: string;
  name: string;
  content: string;
  description?: string | null;
  active?: boolean;
}): Promise<EthicsSummary> {
  if (!input.name?.trim()) throw new Error("El código de ética necesita un nombre");
  if (!input.content?.trim()) throw new Error("El código de ética necesita contenido");

  const c = await ethicsCol();
  const id = input.id ?? crypto.randomUUID();
  if (await c.get(id)) throw new Error(`Ya existe un código de ética con id "${id}"`);

  const doc: EthicsDoc = {
    id,
    name: input.name,
    description: input.description ?? null,
    content: input.content,
    is_default: false,
    enabled: true,
    active: input.active ?? false,
  };
  await c.put(id, doc, { expectedVersion: 0 });
  return toSummary(doc);
}

export async function updateEthics(
  id: string,
  changes: { name?: string; content?: string; description?: string | null; active?: boolean },
): Promise<EthicsSummary> {
  const c = await ethicsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el código de ética "${id}"`);

  const doc: EthicsDoc = { ...entry.doc };
  if (changes.name !== undefined) doc.name = changes.name;
  if (changes.content !== undefined) doc.content = changes.content;
  if (changes.description !== undefined) doc.description = changes.description;
  if (changes.active !== undefined) doc.active = changes.active;

  await c.put(id, doc, { expectedVersion: entry.version });
  return toSummary(doc);
}

export const toggleEthics = (id: string, active: boolean) => updateEthics(id, { active });

/** No borra la plantilla del sistema: dejaría la instalación sin referencia. */
export async function deleteEthics(id: string): Promise<boolean> {
  const c = await ethicsCol();
  const entry = await c.get(id);
  if (!entry) return false;
  if (entry.doc.is_default) throw new Error("El código de ética por defecto no se puede borrar; desactívalo");
  await c.delete(id);
  return true;
}
