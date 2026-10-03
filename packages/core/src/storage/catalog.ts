/**
 * Catálogo compartido, activación por inquilino.
 *
 * ## El problema
 *
 * `tools`, `skills` y `ethics` guardan dos cosas en la misma fila: el CONTENIDO
 * —el nombre de la tool, el cuerpo de la skill, el texto de la regla— y la
 * ELECCIÓN de quien la usa, en `active`/`enabled`. Mientras hubo una instalación
 * por usuario eso era correcto y simple.
 *
 * Con varios inquilinos en una sola HiveDB deja de serlo. `ensureHiveDb()`
 * siembra los catálogos en la partición de CADA enjambre, así que las mismas 62
 * tools y las mismas skills se copian tantas veces como enjambres haya, y se
 * vuelven a escribir en cada arranque. El contenido es idéntico en todas: la
 * única diferencia real entre dos particiones es qué eligió cada una.
 *
 * ## La separación
 *
 * **El contenido vive una sola vez**, en la colección sin prefijo de inquilino
 * —la misma que ve la app de escritorio—, y lo escribe quien instala: el seed
 * del SDK o, en Hive Cloud, la sincronización desde Postgres.
 *
 * **La elección vive en el inquilino**, en `catalogActivations`: una fila por
 * elemento tocado, con `active`/`enabled`. Sin fila, se hereda lo que diga el
 * catálogo. Un enjambre nuevo arranca entonces con CERO escrituras.
 *
 * **Lo propio del inquilino sigue siendo suyo.** No todo lo que cae en estas
 * colecciones es catálogo: las tools de un endpoint de API (`services/endpoints`)
 * y las skills o códigos de ética que alguien cree se escriben en la partición,
 * como siempre. Compartir la colección entera se los filtraría a los demás
 * inquilinos, que es exactamente lo que el prefijo vino a impedir.
 *
 * {@link catalogView} compone las tres capas detrás de la misma interfaz de
 * colección, así que los ~30 sitios que hacen `col("tools")` no se enteran.
 *
 * Sin inquilino en scope nada de esto se activa: `col()` devuelve la colección
 * de siempre y el modo local se comporta exactamente igual que antes.
 */

import type { DocEntry, PutDocOptions, ScanOptions } from "@johpaz/hive-db";
import { getHiveDb } from "./hivedb";
import { currentTenant, qualify } from "./tenant";

/**
 * Las colecciones cuyo contenido es catálogo de la instalación y no dato de un
 * inquilino.
 *
 * `providers` y `models` NO están acá, y es deliberado: lo que baja a la
 * partición de un enjambre no es el catálogo entero sino el subconjunto que su
 * workspace configuró, con su `base_url` y su `context_window`. Ahí la fila por
 * inquilino ES el dato correcto; lo que sobraba era que el SDK sembrara además
 * su catálogo estático encima (ver `seedAllData`).
 */
export const CATALOG_COLLECTIONS = new Set(["tools", "skills", "ethics"]);

/** Dónde vive la elección de cada inquilino. Se prefija como cualquier otra. */
const ACTIVATIONS = "catalogActivations";

/** Campos que son elección del inquilino y no contenido del catálogo. */
const ACTIVATION_FIELDS = ["active", "enabled"] as const;

/**
 * Lo que un inquilino decidió sobre una fila del catálogo.
 *
 * `hidden` cubre el borrado: un inquilino no puede borrar una fila compartida
 * —es de todos—, pero sí sacarla de su vista. Es lo que permite que
 * `pruneRetired()` y el borrado de una tool de endpoint sigan funcionando
 * dentro de una partición sin tocar a nadie más.
 */
interface ActivationDoc {
  id: string;
  collection: string;
  item_id: string;
  active: boolean;
  enabled: boolean;
  hidden: boolean;
  updated_at: number;
}

/**
 * La parte de `Collection` que usa el SDK.
 *
 * Existe porque `Collection` de hive-db es una clase con campos privados: nada
 * que no salga de `db.collection()` puede hacerse pasar por ella, ni siquiera
 * implementando los mismos métodos. La clase real satisface esta interfaz tal
 * cual, así que tipar `col()` con ella no cambia nada para quien la recibe.
 */
export interface DocStore<T> {
  put(id: string, doc: T, options?: PutDocOptions): Promise<number>;
  get(id: string): Promise<DocEntry<T> | undefined>;
  delete(id: string): Promise<boolean>;
  scan(options?: ScanOptions): Promise<DocEntry<T>[]>;
  count(): Promise<number>;
  createIndex(field: string, options?: { unique?: boolean }): Promise<void>;
  findBy(field: string, value: string | number | boolean, options?: ScanOptions): Promise<DocEntry<T>[]>;
}

function activationId(collection: string, itemId: string): string {
  return `${collection}:${itemId}`;
}

