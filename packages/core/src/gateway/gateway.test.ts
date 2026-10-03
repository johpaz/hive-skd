import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { startGateway } from "./index";

describe("gateway", () => {
  let server: ReturnType<typeof startGateway> extends Promise<infer T> ? T : never;
  // Puerto 0 = el sistema asigna uno libre. Con un puerto fijo, cualquier otro
  // proceso que lo ocupe tumba la suite entera — y desde que los tests son
  // condición para publicar, un puerto ajeno bloqueaba el release.
  let base: string;

  beforeAll(async () => {
    server = await startGateway({ host: "127.0.0.1", port: 0, agentId: "test" });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
  });

  it("returns health status", async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.gateway).toBe(true);
    expect(body.agentId).toBe("test");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${base}/unknown`);
    expect(res.status).toBe(404);
  });

  it("chat endpoint requires database setup", async () => {
    const res = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    // Will fail because no DB/agent configured, but endpoint exists
    expect(res.status).toBe(500);
  });
});
