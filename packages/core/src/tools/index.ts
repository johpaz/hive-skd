/**
 * Tools Registry
 *
 * Import this to get all tools:
 * import { createAllTools } from "./tools";
 */

import type { Tool } from "./types";
import type { Config } from "../config/loader";

// Filesystem (7)
import * as filesystem from "./filesystem/index";

// Web (10)
import * as web from "./web/index";
import * as images from "./images/index";

// Cron (8) - scheduler tools
import * as cron from "./cron/index";

// CLI (1)
import * as cli from "./cli/index";

// Agents (15)
import * as agents from "./agents/index";

// A2UI (4)
import * as a2ui from "./a2ui/index";

// Core (4)
import * as core from "./core/index";

// Office (8)
import * as office from "./office/index";

// API (1) - HTTP client for REST APIs
import * as api from "./api/index";

// ─── Tools de la aplicación ──────────────────────────────────────────────────
//
// Punto de extensión propio del SDK: hive trae todas sus tools compiladas, pero
// acá `defineTool()` existe justamente para que la app aporte las suyas. Sin
// esto, una tool de usuario sólo se le podía anunciar al modelo (via
// `extraTools` del agent loop) pero no tenía ejecutor asociado, así que la
// llamada moría con "no matching executor found in allTools".

const appTools = new Map<string, Tool>();

/** Registra una tool de la aplicación para que entre en el loadout del agente. */
export function registerAppTool(tool: Tool): void {
  appTools.set(tool.name, tool);
}

/** Quita todas las tools registradas por la app (útil entre tests). */
export function clearAppTools(): void {
  appTools.clear();
}

/** Tools registradas por la app, en orden de registro. */
export function listAppTools(): Tool[] {
  return Array.from(appTools.values());
}

/**
 * Creates all tools with proper configuration
 */
export function createAllTools(config: Config): Tool[] {
  return [
    // FILESYSTEM (7)
    ...filesystem.createTools(),

    // WEB (10)
    ...web.createTools(),
    ...images.createTools(),

    // CRON (8)
    ...cron.createTools(),

    // CLI (1)
    ...cli.createTools(),

    // AGENTS (15)
    ...agents.createTools(),

    // A2UI (4)
    ...a2ui.createTools(config),

    // CORE (4)
    ...core.createTools(),

    // OFFICE (8)
    ...office.createTools(),

    // API (1)
    ...api.createTools(),

    // Las de la app van últimas: si una comparte nombre con una nativa, gana la
    // nativa, porque el selector busca por nombre y no queremos que registrar
    // una tool desde afuera secuestre `fs_read` o `task_delegate`.
    ...listAppTools(),
  ];
}

/**
 * Creates tools by category (for selective loading)
 */
export function createToolsByCategory(category: string, config: Config): Tool[] {
  switch (category) {
    case "filesystem":
      return filesystem.createTools();
    case "web":
      return web.createTools();
    case "cron":
      return cron.createTools();
    case "cli":
      return cli.createTools();
    case "agents":
      return agents.createTools();
    case "a2ui":
      return a2ui.createTools(config);
    case "core":
      return core.createTools();
    case "office":
      return office.createTools();
    case "api":
      return api.createTools();
    default:
      return [];
  }
}

// Export types
export * from "./types";

// Export tools by category (avoiding createTools name collisions)
// Use category-specific imports or createAllTools/createToolsByCategory
export {
  fsEditTool,
  fsReadTool,
  fsWriteTool,
  fsDeleteTool,
  fsListTool,
  fsGlobTool,
  fsExistsTool,
} from "./filesystem/index";

export {
  webSearchTool,
  webFetchTool,
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserExtractTool,
  browserScriptTool,
  browserWaitTool,
  artifactInspectTool,
} from "./web/index";

export {
  cronCreateTool,
  cronListTool,
  cronUpdateTool,
  cronPauseTool,
  cronResumeTool,
  cronDeleteTool,
  cronTriggerTool,
  cronHistoryTool,
  setSchedulerInstance,
  resolveBestChannel,
} from "./cron/index";

export { cliExecTool } from "./cli/index";

export {
  memoryWriteTool,
  memoryReadTool,
  memoryListTool,
  memorySearchTool,
  memoryDeleteTool,
  agentCreateTool,
  agentFindTool,
  agentArchiveTool,
  taskDelegateTool,
  taskReviseTool,
  taskListTool,
  taskStatusTool,
  busPublishTool,
  busReadTool,
} from "./agents/index";

export {
  createA2UISurfaceTool,
  createA2UIUpdateComponentsTool,
  createA2UIUpdateDataModelTool,
  createA2UIDeleteSurfaceTool,
} from "./a2ui/index";

export {
  searchKnowledgeTool,
  notifyTool,
  saveNoteTool,
  reportProgressTool,
} from "./core/index";

export {
  officeLeerPdfTool,
  officeEscribirPdfTool,
  officeLeerDocxTool,
  officeEscribirDocxTool,
  officeLeerXlsxTool,
  officeEscribirXlsxTool,
  officeLeerPptxTool,
  officeEscribirPptxTool,
} from "./office/index";

export {
  apiRequestTool,
} from "./api/index";

// Arranque del navegador. Las browser tools existen en el catálogo desde el
// seed, pero no operan hasta que alguien levanta el servicio: quien construya
// sobre el SDK necesita poder hacerlo sin importar rutas internas.
export {
  initializeBrowserService,
  getBrowserService,
  shutdownBrowser,
} from "./web/browser-service";

export * from "./images/index";
