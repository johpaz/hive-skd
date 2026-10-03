import type { ToolParametersSchema } from "./types";

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * Parámetros en JSON Schema — el mismo formato que ve el modelo y que usan las
   * tools nativas: `{ type: "object", properties: {...}, required: [...] }`.
   * Sin `parameters` la tool se ofrece sin argumentos.
   */
  parameters?: ToolParametersSchema;
  execute: (args: any, config?: any) => Promise<any>;
  category?: string;
  abstractionLevel?: "atomic" | "orchestration";
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getByCategory(category: string): ToolDefinition[] {
    return this.list().filter(t => t.category === category);
  }

  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  size(): number {
    return this.tools.size;
  }

  merge(other: ToolRegistry): void {
    for (const tool of other.list()) {
      if (!this.tools.has(tool.name)) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  clear(): void {
    this.tools.clear();
  }
}

/**
 * Declara una tool de la app. La definición se comprueba **aquí**, al declararla:
 * un `parameters` mal formado fallaría más tarde y lejos —el modelo recibiría una
 * tool sin argumentos o un esquema que su proveedor rechaza—, y un `schema` de zod
 * (que existía hasta 0.5) no se ignora en silencio: se explica el cambio.
 */
export function defineTool(config: ToolDefinition): ToolDefinition {
  const name = config?.name;
  if (typeof name !== "string" || name.trim() === "") throw new Error("defineTool: falta `name`");
  // Una descripción vacía se admite (el registro no la necesita), pero la tool no
  // se podrá encontrar por capacidad: `description` es lo que busca el agente.
  if (typeof config.description !== "string") {
    throw new Error(`defineTool(${name}): falta \`description\` (es lo que hace encontrable a la tool)`);
  }
  if (typeof config.execute !== "function") throw new Error(`defineTool(${name}): falta \`execute\``);

  if ("schema" in (config as object)) {
    throw new Error(
      `defineTool(${name}): \`schema\` ya no existe. Declara los argumentos con \`parameters\` en JSON Schema: ` +
      `{ type: "object", properties: { ciudad: { type: "string", description: "..." } }, required: ["ciudad"] }. ` +
      `Ver CHANGELOG 0.6.0.`,
    );
  }

  const parameters = config.parameters;
  if (parameters !== undefined) {
    if (typeof parameters !== "object" || parameters === null || parameters.type !== "object") {
      throw new Error(`defineTool(${name}): \`parameters.type\` debe ser "object"`);
    }
    if (parameters.properties !== undefined && (typeof parameters.properties !== "object" || parameters.properties === null)) {
      throw new Error(`defineTool(${name}): \`parameters.properties\` debe ser un objeto`);
    }
    const known = new Set(Object.keys(parameters.properties ?? {}));
    const missing = (parameters.required ?? []).filter((key) => !known.has(key));
    if (missing.length > 0) {
      throw new Error(`defineTool(${name}): \`required\` menciona parámetros que no están en \`properties\`: ${missing.join(", ")}`);
    }
  }
  return config;
}
