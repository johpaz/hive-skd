process.env.HIVE_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { createArtifact } from "../packages/core/src/artifacts/store";
import { addMessage, getHistory } from "../packages/core/src/agent/conversation-store";
import { registerLocalTTS, voiceService } from "../packages/core/src/voice";
import { SEED_DATA } from "../packages/core/src/storage/seed";
import { createAllTools } from "../packages/core/src/tools/index";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

beforeEach(async () => {
  closeHiveDb();
  await ensureHiveDb();
});

describe("archivos visibles", () => {
  test("el artefacto va a la carpeta del usuario con nombre legible y no pisa uno existente", async () => {
    const ws = mkdtempSync(join(tmpdir(), "hive-sdk-ws-"));
    const make = () => createArtifact({
      bytes: JPEG, mimeType: "image/jpeg", kind: "generated_image", userId: "u", expiresAt: null,
      visible: { workspace: ws, folder: "imagenes", label: "¡Una abeja ROBOT!" }, now: Date.UTC(2026, 10, 24, 12, 0),
    });
    const a = await make();
    const b = await make();
    expect(a.path.startsWith(join(ws, "imagenes"))).toBe(true);
    expect(a.path).toMatch(/una-abeja-robot\.jpg$/);
    expect(a.path).not.toBe(b.path);
    expect(readdirSync(join(ws, "imagenes")).length).toBe(2);
    expect(a.expires_at).toBeNull();
  });
});

describe("historial con imágenes", () => {
  test("el modelo ve el artifact_id de lo que ya entregó", async () => {
    const thread = "u/webchat/conv-img";
    await addMessage(thread, "assistant", "Aquí está", { images: [{ artifactId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", mimeType: "image/jpeg" }] });
    const m = (await getHistory(thread)).find((x) => x.role === "assistant")!;
    expect(m.content).toContain("artifact_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(m.content).toContain("no la generes de nuevo");
  });
});

describe("catálogo", () => {
  test("image_generate existe como tool y fila; Kitten sustituye a Piper", () => {
    expect(createAllTools({ tools: {} } as never).some((t) => t.name === "image_generate")).toBe(true);
    expect(SEED_DATA.tools.some((t) => t.id === "image_generate")).toBe(true);
    expect(SEED_DATA.providers.some((p) => p.id === "kitten")).toBe(true);
    expect(SEED_DATA.providers.some((p) => p.id === "piper")).toBe(false);
    expect(SEED_DATA.models.some((m) => m.modelType === "image")).toBe(true);
  });
});

describe("voz local", () => {
  test("sin sintetizador registrado falla con un mensaje claro; con uno, devuelve el audio", async () => {
    registerLocalTTS(undefined);
    await expect(voiceService.speak("Hola", "piper-local")).rejects.toThrow(/registerLocalTTS/);
    registerLocalTTS(async () => new Response(new Uint8Array([1, 2, 3])));
    const out = await voiceService.speak("Hola", "piper-local");
    expect(out.mimeType).toBe("audio/wav");
    registerLocalTTS(undefined);
  });
});
