/**
 * Servidor MCP de prueba, construido con el propio @modelcontextprotocol/sdk.
 *
 *   bun test/fixtures/mcp-echo-server.ts            → stdio
 *   bun test/fixtures/mcp-echo-server.ts --http 0   → Streamable HTTP (puerto libre; imprime `PORT=n`)
 *
 * Expone una tool `sumar(a, b)` y un recurso `hive://saludo`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

function build(): McpServer {
  const server = new McpServer({ name: "echo", version: "1.0.0" });
  server.registerTool(
    "sumar",
    { description: "Suma dos números", inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );
  server.registerResource("saludo", "hive://saludo", { description: "Un saludo", mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, text: "hola desde MCP" }],
  }));
  return server;
}

const httpFlag = process.argv.indexOf("--http");
if (httpFlag === -1) {
  await build().connect(new StdioServerTransport());
} else {
  // Sin estado: cada petición tiene su propio servidor y transporte.
  const http = Bun.serve({
    port: Number(process.argv[httpFlag + 1] ?? 0),
    async fetch(request) {
      if (new URL(request.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await build().connect(transport);
      return transport.handleRequest(request);
    },
  });
  console.log(`PORT=${http.port}`);
}
