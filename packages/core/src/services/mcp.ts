/**
 * Servidores MCP — la API, no la ruta.
 *
 * Un servidor MCP es la vía real para que alguien sume capacidades propias sin
 * escribir código dentro del SDK: levanta un proceso que expone tools por el
 * protocolo, lo registra acá, y sus tools quedan disponibles para los agentes.
 *
 * Añade algo que hive no tiene: **`testMcpServer()`**. Allí probar un servidor
 * consiste en crearlo, activarlo y esperar a que el hot-reload lo conecte (~2s)
 * para ver si el estado quedó en `connected` o `error`. Para una UI eso es un
 * "guardá y cruzá los dedos"; acá se puede intentar la conexión y responder si
 * funcionó, sin dejar una fila a medio configurar.
 *
 * Las credenciales van cifradas por `storage/crypto.ts`: `headers` para los
 * transportes HTTP, `env` para los de stdio. Nunca se devuelven en claro.
 */

import { col } from "../storage/hive";
import type { McpServerDoc } from "../storage/collections";
import {
  storeMcpHeaders, loadMcpHeaders, storeMcpEnv, deleteMcpSecrets, maskApiKey,
} from "../storage/crypto";
import { getMCPManager } from "../mcp/singleton";
import { slugify } from "./agents";
import { logger } from "../utils/logger";

const log = logger.child("services/mcp");

export interface McpServerSummary {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  enabled: boolean;
  active: boolean;
  builtin: boolean;
  /** Estado en vivo si hay manager conectado; si no, el último persistido. */
  status: string;
  toolsCount: number;
  /** Sólo qué cabeceras hay configuradas, con el valor enmascarado. */
  maskedHeaders: Record<string, string>;
}

export interface CreateMcpInput {
  name: string;
  transport?: "stdio" | "http" | "sse";
  command?: string | null;
  args?: string[];
  url?: string | null;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
}

function parseArgs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Enmascara los valores: una UI necesita saber qué hay, no cuál es. */
function maskHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = maskApiKey(String(v));
  return out;
}

async function mcpCol() {
  return col<McpServerDoc>("mcpServers");
}

async function toSummary(doc: McpServerDoc): Promise<McpServerSummary> {
  const headers = await loadMcpHeaders(doc.id).catch(() => ({}));
  const manager = getMCPManager();
  const live = manager?.getServerStatus?.(doc.name);
  return {
    id: doc.id,
    name: doc.name,
    transport: doc.transport,
    command: doc.command,
    args: parseArgs(doc.args),
    url: doc.url,
    enabled: doc.enabled,
    active: doc.active,
    builtin: doc.builtin,
    status: live ?? doc.status,
    toolsCount: doc.tools_count,
    maskedHeaders: maskHeaders(headers as Record<string, unknown>),
  };
}

export async function listMcpServers(opts?: { includeDisabled?: boolean }): Promise<McpServerSummary[]> {
  const rows = await (await mcpCol()).scan({});
  const docs = rows.map((e) => e.doc).filter((d) => (opts?.includeDisabled ? true : d.enabled));
  return Promise.all(docs.map(toSummary));
}

export async function getMcpServer(id: string): Promise<McpServerSummary | null> {
  const entry = await (await mcpCol()).get(id);
  return entry ? toSummary(entry.doc) : null;
}

export async function createMcpServer(input: CreateMcpInput): Promise<McpServerSummary> {
  if (!input.name?.trim()) throw new Error("El servidor MCP necesita un nombre");

  const transport = input.transport ?? (input.url ? "http" : "stdio");
  if (transport === "stdio" && !input.command) throw new Error("Un servidor stdio necesita `command`");
  if (transport !== "stdio" && !input.url) throw new Error(`Un servidor ${transport} necesita \`url\``);

  const c = await mcpCol();
  const id = slugify(input.name).replace(/_/g, "-");
  if (await c.get(id)) throw new Error(`Ya existe un servidor MCP con id "${id}"`);

  const doc: McpServerDoc = {
    id,
    name: input.name,
    transport,
    command: input.command ?? null,
    args: JSON.stringify(input.args ?? []),
    url: input.url ?? null,
    enabled: input.enabled ?? true,
    active: false,
    builtin: false,
    status: "disconnected",
    tools_count: 0,
  };

  await c.put(id, doc, { expectedVersion: 0 });
  if (input.headers) await storeMcpHeaders(id, input.headers);
  if (input.env) await storeMcpEnv(id, input.env);
  log.info(`servidor MCP "${input.name}" registrado (${id})`);
  return toSummary(doc);
}

export async function updateMcpServer(
  id: string,
  changes: Partial<CreateMcpInput>,
): Promise<McpServerSummary> {
  const c = await mcpCol();
  const entry = await c.get(id);
  if (!entry) throw new Error(`No existe el servidor MCP "${id}"`);

  const doc: McpServerDoc = { ...entry.doc };
  if (changes.name !== undefined) doc.name = changes.name;
  if (changes.transport !== undefined) doc.transport = changes.transport;
  if (changes.command !== undefined) doc.command = changes.command;
  if (changes.args !== undefined) doc.args = JSON.stringify(changes.args);
  if (changes.url !== undefined) doc.url = changes.url;
  if (changes.enabled !== undefined) doc.enabled = changes.enabled;

  await c.put(id, doc, { expectedVersion: entry.version });
  if (changes.headers) await storeMcpHeaders(id, changes.headers);
  if (changes.env) await storeMcpEnv(id, changes.env);
  return toSummary(doc);
}

/**
 * Intenta conectar el servidor y reporta el resultado.
 *
 * Requiere un `MCPClientManager` activo: sin él no hay quién hable el protocolo,
 * y devolver "ok" sería mentir. Con manager, el estado que se devuelve es el
 * real tras el intento, no el que estaba guardado.
 */
export async function testMcpServer(id: string): Promise<{ ok: boolean; status: string; toolsCount?: number; error?: string }> {
  const entry = await (await mcpCol()).get(id);
  if (!entry) throw new Error(`No existe el servidor MCP "${id}"`);

  const manager = getMCPManager();
  if (!manager) {
    throw new Error("Probar un servidor MCP requiere un MCPClientManager activo");
  }

  try {
    await manager.connectServer(entry.doc.name);
    const status = manager.getServerStatus?.(entry.doc.name) ?? "unknown";
    return { ok: status === "connected", status };
  } catch (error) {
    return { ok: false, status: "error", error: (error as Error).message };
  }
}

export async function toggleMcpServer(id: string, enabled: boolean): Promise<McpServerSummary> {
  return updateMcpServer(id, { enabled });
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const c = await mcpCol();
  const entry = await c.get(id);
  if (!entry) return false;
  if (entry.doc.builtin) throw new Error("Un servidor MCP incorporado no se puede borrar; desactívalo");

  await c.delete(id);
  await deleteMcpSecrets(id).catch(() => {});
  return true;
}
