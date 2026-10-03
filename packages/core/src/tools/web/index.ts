/**
 * Web Tools - Browser automation + Web utilities
 * 
 * Las browser tools hablan con `BrowserBackend`, que hoy tiene una sola
 * implementación: Bun.WebView in-process sobre un Chromium del sistema.
 */

import type { Tool } from "../types";
import { webSearchTool } from "./web-search";
import { webFetchTool } from "./web-fetch";
import { browserNavigateTool } from "./browser-navigate";
import { browserScreenshotTool } from "./browser-screenshot";
import { computerUseTaskTool } from "./computer-use";
import { browserClickTool } from "./browser-click";
import { browserTypeTool } from "./browser-type";
import { browserExtractTool } from "./browser-extract";
import { browserScriptTool } from "./browser-script";
import { browserWaitTool } from "./browser-wait";
import { artifactInspectTool } from "./artifact-inspect";
import { artifactReadTool } from "./artifact-read";

export function createTools(): Tool[] {
  return [
    webSearchTool,
    webFetchTool,
    browserNavigateTool,
    browserScreenshotTool,
    computerUseTaskTool,
    browserClickTool,
    browserTypeTool,
    browserExtractTool,
    browserScriptTool,
    browserWaitTool,
    artifactInspectTool,
    artifactReadTool,
  ];
}

export * from "./web-search";
export * from "./web-fetch";
export * from "./browser-navigate";
export * from "./browser-screenshot";
export * from "./computer-use";
export * from "./browser-click";
export * from "./browser-type";
export * from "./browser-extract";
export * from "./browser-script";
export * from "./browser-wait";
export * from "./browser-service";
export * from "./artifact-inspect";
export * from "./artifact-read";
