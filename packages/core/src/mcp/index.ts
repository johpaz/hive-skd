export type { MCPTool, MCPResource, MCPPrompt } from "./MCPClient";
export { MCPClientManager } from "./MCPClient";
// `tool-sync.ts` reemplaza al viejo `MCPToolAdapter.ts`: aquel escribía a SQLite
// y sincronizaba a FTS5; éste escribe a la colección `mcpTools` de HiveDB y
// reindexa con `syncMCPToolsToIndex`.
export type { MCPToolDefinition } from "./tool-sync";
export { syncMCPToolsToDB, syncMCPToolsToIndex, clearMCPToolsFromDB } from "./tool-sync";
export type { MCPConfig, MCPServerConfig } from "./config";
export { setMCPManager, getMCPManager } from "./singleton";
export { startMCPHotReload, stopMCPHotReload } from "./hot-reload";
export type { LogLevel as MCPLogLevel, LogHandler as MCPLogHandler } from "./logger";
export { logger as mcpLogger } from "./logger";
export type { SSETransportConfig, WebSocketTransportConfig, StdioTransportConfig, TransportType, TransportOptions } from "./transports/index";
export { SSETransport, WebSocketTransport, createTransport } from "./transports/index";
