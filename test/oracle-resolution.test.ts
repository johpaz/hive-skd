/**
 * Qué oráculo se consulta: Kev (laboratorio HiveAgents) si su llave está
 * configurada, si no Jev (OpenRouter), si no ninguno. Con inquilino, solo sus
 * propios secretos: nunca las variables de entorno de la plataforma.
 */

process.env.HIVE_DB_PATH = ":memory:";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { col } from "../packages/core/src/storage/hive";
import { deleteProviderSecrets, resetKeychainProbe, storeProviderApiKey } from "../packages/core/src/storage/crypto";
import { runInTenant } from "../packages/core/src/storage/tenant";
import { askJev, resetJevStatus, resolveOracle, resolveVerify } from "../packages/core/src/agent/jev-decisions";
import type { ProviderDoc } from "../packages/core/src/storage/collections";

const TENANT = "t_cccccccc33333333";
const realSecrets = (Bun as unknown as { secrets: unknown }).secrets;

beforeAll(() => {
  // El keychain del sistema no se aísla con ":memory:": se deja siempre no disponible.
  (Bun as unknown as { secrets: unknown }).secrets = {
    get: async () => { throw new Error("keychain unavailable"); },
    set: async () => { throw new Error("keychain unavailable"); },
    delete: async () => { throw new Error("keychain unavailable"); },
  };
  resetKeychainProbe();
});
afterAll(() => {
  (Bun as unknown as { secrets: unknown }).secrets = realSecrets;
  resetKeychainProbe();
});

async function enableOpenRouter(key = "or-key") {
  const providers = await col<ProviderDoc>("providers");
  const row = await providers.get("openrouter");
  await providers.put("openrouter", { ...row!.doc, enabled: true, active: true }, { expectedVersion: row!.version });
  await storeProviderApiKey("openrouter", key);
}

beforeEach(async () => {
  closeHiveDb();
  await ensureHiveDb();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.HIVEAGENTS_API_KEY;
  // Los secretos no viven en la HiveDB en memoria: se limpian entre pruebas.
  await deleteProviderSecrets("hiveagents");
  await deleteProviderSecrets("openrouter");
  await runInTenant(TENANT, () => deleteProviderSecrets("hiveagents"));
  resetJevStatus();
});
afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.HIVEAGENTS_API_KEY;
});

describe("resolveOracle", () => {
  test("sin ninguna llave no hay oráculo", async () => {
    expect(await resolveOracle()).toBeNull();
    expect(await resolveOracle({ provider: "auto" })).toBeNull();
  });

  test("solo OpenRouter configurado: Jev", async () => {
    await enableOpenRouter();
    expect(await resolveOracle()).toMatchObject({ kind: "jev", apiKey: "or-key", model: "typesafe/jev-1.13", selfHosted: false });
  });

  test("OpenRouter con la fila apagada no cuenta", async () => {
    await storeProviderApiKey("openrouter", "or-key");
    expect(await resolveOracle()).toBeNull();
  });

  test("llave de HiveAgents en el secret store: Kev, y gana a OpenRouter", async () => {
    await enableOpenRouter();
    await storeProviderApiKey("hiveagents", "lab-key");
    expect(await resolveOracle()).toMatchObject({
      kind: "kev", apiKey: "lab-key", endpoint: "https://llm.hiveagents.io/v1/systemone", model: "kev", selfHosted: true,
    });
  });

  test("HIVEAGENTS_API_KEY del entorno también cuenta (fuera de inquilino)", async () => {
    process.env.HIVEAGENTS_API_KEY = "env-lab-key";
    expect(await resolveOracle()).toMatchObject({ kind: "kev", apiKey: "env-lab-key" });
  });

  test("provider explícito no cae en el otro", async () => {
    await enableOpenRouter();
    await storeProviderApiKey("hiveagents", "lab-key");
    expect(await resolveOracle({ provider: "openrouter" })).toMatchObject({ kind: "jev", apiKey: "or-key" });
    await deleteProviderSecrets("hiveagents");
    expect(await resolveOracle({ provider: "hiveagents" })).toBeNull();
  });

  test("false lo apaga aunque haya llaves", async () => {
    await enableOpenRouter();
    process.env.HIVEAGENTS_API_KEY = "env-lab-key";
    expect(await resolveOracle(false)).toBeNull();
  });

  test("la forma anterior sigue igual: { apiKey } es Jev; { apiKey, endpoint } es un servidor System One", async () => {
    expect(await resolveOracle({ apiKey: "k" })).toMatchObject({ kind: "jev", apiKey: "k", selfHosted: false });
    expect(await resolveOracle({ apiKey: "k", endpoint: "http://localhost:8080/v1/systemone", model: "kev" }))
      .toMatchObject({ kind: "kev", endpoint: "http://localhost:8080/v1/systemone", model: "kev", selfHosted: true });
  });

  test("con inquilino ignora las variables de la plataforma y usa sus secretos", async () => {
    process.env.HIVEAGENTS_API_KEY = "platform-lab";
    process.env.OPENROUTER_API_KEY = "platform-or";
    await runInTenant(TENANT, async () => {
      expect(await resolveOracle()).toBeNull();
      await storeProviderApiKey("hiveagents", "tenant-lab");
      expect(await resolveOracle()).toMatchObject({ kind: "kev", apiKey: "tenant-lab" });
    });
    // El inquilino no dejó nada en el espacio local.
    expect(await resolveOracle()).toMatchObject({ apiKey: "platform-lab" });
  });
});

describe("resolveVerify", () => {
  test("por defecto verifica la respuesta, no el resultado de las tools, con hasta 2 correcciones", () => {
    expect(resolveVerify()).toEqual({ tools: false, answer: true, maxCorrections: 2 });
    expect(resolveVerify(false)).toEqual({ tools: false, answer: true, maxCorrections: 2 });
  });
  test("se puede encender el resultado de las tools, apagar la respuesta y cambiar el tope", () => {
    expect(resolveVerify({ apiKey: "k", verify: { tools: true, answer: false, maxCorrections: 0 } })).toEqual({ tools: true, answer: false, maxCorrections: 0 });
    expect(resolveVerify({ apiKey: "k", verify: { maxCorrections: -1 } }).maxCorrections).toBe(2);
  });
});

describe("askJev con Kev", () => {
  test("habla con el endpoint del laboratorio, con el modelo kev y sin costo por decisión", async () => {
    process.env.HIVEAGENTS_API_KEY = "env-lab-key";
    let seen: { url: string; auth: string; model: string } | null = null;
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen = { url, auth: (init!.headers as Record<string, string>).Authorization!, model: JSON.parse(String(init?.body)).model };
      return Response.json({ answers: { q: { choice: "a", probabilities: { a: 0.9, b: 0.1 } } } });
    }) as unknown as typeof fetch;
    const result = await askJev("s", { q: { type: "choice", instructions: "?", criteria: { a: "A", b: "B" } } }, { fetcher });
    expect(seen).toEqual({ url: "https://llm.hiveagents.io/v1/systemone", auth: "Bearer env-lab-key", model: "kev" });
    expect(result?.answers.q).toMatchObject({ type: "choice", choice: "a", confidence: 0.9 });
    expect(result?.costUsd).toBe(0);
  });
});
