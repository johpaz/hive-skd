/**
 * cli_exec - Execute shell commands
 *
 * @category cli
 * @seedId cli_exec
 * @spanish ejecutar comando, terminal, bash, script, consola
 */

import type { Tool } from "../types";
import { logger } from "../../utils/logger";
import { resolveInWorkspace, getWorkspace, expandPath } from "../filesystem/workspace-guard";
import * as fs from "node:fs";
import { loadConfig } from "../../config/loader";

const log = logger.child("cli-exec");

/**
 * Patterns that are unconditionally blocked regardless of workspace config.
 * Checked against the full command string (lowercased).
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf\s+\/[^\s]*/, reason: "recursive delete from root" },
  { pattern: /rm\s+-rf\s+~/, reason: "recursive delete from home" },
  { pattern: />\s*\/dev\//, reason: "write to device file" },
  { pattern: /mkfs/, reason: "filesystem format" },
  { pattern: /dd\s+if=/, reason: "raw disk write" },
  { pattern: /:\(\)\s*\{/, reason: "fork bomb pattern" },
  { pattern: /del\s+\/f\s+\/s/, reason: "recursive force delete (Windows)" },
  { pattern: /format\s+[a-z]:/i, reason: "disk format (Windows)" },
];

/** El primer token del comando: `git status` → `git`. Es lo que se compara. */
function commandName(command: string): string {
  const limpio = command.trim().replace(/^\s*(sudo|env|nohup)\s+/i, "");
  return (limpio.split(/[\s;|&<>]/)[0] ?? "").split("/").pop() ?? "";
}

/**
 * Aplica la política de comandos que el usuario configuró.
 *
 * `tools.exec.allowlist` y `.denylist` existían en el esquema de configuración y
 * **no las leía nadie**: alguien podía escribir `denylist: ["curl", "rm"]`
 * creyendo que restringía a sus agentes, y no restringía nada. En una opción de
 * seguridad eso es peor que no tenerla, porque da confianza falsa.
 *
 * `BLOCKED_PATTERNS` sigue siendo incondicional: lo catastrófico se bloquea
 * haya o no configuración. Esta capa es la que el usuario controla.
 *
 * Precedencia: si hay allowlist, sólo eso se permite (es la postura más
 * restrictiva y la que alguien espera al escribirla). La denylist se aplica
 * después, para poder tener una allowlist amplia con excepciones puntuales.
 *
 * Devuelve el motivo del rechazo, o `null` si no hay objeción.
 */
function checkExecPolicy(command: string): string | null {
  const exec = loadConfig().tools?.exec;
  if (!exec) return null;

  if (exec.enabled === false) {
    return "La ejecución de comandos está deshabilitada en la configuración";
  }

  const nombre = commandName(command).toLowerCase();
  if (!nombre) return null;

  const permitidos = exec.allowlist?.map((c) => c.toLowerCase());
  if (permitidos?.length && !permitidos.includes(nombre)) {
    return `Comando no permitido: "${nombre}". Permitidos: ${permitidos.join(", ")}`;
  }

  const denegados = exec.denylist?.map((c) => c.toLowerCase());
  if (denegados?.includes(nombre)) {
    return `Comando denegado por la configuración: "${nombre}"`;
  }

  return null;   // sin objeción
}

export const cliExecTool: Tool = {
  name: "cli_exec",
  // Long-running commands need a generous runtime ceiling (the tool allows
  // its own per-call `timeout` up to 300s, so the harness timeout must be
  // above that to avoid the worker killing a still-running command).
  timeoutMs: 330000,
  description: "Execute shell/bash commands in the agent workspace. NOTE: do NOT use for scheduling tasks, use cron.create instead. Spanish: ejecutar comando, terminal, bash, script, consola",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute (supports pipes, redirections, variables)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 30, max: 300)",
      },
      cwd: {
        type: "string",
        description: "Working directory (default: agent workspace)",
      },
    },
    required: ["command"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const command = params.command as string;
    const timeoutSecs = Math.min((params.timeout as number) ?? 30, 300);
    const timeoutMs = timeoutSecs * 1000;

    // ── Workspace enforcement ──────────────────────────────────────────────────
    const workspace = getWorkspace(config);
    const defaultCwd = workspace ? expandPath(workspace) : process.cwd();

    let cwd: string;
    try {
      const rawCwd = (params.cwd as string) ?? defaultCwd;
      cwd = resolveInWorkspace(rawCwd, workspace);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    // Ensure cwd exists
    if (!fs.existsSync(cwd)) {
      return { ok: false, error: `Working directory not found: ${cwd}` };
    }

    // ── Política configurable por el usuario ──────────────────────────────────
    const objecion = checkExecPolicy(command);
    if (objecion) {
      log.warn(`bloqueado por configuración: ${command}`);
      return { ok: false, error: objecion };
    }

    // ── Dangerous pattern check ────────────────────────────────────────────────
    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return {
          ok: false,
          error: `Command not allowed: ${reason}`,
        };
      }
    }

    log.info(`Executing: ${command} (cwd=${cwd})`);

    const t0 = performance.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      // Use sh -c so pipes, redirections, variables, and quoted args all work
      const proc = Bun.spawn(["/bin/sh", "-c", command], {
        cwd,
        signal: controller.signal,
        stdout: "pipe",
        stderr: "pipe",
      });

      let stdout = "";
      let stderr = "";
      let exitCode: number;

      try {
        [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        exitCode = await proc.exited;
      } catch {
        // AbortController fired — process was killed due to timeout
        exitCode = -1;
        stdout = stdout || "";
        stderr = stderr || `Process killed after ${timeoutSecs}s timeout`;
      } finally {
        clearTimeout(timeoutId);
      }

      const elapsedMs = Math.round(performance.now() - t0);

      return {
        ok: exitCode === 0,
        command,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        executionTimeMs: elapsedMs,
        cwd,
      };
    } catch (error) {
      log.error(`Command failed: ${(error as Error).message}`);
      return {
        ok: false,
        error: `Command execution failed: ${(error as Error).message}`,
      };
    }
  },
};

export function createTools(): Tool[] {
  return [cliExecTool];
}