/** Aplica la elección del inquilino sobre la fila compartida. */
function withActivation<T>(doc: T, overlay: ActivationDoc | undefined): T {
  if (!overlay) return doc;
  const merged = { ...(doc as Record<string, unknown>) };
  if ("active" in merged) merged.active = overlay.active;
  if ("enabled" in merged) merged.enabled = overlay.enabled;
  return merged as T;
}

/**
 * `true` si lo único que cambia entre las dos filas es la elección.
 *
 * `updated_at` se ignora a propósito: todos los caminos de activación lo tocan
 * (`toggleTool`, `applySeedPlan`, `updateSkill`), y tomarlo como contenido haría
 * que encender una tool se guardara como una copia entera del catálogo por
 * inquilino — justo lo que esto viene a evitar.
 */
function soloCambiaLaEleccion(nuevo: unknown, compartido: unknown): boolean {
  const ignorar = new Set<string>([...ACTIVATION_FIELDS, "updated_at"]);
  const a = nuevo as Record<string, unknown>;
  const b = compartido as Record<string, unknown>;
  const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const clave of claves) {
    if (ignorar.has(clave)) continue;
    if (JSON.stringify(a[clave]) !== JSON.stringify(b[clave])) return false;
  }
  return true;
}

function ordenarPorId<T>(entries: DocEntry<T>[]): DocEntry<T>[] {
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function aplicarOpciones<T>(entries: DocEntry<T>[], options: ScanOptions = {}): DocEntry<T>[] {
  let salida = ordenarPorId(entries);
  if (options.prefix) salida = salida.filter((e) => e.id.startsWith(options.prefix!));
  if (options.start) salida = salida.filter((e) => e.id >= options.start!);
  if (options.reverse) salida = salida.reverse();
  if (options.offset) salida = salida.slice(options.offset);
  if (options.limit != null) salida = salida.slice(0, options.limit);
  return salida;
}

/**
 * Vista de una colección de catálogo para el inquilino activo: lo compartido
 * con su elección aplicada, más lo que el inquilino haya creado.
 *
 * **Versiones.** Para una fila compartida se devuelve la versión de la fila
 * compartida, y `put()` la ignora al escribir la activación (que lleva su propia
 * versión). El control optimista sigue siendo real dentro de cada capa; lo que
 * no hay es una versión única que cubra a las dos a la vez. Los escritores de
 * activación son toggles de usuario —leer, cambiar un booleano, escribir—, así
 * que lo que se pierde es la detección de dos toggles simultáneos sobre el mismo
 * elemento del mismo inquilino, y lo que se gana es no copiar el catálogo.
 */
export function catalogView<T>(
  compartida: DocStore<T>,
  propia: DocStore<T>,
  activaciones: DocStore<ActivationDoc>,
  nombre: string,
): DocStore<T> {
  const leerActivacion = async (id: string): Promise<ActivationDoc | undefined> =>
    (await activaciones.get(activationId(nombre, id)))?.doc;

  const escribirActivacion = async (id: string, doc: T): Promise<void> => {
    const actual = await activaciones.get(activationId(nombre, id));
    const fila = doc as Record<string, unknown>;
    await activaciones.put(activationId(nombre, id), {
      id: activationId(nombre, id),
      collection: nombre,
      item_id: id,
      active: fila.active === true,
      enabled: "enabled" in fila ? fila.enabled === true : true,
      hidden: false,
      updated_at: Date.now(),
    }, actual ? { expectedVersion: actual.version } : { expectedVersion: 0 });
  };

  return {
    async get(id) {
      const local = await propia.get(id);
      if (local) return local;
      const compartido = await compartida.get(id);
      if (!compartido) return undefined;
      const overlay = await leerActivacion(id);
      if (overlay?.hidden) return undefined;
      return { ...compartido, doc: withActivation(compartido.doc, overlay) };
    },

    async put(id, doc, options) {
      const local = await propia.get(id);
      if (local) return propia.put(id, doc, options);

      const compartido = await compartida.get(id);
      if (compartido) {
        if (soloCambiaLaEleccion(doc, compartido.doc)) {
          await escribirActivacion(id, doc);
          return compartido.version;
        }
        // El inquilino editó el CONTENIDO de una fila del catálogo: se queda con
        // su propia copia. `expectedVersion` venía de la fila compartida y acá
        // no aplica —la copia todavía no existe—, así que no se reenvía.
        return propia.put(id, doc);
      }

      return propia.put(id, doc, options);
    },

    async delete(id) {
      const local = await propia.get(id);
      if (local) {
        await activaciones.delete(activationId(nombre, id)).catch(() => false);
        return propia.delete(id);
      }
      const compartido = await compartida.get(id);
      if (!compartido) return false;
      const actual = await activaciones.get(activationId(nombre, id));
      if (actual?.doc.hidden) return false;
      await activaciones.put(activationId(nombre, id), {
        id: activationId(nombre, id),
        collection: nombre,
        item_id: id,
        active: false,
        enabled: false,
        hidden: true,
        updated_at: Date.now(),
      }, actual ? { expectedVersion: actual.version } : { expectedVersion: 0 });
      return true;
    },

    async scan(options) {
      const [compartidos, propios, overlays] = await Promise.all([
        compartida.scan({}),
        propia.scan({}),
        activaciones.scan({ prefix: `${nombre}:` }),
      ]);
      const porItem = new Map(overlays.map((e) => [e.doc.item_id, e.doc]));

      const porId = new Map<string, DocEntry<T>>();
      for (const entrada of compartidos) {
        const overlay = porItem.get(entrada.id);
        if (overlay?.hidden) continue;
        porId.set(entrada.id, { ...entrada, doc: withActivation(entrada.doc, overlay) });
      }
      // Lo propio gana: si el inquilino editó una fila del catálogo, su copia es
      // la que vale para él.
      for (const entrada of propios) porId.set(entrada.id, entrada);

      return aplicarOpciones([...porId.values()], options);
    },

    async count() {
      return (await this.scan({})).length;
    },

    async createIndex(field, options) {
      // Los índices de la colección compartida los crea el bootstrap sin
      // inquilino, una sola vez. Acá sólo corresponde el de la partición.
      await propia.createIndex(field, options);
    },

    async findBy(field, value, options) {
      // Sobre la vista combinada no hay un índice del motor que cubra las dos
      // capas, así que se filtra en memoria. El catálogo son decenas de filas,
      // no millones, y el único llamador es la búsqueda de skills por categoría.
      const todas = await this.scan({});
      const filtradas = todas.filter(
        (e) => (e.doc as Record<string, unknown>)[field] === value,
      );
      return aplicarOpciones(filtradas, options);
    },
  };
}

/** Handle a la colección de catálogo compartida (sin prefijo de inquilino). */
export async function sharedCatalogCol<T>(name: string): Promise<DocStore<T>> {
  const db = await getHiveDb();
  return db.collection<T>(name);
}

/**
 * La vista de catálogo de esta colección para el inquilino activo, ya cableada.
 *
 * Es lo que devuelve `col()` cuando corresponde; vive acá para que `hive.ts` no
 * tenga que conocer ni la colección de activaciones ni cómo se componen las
 * capas.
 */
export async function catalogCol<T>(name: string): Promise<DocStore<T>> {
  const db = await getHiveDb();
  return catalogView<T>(
    db.collection<T>(name),
    db.collection<T>(qualify(name)),
    db.collection<ActivationDoc>(qualify(ACTIVATIONS)),
    name,
  );
}

/**
 * Enciende o apaga un elemento del catálogo para el inquilino activo, sin tocar
 * la fila compartida.
 *
 * Es lo que usa un host multi-inquilino —Hive Cloud— para bajar a cada enjambre
 * lo que su workspace activó, en vez de escribirle una copia del catálogo.
 */
export async function setCatalogActivation(
  collection: string,
  itemId: string,
  eleccion: { active: boolean; enabled?: boolean },
): Promise<void> {
  if (!CATALOG_COLLECTIONS.has(collection)) {
    throw new Error(`setCatalogActivation: "${collection}" no es una colección de catálogo`);
  }
  const db = await getHiveDb();
  const activaciones = db.collection<ActivationDoc>(qualify(ACTIVATIONS));
  const id = activationId(collection, itemId);
  const actual = await activaciones.get(id);
  await activaciones.put(id, {
    id,
    collection,
    item_id: itemId,
    active: eleccion.active,
    enabled: eleccion.enabled ?? eleccion.active,
    hidden: false,
    updated_at: Date.now(),
  }, actual ? { expectedVersion: actual.version } : { expectedVersion: 0 });
}

/** Devuelve al inquilino a lo que diga el catálogo para ese elemento. */
export async function clearCatalogActivation(collection: string, itemId: string): Promise<boolean> {
  const db = await getHiveDb();
  const activaciones = db.collection<ActivationDoc>(qualify(ACTIVATIONS));
  return activaciones.delete(activationId(collection, itemId));
}

/** Lo que este inquilino tiene decidido sobre una colección del catálogo. */
export async function listCatalogActivations(
  collection: string,
): Promise<Array<{ itemId: string; active: boolean; enabled: boolean; hidden: boolean }>> {
  const db = await getHiveDb();
  const activaciones = db.collection<ActivationDoc>(qualify(ACTIVATIONS));
  const filas = await activaciones.scan({ prefix: `${collection}:` });
  return filas.map((e) => ({
    itemId: e.doc.item_id,
    active: e.doc.active,
    enabled: e.doc.enabled,
    hidden: e.doc.hidden,
  }));
}

/** `true` si esta colección se resuelve como catálogo compartido ahora mismo. */
export function esCatalogoCompartido(name: string): boolean {
  return currentTenant() !== null && CATALOG_COLLECTIONS.has(name);
}
