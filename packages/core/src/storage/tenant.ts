/**
 * Contexto de tenant — aislamiento de varios enjambres dentro de UNA sola HiveDB.
 *
 * Hive Cloud creaba una base física por enjambre porque `getHiveDb()` es un
 * singleton de proceso: para aislar dos enjambres había que aislar dos procesos.
 * Aquí el aislamiento pasa a ser lógico, prefijando el nombre de la colección.
 *
 * El prefijo va en el NOMBRE DE COLECCIÓN y no en el id del documento a
 * propósito. Las colecciones de HiveDB no son tablas separadas: son tres tablas
 * redb con el nombre de colección como primera componente de una clave
 * compuesta (`col_docs:(collection,id)`, `col_index_entries:(collection,field,
 * value,id)`). Prefijar el nombre sale casi gratis y, sobre todo, aísla también
 * los índices secundarios — que es justo lo que un prefijo en el id NO consigue,
 * porque `findBy(field, value)` recorre el índice de la colección entera y
 * devolvería filas de otros tenants.
 *
 * Sin tenant en scope `qualify()` es la identidad, así que la app de escritorio
 * y los tests siguen viendo exactamente los mismos nombres de colección que
 * antes. `HIVE_TENANT_REQUIRED=1` invierte esa tolerancia para los despliegues
 * multi-inquilino: una ruta que se olvide de entrar al contexto falla ruidosa en
 * la primera colección que toque, en vez de escribir en silencio fuera de su
 * partición.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface TenantContext {
  key: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Separador entre el tenant y el nombre de colección. */
const SEP = "__";

/**
 * `t_` + un uuid sin guiones. Corta a propósito: la clave se repite en cada
 * entrada de `col_docs` y de `col_index_entries`, así que cada carácter de más
 * se paga por documento y por entrada de índice.
 */
const KEY_PATTERN = /^t_[a-z0-9]{8,48}$/;

/**
 * Separador de los filtros escalares compuestos del índice BM25. U+001F (unit
 * separator) porque el motor construye el término como `field<US>value` y ese
 * byte no aparece nunca en un id ni en un tipo real.
 */
const FILTER_SEP = "\u001f";

/** Construye una tenant key válida a partir de un uuid (o cualquier id opaco). */
export function tenantKeyFromId(id: string): string {
  const normalized = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length < 8) {
    throw new Error(`tenantKeyFromId: id demasiado corto para ser único: "${id}"`);
  }
  return `t_${normalized.slice(0, 48)}`;
}

/** `true` si la cadena tiene forma de tenant key. */
export function isTenantKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/**
 * Ejecuta `fn` con `key` como tenant activo. Todo lo que `fn` haga por debajo
 * —incluidos los `await` encadenados— ve ese tenant; dos llamadas concurrentes
 * no se pisan porque cada una corre en su propio contexto de AsyncLocalStorage.
 *
 * Ojo: el contexto NO cruza a un `Worker`. Ningún código que corra dentro de un
 * worker puede tocar HiveDB esperando estar aislado.
 */
export function runInTenant<T>(key: string, fn: () => T): T {
  if (!isTenantKey(key)) {
    throw new Error(`runInTenant: tenant key inválida "${key}" (esperado ${KEY_PATTERN})`);
  }
  return storage.run({ key }, fn);
}

/** Tenant activo, o `null` si no hay ninguno (modo local/escritorio). */
export function currentTenant(): string | null {
  return storage.getStore()?.key ?? null;
}

/** Tenant activo; lanza si no hay. Para código que sólo tiene sentido aislado. */
export function requireTenant(context: string): string {
  const key = currentTenant();
  if (!key) {
    throw new Error(`${context} requiere un tenant activo (envolver en runInTenant)`);
  }
  return key;
}

/**
 * Nombre físico de una colección para el tenant activo.
 *
 * Es el único punto por el que pasa el aislamiento documental: `col()` lo llama
 * y con eso quedan cubiertos los ~300 sitios que hacen CRUD, más `nextId`,
 * `updateDoc`, `updateManyByIndex`, `findByAny` y `bumpRollup`.
 */
export function qualify(collection: string): string {
  const key = currentTenant();
  if (key) return `${key}${SEP}${collection}`;
  if (process.env.HIVE_TENANT_REQUIRED === "1") {
    throw new Error(
      `qualify("${collection}"): HIVE_TENANT_REQUIRED=1 y no hay tenant en scope. ` +
        `Falta envolver esta ruta en runInTenant().`
    );
  }
  return collection;
}

/**
 * Quita el prefijo de tenant de un nombre de colección físico. Devuelve el
 * nombre tal cual si no lo lleva.
 */
export function unqualify(collection: string): string {
  const match = /^t_[a-z0-9]{8,48}__(.+)$/.exec(collection);
  return match?.[1] ?? collection;
}

/**
 * Id de documento para el índice semántico (BM25), que es UNO solo compartido
 * por todos los tenants: ahí el aislamiento va en el id y en los filtros, no en
 * un nombre de colección.
 */
export function qualifyDocId(id: string): string {
  const key = currentTenant();
  return key ? `${key}:${id}` : id;
}

/** Inversa de {@link qualifyDocId}, para devolver ids limpios en los hits. */
export function unqualifyDocId(id: string): string {
  const match = /^t_[a-z0-9]{8,48}:(.+)$/.exec(id);
  return match?.[1] ?? id;
}

/**
 * Valor de un filtro escalar compuesto para el índice BM25.
 *
 * Hace falta porque `deleteByFilter` acepta UN SOLO filtro: un borrado masivo
 * por `type` en una base compartida se llevaría por delante los documentos de
 * todos los tenants. Con un campo sintético (`tenant__type`) el borrado vuelve a
 * ser de un solo filtro y sigue estando acotado al tenant.
 */
export function scopedFilterValue(...parts: string[]): string {
  return [currentTenant() ?? "_", ...parts].join(FILTER_SEP);
}
