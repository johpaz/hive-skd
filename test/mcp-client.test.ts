/**
 * Cliente MCP del SDK contra servidores reales, hechos con @modelcontextprotocol/sdk.
 *
 * La suite no tenía ninguna prueba de MCP: subir el SDK de MCP (1.29 → 1.32) se
 * hacía a ciegas. Estas conectan de verdad por stdio y por Streamable HTTP,
 * listan las tools, llaman una y leen un recurso.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MCPClientManager } from "../packages/core/src/mcp/MCPClient";

const SERVER = join(import.meta.dir, "fixtures", "mcp-echo-server.ts");
let httpServer: ReturnType<typeof Bun.spawn> | undefined;
let httpPort = 0;

beforeAll(async () => {
  httpServer = Bun.spawn(["bun", SERVER, "--http", "0"], { stdout: "pipe", stderr: "ignore" });
  const reader = httpServer.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!/PORT=\d+/.test(seen)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  httpPort = Number(/PORT=(\d+)/.exec(seen)?.[1]);
  expect(httpPort).toBeGreaterThan(0);
});

afterAll(() => {
  httpServer?.kill();
});

const textOf = (content: unknown) => (content as Array<{ type: string; text?: string }>)[0]?.text;

async function connect(config: Record<string, unknown>) {
  const manager = new MCPClientManager({ servers: { echo: { enabled: true, ...config } as never } });
  await manager.initialize();
  await manager.connectServer("echo");
  return manager;
}

describe("MCPClientManager con servidores reales", () => {
  test("stdio: conecta, descubre la tool y la llama", async () => {
    const manager = await connect({ transport: "stdio", command: "bun", args: [SERVER] });
    try {
      expect(manager.getServerStatus("echo")).toBe("connected");
      expect(manager.getServerTools("echo").map(t => t.name)).toEqual(["sumar"]);
      expect(textOf(await manager.callTool("echo", "sumar", { a: 2, b: 3 }))).toBe("5");
    } finally {
      await manager.disconnectAll();
    }
  });

  test("Streamable HTTP: conecta, descubre la tool y la llama", async () => {
    const manager = await connect({ transport: "http", url: `http://127.0.0.1:${httpPort}/mcp` });
    try {
      expect(manager.getServerStatus("echo")).toBe("connected");
      expect(manager.getServerTools("echo").map(t => t.name)).toEqual(["sumar"]);
      expect(textOf(await manager.callTool("echo", "sumar", { a: 40, b: 2 }))).toBe("42");
    } finally {
      await manager.disconnectAll();
    }
  });

  test("lee un recurso", async () => {
    const manager = await connect({ transport: "stdio", command: "bun", args: [SERVER] });
    try {
      expect(manager.getServerResources("echo").map(r => r.uri)).toContain("hive://saludo");
      expect(JSON.stringify(await manager.readResource("echo", "hive://saludo"))).toContain("hola desde MCP");
    } finally {
      await manager.disconnectAll();
    }
  });

  test("un servidor que no existe deja el estado en error con el mensaje", async () => {
    const manager = new MCPClientManager({ servers: { echo: { transport: "http", url: "http://127.0.0.1:1/mcp" } } });
    await manager.initialize();
    await expect(manager.connectServer("echo")).rejects.toThrow();
    expect(manager.getServerStatus("echo")).toBe("error");
  });
});
