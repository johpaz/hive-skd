/**
 * Endpoints HTTP como herramientas — lo más cerca de "crear una tool desde la UI".
 *
 * Una tool normal es código con un `execute`, y desde una interfaz no hay dónde
 * ponerlo. Este módulo invierte el problema: el usuario aporta **datos** —URL,
 * método, cabeceras, qué parámetros acepta— y el ejecutor es genérico y vive
 * acá. Así alguien suma una capacidad propia sin escribir código en el SDK y sin
 * levantar un servidor MCP, que eran las dos únicas vías.
 *
 * Al registrarse, un endpoint hace tres cosas:
 *  1. guarda su definición (`apiEndpoints`),
 *  2. cifra sus credenciales aparte, y
 *  3. escribe una fila en `tools` y reindexa, para que `search_knowledge` lo
 *     descubra. Sin ese último paso el modelo nunca sabría que existe: el
 *     loadout inicial es mínimo por diseño.
 *
 * La credencial nunca vuelve al llamador ni aparece en el resultado de una
 * ejecución — es el motivo por el que un endpoint es más seguro que darle al
 * modelo una `api_request` con la clave escrita en el prompt.
 */

import { col } from "../storage/hive";
import type { ApiEndpointDoc, ToolDoc } from "../storage/collections";
import { storeSecret, loadSecret, deleteSecret } from "../storage/crypto";
import { apiRequestTool } from "../tools/api/api-request";
import { registerAppTool } from "../tools/index";
import { syncToolCatalogToIndex } from "../agent/tool-selector";
import type { Tool } from "../tools/types";
import { slugify } from "./agents";
import { logger } from "../utils/logger";

const log = logger.child("services/endpoints");

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Las cabeceras con credenciales viven en el secret store, no en la fila. */
const secretKey = (id: string) => `endpoint:${id}:headers`;

export interface EndpointSummary {
  id: string;
  /** El nombre con el que el modelo la llama. */
  toolName: string;
  name: string;
  description: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  bodyTemplate: string | null;
  paramSchema: Record<string, unknown> | null;
  /** Qué cabeceras secretas hay configuradas — nunca sus valores. */
  secretHeaderNames: string[];
  enabled: boolean;
}

export interface CreateEndpointInput {
  name: string;
  description: string;
  url: string;
  method?: string;
  /** Cabeceras visibles (Content-Type, Accept…). */
  headers?: Record<string, string>;
  /** Cabeceras con credenciales: se cifran y no vuelven a salir. */
  secretHeaders?: Record<string, string>;
  query?: Record<string, string>;
  bodyTemplate?: string | null;
  /** JSON Schema de los parámetros que el modelo puede pasar. */
  paramSchema?: Record<string, unknown> | null;
  enabled?: boolean;
}

function parseObj(raw: string | null): Record<string, string> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** El nombre de la tool se deriva del id: `endpoint_<slug>`. */
export const toolNameFor = (id: string) => `endpoint_${id}`;

async function endpointsCol() {
  return col<ApiEndpointDoc>("apiEndpoints");
}

async function toSummary(doc: ApiEndpointDoc): Promise<EndpointSummary> {
  const secretos = await loadSecret(secretKey(doc.id)).catch(() => null);
  let nombres: string[] = [];
  try {
    nombres = secretos ? Object.keys(JSON.parse(secretos)) : [];
  } catch {
    nombres = [];
  }
  return {
    id: doc.id,
    toolName: toolNameFor(doc.id),
    name: doc.name,
    description: doc.description,
    method: doc.method,
    url: doc.url,
    headers: parseObj(doc.headers_json),
    query: parseObj(doc.query_json),
    bodyTemplate: doc.body_template,
    paramSchema: doc.param_schema_json ? JSON.parse(doc.param_schema_json) : null,
    secretHeaderNames: nombres,
    enabled: doc.enabled,
  };
}

/**
 * Reemplaza `{{param}}` por lo que el modelo haya pasado.
 *
 * Los valores se serializan como JSON cuando no son strings, para que un número
 * o un booleano no terminen como `[object Object]` dentro del cuerpo.
 */
function fillTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = params[key];
    if (v === undefined) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

/**
 * Construye la tool ejecutable de un endpoint.
 *
 * El ejecutor es `api_request`: no se reimplementa el cliente HTTP, con su
 * manejo de timeouts, redacción y detección de content-type. Lo que agrega esta
 * capa es resolver la credencial cifrada en el momento de llamar, de modo que
 * nunca pase por el prompt ni por el resultado.
 */
export function buildEndpointTool(ep: EndpointSummary): Tool {
  return {
    name: ep.toolName,
    description: ep.description,
    parameters: (ep.paramSchema as Tool["parameters"]) ?? { type: "object", properties: {} },
    execute: async (params: Record<string, unknown>) => {
      const secretos = await loadSecret(secretKey(ep.id)).catch(() => null);
      let secretHeaders: Record<string, string> = {};
      try {
        secretHeaders = secretos ? JSON.parse(secretos) : {};
      } catch {
        secretHeaders = {};
      }

      const url = new URL(fillTemplate(ep.url, params));
      for (const [k, v] of Object.entries(ep.query)) url.searchParams.set(k, fillTemplate(v, params));

      return apiRequestTool.execute({
        method: ep.method,
        url: url.toString(),
        headers: { ...ep.headers, ...secretHeaders },
        ...(ep.bodyTemplate ? { body: fillTemplate(ep.bodyTemplate, params) } : {}),
      });
    },
  };
}

