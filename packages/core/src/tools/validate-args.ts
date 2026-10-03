/**
 * Validación de los argumentos de una tool contra su JSON Schema, sin librerías.
 *
 * Cubre el subconjunto que usan las tools (`type`, `enum`, `required`,
 * `properties` anidadas, `items`, `minimum/maximum`, `minLength/maxLength`,
 * `pattern` y `additionalProperties: false`). Lo que no entiende lo deja pasar:
 * una validación que rechaza de más rompe llamadas que antes funcionaban,
 * y una que acepta de más solo deja que la tool decida.
 *
 * Los mensajes están escritos para el modelo, que los recibe como resultado de
 * la tool y puede corregir la llamada: dicen qué falta y qué parámetros existen.
 */

import type { ToolParameter, ToolParametersSchema } from "./types";

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    default: return true; // un tipo que no conocemos no se rechaza
  }
}

function validateValue(value: unknown, schema: ToolParameter, path: string, errors: string[]): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((t) => matchesType(value, t))) {
    errors.push(`"${path}" debe ser ${types.join(" o ")} (recibí ${typeOf(value)})`);
    return;
  }

  if (schema.enum && !schema.enum.some((option) => option === value)) {
    errors.push(`"${path}" debe ser uno de: ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`"${path}" debe ser ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`"${path}" debe ser ≤ ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`"${path}" debe tener al menos ${schema.minLength} caracteres`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`"${path}" debe tener como máximo ${schema.maxLength} caracteres`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`"${path}" no cumple el formato ${schema.pattern}`);
      } catch { /* un patrón inválido no es culpa de quien llama */ }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (const [i, item] of value.entries()) validateValue(item, schema.items, `${path}[${i}]`, errors);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && (schema.properties || schema.required)) {
    validateObject(value as Record<string, unknown>, schema, path, errors);
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: { properties?: Record<string, ToolParameter>; required?: string[]; additionalProperties?: boolean | ToolParameter },
  path: string,
  errors: string[],
): void {
  const properties = schema.properties ?? {};
  const prefix = path ? `${path}.` : "";

  for (const name of schema.required ?? []) {
    if (value[name] === undefined) errors.push(`falta "${prefix}${name}"`);
  }
  for (const [name, child] of Object.entries(properties)) {
    if (value[name] !== undefined) validateValue(value[name], child, `${prefix}${name}`, errors);
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!(name in properties)) errors.push(`"${prefix}${name}" no existe`);
    }
  }
}

/** Lista de problemas de `args` frente a `parameters`; vacía si son válidos. */
export function validateToolArgs(parameters: ToolParametersSchema | undefined, args: unknown): string[] {
  if (!parameters) return [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [`los argumentos deben ser un objeto (recibí ${typeOf(args)})`];
  }
  const errors: string[] = [];
  validateObject(args as Record<string, unknown>, parameters, "", errors);
  return errors;
}

/**
 * Mensaje de error para el modelo, con los parámetros que sí existen — cuando
 * inventa un nombre (`query` en lugar de `consulta`) es lo que necesita para
 * corregir. `null` si los argumentos son válidos.
 */
export function describeInvalidArgs(toolName: string, parameters: ToolParametersSchema | undefined, args: unknown): string | null {
  const errors = validateToolArgs(parameters, args);
  if (errors.length === 0) return null;
  const known = Object.keys(parameters?.properties ?? {});
  const received = typeof args === "object" && args !== null && !Array.isArray(args) ? Object.keys(args) : [];
  const hint = known.length ? ` Parámetros de ${toolName}: ${known.join(", ")}.` : "";
  const got = received.length ? ` Recibí: ${received.join(", ")}.` : "";
  return `Argumentos inválidos para ${toolName}: ${errors.join("; ")}.${hint}${got}`;
}
