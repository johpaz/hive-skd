/**
 * `api_request` cambió de contrato en 0.1.5.
 *
 * El tool anterior (`tools/web/api-request.ts`) tenía helpers de autenticación
 * (`auth: { type: "bearer" | "basic" | "api_key" }`), aceptaba `body` como
 * objeto y devolvía `{ ok, status, data }`. El de hive es más chato: la
 * autenticación va como un header más, `body` es string, y la respuesta expone
 * `body` + `contentType` en vez de `data`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { apiRequestTool } from "./api-request";

describe("apiRequestTool", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: (url: string, init: RequestInit) => Response) {
    globalThis.fetch = Object.assign(
      async (url: any, init?: any) => handler(url.toString(), init ?? {}),
      { preconnect: async () => undefined }
    ) as typeof fetch;
  }

  function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      statusText: init.statusText ?? "OK",
      headers: { "content-type": "application/json" },
    });
  }

  it("ejecuta un GET simple y parsea el JSON", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ hello: "world" });
    });

    const result = await apiRequestTool.execute({
      method: "GET",
      url: "https://api.example.com/data",
    }) as any;

    expect(capturedUrl).toBe("https://api.example.com/data");
    expect(capturedInit.method).toBe("GET");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ hello: "world" });
  });

  it("manda POST con el body tal cual y los headers dados", async () => {
    let capturedInit: RequestInit = {};
    stubFetch((_url, init) => {
      capturedInit = init;
      return jsonResponse({ id: 1 }, { status: 201, statusText: "Created" });
    });

    const result = await apiRequestTool.execute({
      method: "POST",
      url: "https://api.example.com/items",
      body: JSON.stringify({ name: "test" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
    }) as any;

    expect(capturedInit.method).toBe("POST");
    expect(capturedInit.body).toBe('{"name":"test"}');
    expect((capturedInit.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: 1 });
  });

  it("codifica query_params en la URL", async () => {
    let capturedUrl = "";
    stubFetch((url) => {
      capturedUrl = url;
      return jsonResponse({});
    });

    await apiRequestTool.execute({
      method: "GET",
      url: "https://api.example.com/search",
      query_params: { q: "hola mundo", limit: "10" },
    });

    expect(capturedUrl).toContain("q=hola+mundo");
    expect(capturedUrl).toContain("limit=10");
  });

  it("devuelve texto plano sin intentar parsearlo", async () => {
    stubFetch(() => new Response("hello world", {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain" },
    }));

    const result = await apiRequestTool.execute({
      method: "GET",
      url: "https://api.example.com/text",
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.body).toBe("hello world");
    expect(result.contentType).toContain("text/plain");
  });

  it("marca ok:false en un HTTP no exitoso sin lanzar", async () => {
    stubFetch(() => jsonResponse({ error: "not found" }, { status: 404, statusText: "Not Found" }));

    const result = await apiRequestTool.execute({
      method: "GET",
      url: "https://api.example.com/missing",
    }) as any;

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.statusText).toBe("Not Found");
  });

  it("rechaza un método no permitido antes de tocar la red", async () => {
    let called = false;
    stubFetch(() => { called = true; return jsonResponse({}); });

    const result = await apiRequestTool.execute({
      method: "TRACE",
      url: "https://api.example.com/data",
    }) as any;

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid HTTP method");
  });

  it("exige url", async () => {
    const result = await apiRequestTool.execute({ method: "GET" }) as any;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("url");
  });

  it("devuelve el error de red como resultado, no como excepción", async () => {
    globalThis.fetch = Object.assign(
      async () => { throw new Error("ECONNREFUSED"); },
      { preconnect: async () => undefined }
    ) as typeof fetch;

    const result = await apiRequestTool.execute({
      method: "GET",
      url: "https://api.example.com/down",
    }) as any;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
