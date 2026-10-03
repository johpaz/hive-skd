/**
 * API Tools - HTTP client for REST APIs (curl-like)
 *
 * Makes requests to external APIs with full control over method, headers, body.
 */

import type { Tool } from "../types";
import { apiRequestTool } from "./api-request";

export function createTools(): Tool[] {
  return [
    apiRequestTool,
  ];
}

export { apiRequestTool } from "./api-request";
