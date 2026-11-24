/**
 * Google Workspace tools (Gmail, Calendar, Drive).
 *
 * Sólo entran en el loadout cuando el host llamó `configureGoogle()`.
 * Cada tool opera con la cuenta que el usuario de la sesión conectó.
 */
import type { Tool } from "../types";
import { gmailTools } from "./gmail";
import { calendarTools } from "./calendar";
import { driveTools } from "./drive";

export function createTools(): Tool[] {
  return [...gmailTools, ...calendarTools, ...driveTools];
}

export * from "./gmail";
export * from "./calendar";
export * from "./drive";
