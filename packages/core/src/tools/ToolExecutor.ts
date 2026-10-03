import type { ToolDefinition } from "./ToolRegistry";
import type { ToolRegistry } from "./ToolRegistry";

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
      const validatedArgs = tool.schema ? tool.schema.parse(args) : args;
      const result = await tool.execute(validatedArgs, config);
      return {
        toolName: name,
        args: validatedArgs,
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
