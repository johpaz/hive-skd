/**
 * Filesystem Tools - 7 tools
 * 
 * @category filesystem
 */

import type { Tool } from "../types";
import { fsReadTool } from "./fs-read";
import { fsWriteTool } from "./fs-write";
import { fsEditTool } from "./fs-edit";
import { fsDeleteTool } from "./fs-delete";
import { fsListTool } from "./fs-list";
import { fsGlobTool } from "./fs-glob";
import { fsExistsTool } from "./fs-exists";

export function createTools(): Tool[] {
  return [
    fsReadTool,
    fsWriteTool,
    fsEditTool,
    fsDeleteTool,
    fsListTool,
    fsGlobTool,
    fsExistsTool,
  ];
}

export * from "./fs-read";
export * from "./fs-write";
export * from "./fs-edit";
export * from "./fs-delete";
export * from "./fs-list";
export * from "./fs-glob";
export * from "./fs-exists";
