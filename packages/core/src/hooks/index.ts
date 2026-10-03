/**
 * Hooks — engancharse al ciclo de vida sin bifurcar el SDK.
 *
 * `HooksConfigSchema` (`config/loader.ts`) declaraba 14 hooks y **ninguno se
 * invocaba**: era un esquema sin implementación. Quien lo encontrara asumiría
 * que funciona.
 *
 * Acá se implementan, con dos formas y una decisión de diseño detrás:
 *
 *  - **Callbacks en proceso** (`registerHook`) — tipados, sin costo de arranque,
 *    y pueden **devolver una decisión**: `beforeToolCall` puede impedir que una
 *    tool se ejecute. Es el primitivo, porque quien consume el SDK ya está en el
 *    mismo proceso.
 *  - **Scripts externos** (`hooks.scripts` en la configuración) — para quien no
 *    escribe TypeScript. Se montan encima del primitivo: cada script declarado
 *    se registra como un callback que lo ejecuta. Cuestan un `Bun.spawn` por
 *    invocación, así que conviene reservarlos para lo que no ocurre en cada
 *    tool call.
 *
 * Sólo están los hooks que tienen un uso claro. Los otros nueve del esquema
 * original se dejaron fuera a propósito: cada hook es una promesa que después
 * hay que sostener, y uno que nadie usa es superficie que envejece mal.
 */

import { logger } from "../utils/logger";
import { loadConfig } from "../config/loader";

const log = logger.child("hooks");

/** Lo que recibe un hook de tool. */
export interface ToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  agentId?: string;
  userId?: string;
  threadId?: string;
}

export interface ToolResultContext extends ToolCallContext {
  result: unknown;
  ok: boolean;
  durationMs: number;
}

export interface CompactionContext {
  threadId: string;
  messageCount: number;
  totalTokens: number;
}

export interface SessionContext {
  threadId: string;
  userId?: string;
  channel?: string;
}

/**
 * Lo que puede devolver `beforeToolCall`.
 *
 * `void` o `undefined` = seguir adelante. Devolver `{ block }` impide la
 * ejecución y el motivo le llega al modelo como resultado de la tool, para que
 * sepa por qué no se hizo en vez de reintentar a ciegas.
 */
export type BeforeToolCallResult = void | undefined | { block: true; reason: string };

export interface HookMap {
  beforeToolCall: (ctx: ToolCallContext) => BeforeToolCallResult | Promise<BeforeToolCallResult>;
  afterToolCall: (ctx: ToolResultContext) => void | Promise<void>;
  beforeCompaction: (ctx: CompactionContext) => void | Promise<void>;
  sessionStart: (ctx: SessionContext) => void | Promise<void>;
  sessionEnd: (ctx: SessionContext) => void | Promise<void>;
}

export type HookName = keyof HookMap;

const registry: { [K in HookName]: Array<HookMap[K]> } = {
  beforeToolCall: [],
  afterToolCall: [],
  beforeCompaction: [],
  sessionStart: [],
  sessionEnd: [],
};

/**
 * Registra un hook. Devuelve la función para quitarlo.
 *
 * Se pueden registrar varios del mismo tipo: corren en orden de registro.
 */
export function registerHook<K extends HookName>(name: K, fn: HookMap[K]): () => void {
  registry[name].push(fn);
  return () => {
    const i = registry[name].indexOf(fn);
    if (i >= 0) registry[name].splice(i, 1);
  };
}

/** Quita todos los hooks. Pensado para tests. */
export function clearHooks(name?: HookName): void {
  if (name) registry[name] = [];
  else for (const k of Object.keys(registry) as HookName[]) registry[k] = [];
}

export function hasHooks(name: HookName): boolean {
  return registry[name].length > 0;
}

/**
 * Corre los `beforeToolCall` y devuelve el motivo del bloqueo, si alguno objeta.
 *
 * El primero que bloquea gana: no tiene sentido seguir preguntando cuando ya
 * hay una negativa. Un hook que lanza **no** bloquea la ejecución —un error en
 * el observador no debería impedir el trabajo— pero se registra.
 */
export async function runBeforeToolCall(ctx: ToolCallContext): Promise<string | null> {
  for (const fn of registry.beforeToolCall) {
    try {
      const r = await fn(ctx);
      if (r && typeof r === "object" && r.block) return r.reason;
    } catch (err) {
      log.warn(`beforeToolCall falló para ${ctx.toolName}: ${(err as Error).message}`);
    }
  }
  return null;
}

/** Corre los hooks de observación. Nunca lanza: son observadores. */
async function runObservers<K extends "afterToolCall" | "beforeCompaction" | "sessionStart" | "sessionEnd">(
  name: K,
  ctx: Parameters<HookMap[K]>[0],
): Promise<void> {
  for (const fn of registry[name]) {
    try {
      await (fn as (c: unknown) => unknown)(ctx);
    } catch (err) {
      log.warn(`${name} falló: ${(err as Error).message}`);
    }
  }
}

export const runAfterToolCall = (ctx: ToolResultContext) => runObservers("afterToolCall", ctx);
export const runBeforeCompaction = (ctx: CompactionContext) => runObservers("beforeCompaction", ctx);
export const runSessionStart = (ctx: SessionContext) => runObservers("sessionStart", ctx);
export const runSessionEnd = (ctx: SessionContext) => runObservers("sessionEnd", ctx);

// ─── Scripts declarados en la configuración ──────────────────────────────────

/** Nombres del esquema de config → hooks implementados. */
const SCRIPT_MAP: Record<string, HookName> = {
  before_tool_call: "beforeToolCall",
  after_tool_call: "afterToolCall",
  before_compaction: "beforeCompaction",
  session_start: "sessionStart",
  session_end: "sessionEnd",
};

/**
 * Ejecuta un script pasándole el contexto como JSON por stdin.
 *
 * Convención para `before_tool_call`: **salir con código distinto de 0 bloquea**
 * la ejecución, y lo que el script escriba en stdout es el motivo que se le
 * cuenta al modelo. Es el equivalente en procesos a devolver `{ block }`.
 */
async function runScript(path: string, ctx: unknown): Promise<{ blocked: boolean; reason: string }> {
  const proc = Bun.spawn(["bun", path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(JSON.stringify(ctx));
  proc.stdin.end();

  const [salida, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { blocked: code !== 0, reason: salida.trim() || `el hook ${path} salió con código ${code}` };
}

let scriptsCargados = false;

/**
 * Registra los scripts declarados en `hooks.scripts`.
 *
 * Es opt-in y explícito: ejecutar procesos externos no es algo que deba pasar
 * por el solo hecho de importar el SDK. Idempotente.
 */
export function loadConfiguredHookScripts(): number {
  if (scriptsCargados) return 0;
  const scripts = loadConfig().hooks?.scripts;
  if (!scripts) return 0;

  let n = 0;
  for (const [clave, hook] of Object.entries(SCRIPT_MAP)) {
    const path = (scripts as Record<string, string | undefined>)[clave];
    if (!path) continue;

    if (hook === "beforeToolCall") {
      registerHook("beforeToolCall", async (ctx) => {
        const r = await runScript(path, ctx);
        return r.blocked ? { block: true as const, reason: r.reason } : undefined;
      });
    } else {
      registerHook(hook as "afterToolCall", async (ctx) => { await runScript(path, ctx); });
    }
    n++;
    log.info(`hook ${clave} → ${path}`);
  }
  scriptsCargados = true;
  return n;
}
