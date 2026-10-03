/**
 * Skills — la API, no la tool.
 *
 * Una skill es instruccional: metadatos más un cuerpo markdown que se le inyecta
 * al agente. No tiene `execute`, y por eso —a diferencia de una tool— **sí puede
 * crearla un usuario desde una UI** sin abrir la puerta a ejecutar código
 * arbitrario. hive ya lo permite por HTTP; acá esa lógica deja de estar inline
 * en una ruta y pasa a ser una función que cualquier interfaz puede llamar.
 *
 * Conviven dos orígenes y no compiten:
 *
 *  - **Disco** — `SkillLoader` lee carpetas con `SKILL.md` desde el bundle,
 *    `~/.hive/skills`, `extraDirs` y el workspace. Es la vía de `hives add-skill`,
 *    versionable con git.
 *  - **Base de datos** — la colección `skills`, que es lo que el runtime
 *    consulta y lo que una UI edita.
 *
 * `importSkillFromDisk()` es el puente: materializa una skill de disco como fila
 * editable. La BD es la fuente de verdad en runtime; el disco es de dónde vino.
 *
 * Cada alta, edición o borrado re-sincroniza el índice BM25: una skill que no
 * está indexada es una skill que el modelo no encuentra.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { col } from "../storage/hive";
import type { SkillDoc } from "../storage/collections";
import { parseFrontmatter } from "../skills/SkillLoader";
import { syncSkillsToIndex } from "../agent/skill-selector";
import { slugify } from "./agents";
import { logger } from "../utils/logger";

const log = logger.child("services/skills");

export interface SkillSummary {
  id: string;
  name: string;
  description: string | null;
  version: string;
  author: string;
  icon: string;
  category: string;
  /** Tools que la skill espera tener disponibles. */
  tools: string[];
  triggers: string[];
  preferredAgents: string[];
  /** El contenido markdown que se le inyecta al agente. */
  body: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSkillInput {
  id?: string;
  name: string;
  description?: string | null;
  category?: string;
  body: string;
  tools?: string[];
  triggers?: string[];
  preferredAgents?: string[];
  version?: string;
  author?: string;
  icon?: string;
  active?: boolean;
}

export type UpdateSkillInput = Partial<Omit<CreateSkillInput, "id">>;

