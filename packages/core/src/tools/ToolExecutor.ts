import type { ToolDefinition } from "./ToolRegistry";
import type { ToolRegistry } from "./ToolRegistry";
import { describeInvalidArgs } from "./validate-args";

export interface ToolExecutionResult {
  toolName: string;
  args: any;
  result: any;
  durationMs: number;
  error?: string;
}

export class ToolExecutor {
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  async execute(
    name: string,
    args: any,
    config?: any
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      return {
        toolName: name,
        args,
        result: null,
        durationMs: 0,
        error: `Tool '${name}' not found`,
      };
    }

    const start = Date.now();
    try {
      const invalid = describeInvalidArgs(name, tool.parameters, args);
      if (invalid) throw new Error(invalid);
      const result = await tool.execute(args, config);
      return {
        toolName: name,
        args,
        result,
        durationMs: Date.now() - start,
      };
    } catch (error: any) {
      return {
        toolName: name,
        args,
        result: null,
        durationMs: Date.now() - start,
        error: error.message || String(error),
      };
    }
  }

  async executeBatch(
    calls: Array<{ name: string; args: any }>,
    config?: any
  ): Promise<ToolExecutionResult[]> {
    return Promise.all(calls.map(c => this.execute(c.name, c.args, config)));
  }
}
