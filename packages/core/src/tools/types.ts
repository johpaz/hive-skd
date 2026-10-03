/**
 * Tool Type Definitions
 * Shared across all tool categories
 * 
 * These types are shared by every native tool in Hive.
 */

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  /** Per-tool timeout (ms) override. Falls back to config.tools.timeouts[name] → workerPool.toolTimeoutMs. */
  timeoutMs?: number;
  execute: (
    params: Record<string, unknown>,
    config?: any
  ) => Promise<string | object>;
}

/**
 * Un parámetro en JSON Schema: el mismo formato que ven los modelos y que usan
 * todas las tools nativas. `type` puede ser una unión (`["string", "null"]`).
 */
export interface ToolParameter {
  type: string | string[];
  description?: string;
  enum?: Array<string | number | boolean | null>;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  additionalProperties?: boolean | ToolParameter;
}

/** Los parámetros de una tool: siempre un objeto. */
export type ToolParametersSchema = Tool["parameters"];

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  hint?: string;
}