/** Los mismos defaults que usa hive al crear una skill desde su UI. */
const DEFAULTS = { version: "0.0.1", author: "Anonymous", icon: "🧩", category: "general" };

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  } catch {
    // Campo legacy en texto plano separado por comas.
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function toSummary(doc: SkillDoc): SkillSummary {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    version: doc.version,
    author: doc.author,
    icon: doc.icon,
    category: doc.category,
    tools: parseList(doc.tools),
    triggers: parseList(doc.triggers),
    preferredAgents: parseList(doc.preferred_agents),
    body: doc.body,
    active: doc.active,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

async function skillsCol() {
  return col<SkillDoc>("skills");
}

export async function createSkill(input: CreateSkillInput): Promise<SkillSummary> {
  if (!input.name?.trim()) throw new Error("La skill necesita un nombre");
  if (!input.body?.trim()) throw new Error("La skill necesita un cuerpo: es lo que lee el agente");

  const c = await skillsCol();
  const id = input.id ?? crypto.randomUUID();
  if (await c.get(id)) throw new Error(`Ya existe una skill con id "${id}"`);

  const now = Date.now();
  const doc: SkillDoc = {
    id,
    name: input.name,
    description: input.description ?? null,
    version: input.version ?? DEFAULTS.version,
    author: input.author ?? DEFAULTS.author,
    icon: input.icon ?? DEFAULTS.icon,
    category: input.category ?? DEFAULTS.category,
    permissions: "[]",
    dependencies: "[]",
    tools: JSON.stringify(input.tools ?? []),
    triggers: JSON.stringify(input.triggers ?? []),
    preferred_agents: JSON.stringify(input.preferredAgents ?? []),
    body: input.body,
    version_num: 1,
    active: input.active ?? true,
    created_at: now,
    updated_at: now,
  };

  await c.put(id, doc, { expectedVersion: 0 });
  await syncSkillsToIndex().catch((e) => log.warn(`no pude reindexar: ${(e as Error).message}`));
  log.info(`skill "${input.name}" creada (${id})`);
  return toSummary(doc);
}

export async function getSkill(id: string): Promise<SkillSummary | null> {
  const entry = await (await skillsCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

export async function listSkills(opts?: { includeInactive?: boolean; category?: string }): Promise<SkillSummary[]> {
  const rows = await (await skillsCol()).scan({});
  return rows
    .map((e) => e.doc)
    .filter((d) => (opts?.includeInactive ? true : d.active))
    .filter((d) => (opts?.category ? d.category === opts.category : true))
    .map(toSummary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateSkill(id: string, changes: UpdateSkillInput): Promise<SkillSummary> {
  const c = await skillsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe la skill "${id}"`);

  const doc: SkillDoc = { ...entry.doc, updated_at: Date.now() };
  if (changes.name !== undefined) doc.name = changes.name;
  if (changes.description !== undefined) doc.description = changes.description;
  if (changes.category !== undefined) doc.category = changes.category;
  if (changes.version !== undefined) doc.version = changes.version;
  if (changes.author !== undefined) doc.author = changes.author;
  if (changes.icon !== undefined) doc.icon = changes.icon;
  if (changes.active !== undefined) doc.active = changes.active;
  if (changes.tools !== undefined) doc.tools = JSON.stringify(changes.tools);
  if (changes.triggers !== undefined) doc.triggers = JSON.stringify(changes.triggers);
  if (changes.preferredAgents !== undefined) doc.preferred_agents = JSON.stringify(changes.preferredAgents);
  if (changes.body !== undefined) {
    doc.body = changes.body;
    // Editar el contenido es una versión nueva: es lo que cambia el comportamiento.
    doc.version_num = (entry.doc.version_num ?? 1) + 1;
  }

  await c.put(id, doc, { expectedVersion: entry.version });
  await syncSkillsToIndex().catch((e) => log.warn(`no pude reindexar: ${(e as Error).message}`));
  return toSummary(doc);
}

export const toggleSkill = (id: string, active: boolean) => updateSkill(id, { active });

export async function deleteSkill(id: string): Promise<boolean> {
  const c = await skillsCol();
  if (!(await c.get(id))) return false;
  await c.delete(id);
  await syncSkillsToIndex().catch((e) => log.warn(`no pude reindexar: ${(e as Error).message}`));
  return true;
}

/**
 * Importa una skill del disco a la base.
 *
 * Acepta la ruta de un `SKILL.md` o la de la carpeta que lo contiene — que es
 * lo que produce `hives add-skill` y lo que el usuario escribe a mano. El
 * frontmatter se parsea con el mismo `parseFrontmatter` que usa `SkillLoader`,
 * para que disco y BD no puedan divergir en qué consideran válido.
 *
 * Es idempotente por id: reimportar actualiza en vez de duplicar, así se puede
 * editar el archivo y volver a importarlo.
 */
export async function importSkillFromDisk(path: string): Promise<SkillSummary> {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "SKILL.md") : path;
  if (!existsSync(file)) throw new Error(`No encuentro ${file}`);

  const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf-8"));
  const fm = frontmatter as Record<string, any>;

  const name = String(fm.name ?? "").trim();
  if (!name) throw new Error(`${file} no declara \`name\` en su frontmatter`);
  if (!body.trim()) throw new Error(`${file} no tiene cuerpo: no hay nada que inyectarle al agente`);

  const id = slugify(String(fm.id ?? name));
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];

  const campos = {
    name,
    description: fm.description ? String(fm.description) : null,
    category: fm.category ? String(fm.category) : DEFAULTS.category,
    body,
    tools: asList(fm.tools),
    triggers: asList(fm.triggers),
    preferredAgents: asList(fm.preferred_agents),
    version: fm.version ? String(fm.version) : DEFAULTS.version,
    author: fm.author ? String(fm.author) : DEFAULTS.author,
    icon: fm.icon ? String(fm.icon) : DEFAULTS.icon,
  };

  const existente = await getSkill(id);
  if (existente) {
    log.info(`skill "${name}" reimportada desde ${file}`);
    return updateSkill(id, campos);
  }
  return createSkill({ id, ...campos });
}
