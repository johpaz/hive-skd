/**
 * Memoria de largo plazo — la API, no la tool.
 *
 * Estas operaciones sólo existían dentro de `memoryWriteTool` y sus cuatro
 * hermanas (`tools/agents/index.ts`), con argumentos con forma de LLM y
 * respuestas escritas para un prompt. Una UI que quisiera listar o editar la
 * memoria del usuario tenía que llamar `tool.execute({...})` y parsear prosa,
 * o escribir consultas crudas contra HiveDB.
 *
 * Acá vive la implementación; las tools pasan a ser envoltorios que la llaman y
 * traducen el resultado al formato que espera el modelo. Una implementación,
 * dos consumidores.
 *
 * Estas funciones **lanzan** en vez de devolver `{ok:false}`: un error es un
 * error, y quien construya una UI quiere un `try/catch`, no inspeccionar un
 * campo. La traducción a `{ok:false, error}` la hace el envoltorio de la tool.
 *
 * **Cada memoria pertenece a un usuario.** La colección era global al proceso
 * —coherente con hive, que es mono-usuario— pero eso no sirve para un runtime
 * donde cada quien arma su colmena: dos usuarios no podían tener una memoria
 * con el mismo título, y cualquiera veía la del otro. `userId` es opcional en la
 * firma y se resuelve solo cuando no viene, para no romper a quien ya llamaba
 * estas funciones.
 */

import { col } from "../storage/hive";
import type { MemoryDoc } from "../storage/collections";
import { resolveUserId } from "../storage/onboarding";

export interface MemoryEntry {
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchHit {
  title: string;
  snippet: string;
}

const SNIPPET_CHARS = 200;

/**
 * `${userId}:${title}` — el título solo no alcanza como id en cuanto hay más de
 * un usuario. Guardar dos veces el mismo título del mismo usuario actualiza; el
 * de otro usuario es otra memoria.
 */
const memoryId = (userId: string, title: string) => `${userId}:${title}`;

/** Sin userId explícito se resuelve el del contexto; `""` es el caso mono-usuario. */
async function resolveOwner(userId?: string): Promise<string> {
  if (userId) return userId;
  return (await resolveUserId({}).catch(() => null)) ?? "";
}

function toEntry(doc: MemoryDoc): MemoryEntry {
  return {
    title: doc.title,
    content: doc.content,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

async function memoryCol() {
  return col<MemoryDoc>("memory");
}

/** Guarda o actualiza una entrada. Devuelve la entrada resultante. */
export async function writeMemory(title: string, content: string, userId?: string): Promise<MemoryEntry> {
  if (!title.trim()) throw new Error("La memoria necesita un título");

  const owner = await resolveOwner(userId);
  const id = memoryId(owner, title);
  const c = await memoryCol();
  const existing = await c.get(id);
  const now = Date.now();
  const doc: MemoryDoc = {
    id,
    user_id: owner,
    title,
    content,
    created_at: existing?.doc.created_at ?? now,
    updated_at: now,
  };
  await c.put(id, doc, { expectedVersion: existing?.version ?? 0 });
  return toEntry(doc);
}

/** La entrada, o null si no existe. */
export async function readMemory(title: string, userId?: string): Promise<MemoryEntry | null> {
  const owner = await resolveOwner(userId);
  const entry = await (await memoryCol()).get(memoryId(owner, title));
  return entry ? toEntry(entry.doc) : null;
}

/** Todas las entradas, de la más reciente a la más vieja. */
export async function listMemories(userId?: string): Promise<MemoryEntry[]> {
  const owner = await resolveOwner(userId);
  const rows = await (await memoryCol()).findBy("user_id", owner);
  return rows.map((e) => toEntry(e.doc)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Búsqueda por subcadena en título y contenido.
 *
 * Deliberadamente simple: no pasa por el índice BM25 porque la memoria no se
 * indexa ahí. Para colecciones grandes conviene revisarlo, pero cambiar el
 * comportamiento ahora rompería lo que el modelo ya espera.
 */
export async function searchMemories(query: string, userId?: string): Promise<MemorySearchHit[]> {
  const needle = query.toLowerCase();
  const owner = await resolveOwner(userId);
  const rows = await (await memoryCol()).findBy("user_id", owner);
  return rows
    .map((e) => e.doc)
    .filter((n) => n.content.toLowerCase().includes(needle) || n.title.toLowerCase().includes(needle))
    .map((n) => ({
      title: n.title,
      snippet: n.content.slice(0, SNIPPET_CHARS) + (n.content.length > SNIPPET_CHARS ? "..." : ""),
    }));
}

/** Borra una entrada. `false` si no existía. */
export async function deleteMemory(title: string, userId?: string): Promise<boolean> {
  const owner = await resolveOwner(userId);
  const id = memoryId(owner, title);
  const c = await memoryCol();
  if (!(await c.get(id))) return false;
  await c.delete(id);
  return true;
}