/** Registra en el proceso las tools de todos los endpoints habilitados. */
export async function registerEndpointTools(): Promise<number> {
  const eps = await listEndpoints();
  for (const ep of eps) registerAppTool(buildEndpointTool(ep));
  return eps.length;
}

/** La fila en `tools` es lo que hace que `search_knowledge` lo encuentre. */
async function upsertToolRow(ep: EndpointSummary): Promise<void> {
  const c = await col<ToolDoc>("tools");
  const name = ep.toolName;
  const existing = await c.get(name);
  const now = Date.now();
  await c.put(name, {
    id: name,
    name,
    description: ep.description,
    category: "api",
    enabled: true,
    active: ep.enabled,
    created_at: existing?.doc.created_at ?? now,
    updated_at: now,
  }, { expectedVersion: existing?.version ?? 0 });
  await syncToolCatalogToIndex().catch((e) => log.warn(`no pude reindexar: ${(e as Error).message}`));
}

export async function createEndpoint(input: CreateEndpointInput): Promise<EndpointSummary> {
  if (!input.name?.trim()) throw new Error("El endpoint necesita un nombre");
  if (!input.description?.trim()) {
    throw new Error("El endpoint necesita una descripción: es lo que el modelo lee para decidir si le sirve");
  }
  if (!input.url?.trim()) throw new Error("El endpoint necesita una URL");

  const method = (input.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) throw new Error(`Método no permitido: ${method}`);

  const c = await endpointsCol();
  const id = slugify(input.name);
  if (await c.get(id)) throw new Error(`Ya existe un endpoint con id "${id}"`);

  const now = Date.now();
  const doc: ApiEndpointDoc = {
    id,
    name: input.name,
    description: input.description,
    method,
    url: input.url,
    headers_json: input.headers ? JSON.stringify(input.headers) : null,
    query_json: input.query ? JSON.stringify(input.query) : null,
    body_template: input.bodyTemplate ?? null,
    param_schema_json: input.paramSchema ? JSON.stringify(input.paramSchema) : null,
    enabled: input.enabled ?? true,
    created_at: now,
    updated_at: now,
  };

  await c.put(id, doc, { expectedVersion: 0 });
  if (input.secretHeaders) await storeSecret(secretKey(id), JSON.stringify(input.secretHeaders));

  const summary = await toSummary(doc);
  await upsertToolRow(summary);
  registerAppTool(buildEndpointTool(summary));
  log.info(`endpoint "${input.name}" registrado como tool ${summary.toolName}`);
  return summary;
}

export async function getEndpoint(id: string): Promise<EndpointSummary | null> {
  const entry = await (await endpointsCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

export async function listEndpoints(opts?: { includeDisabled?: boolean }): Promise<EndpointSummary[]> {
  const rows = await (await endpointsCol()).scan({});
  const docs = rows.map((e) => e.doc).filter((d) => (opts?.includeDisabled ? true : d.enabled));
  return Promise.all(docs.map(toSummary));
}

export async function updateEndpoint(id: string, changes: Partial<CreateEndpointInput>): Promise<EndpointSummary> {
  const c = await endpointsCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el endpoint "${id}"`);

  const doc: ApiEndpointDoc = { ...entry.doc, updated_at: Date.now() };
  if (changes.name !== undefined) doc.name = changes.name;
  if (changes.description !== undefined) doc.description = changes.description;
  if (changes.url !== undefined) doc.url = changes.url;
  if (changes.method !== undefined) {
    const m = changes.method.toUpperCase();
    if (!ALLOWED_METHODS.includes(m)) throw new Error(`Método no permitido: ${m}`);
    doc.method = m;
  }
  if (changes.headers !== undefined) doc.headers_json = JSON.stringify(changes.headers);
  if (changes.query !== undefined) doc.query_json = JSON.stringify(changes.query);
  if (changes.bodyTemplate !== undefined) doc.body_template = changes.bodyTemplate;
  if (changes.paramSchema !== undefined) {
    doc.param_schema_json = changes.paramSchema ? JSON.stringify(changes.paramSchema) : null;
  }
  if (changes.enabled !== undefined) doc.enabled = changes.enabled;

  await c.put(id, doc, { expectedVersion: entry.version });
  if (changes.secretHeaders) await storeSecret(secretKey(id), JSON.stringify(changes.secretHeaders));

  const summary = await toSummary(doc);
  await upsertToolRow(summary);
  registerAppTool(buildEndpointTool(summary));
  return summary;
}

export const toggleEndpoint = (id: string, enabled: boolean) => updateEndpoint(id, { enabled });

/**
 * Llama al endpoint sin pasar por el modelo, para que una UI pueda probarlo
 * antes de dejárselo a un agente.
 */
export async function testEndpoint(id: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const ep = await getEndpoint(id);
  if (!ep) throw new Error(`No existe el endpoint "${id}"`);
  return buildEndpointTool(ep).execute(params);
}

export async function deleteEndpoint(id: string): Promise<boolean> {
  const c = await endpointsCol();
  if (!(await c.get(id))) return false;

  await c.delete(id);
  await deleteSecret(secretKey(id)).catch(() => {});
  await (await col<ToolDoc>("tools")).delete(toolNameFor(id)).catch(() => {});
  await syncToolCatalogToIndex().catch(() => {});
  return true;
}
