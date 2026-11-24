/**
 * Adjuntos de punta a punta, sin canales reales: el documento entra como artifact con
 * su extensión, las tools office_* lo abren por artifact_id, send_file lo entrega por
 * el ChannelManager con nombre y tipo correctos, y el bundle del tool worker sigue
 * sin arrastrar HiveDB.
 */
process.env.HIVE_DB_PATH = ":memory:";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PptxGenJS from "../packages/core/src/vendor/pptxgenjs/pptxgen.es.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { closeHiveDb } from "../packages/core/src/storage/hivedb";
import { ensureHiveDb } from "../packages/core/src/storage/bootstrap";
import { col } from "../packages/core/src/storage/hive";
import type { ModelDoc } from "../packages/core/src/storage/collections";
import {
  classifyAttachment, formatAttachmentManifest, ingestDocument,
} from "../packages/core/src/multimodal/attachment-ingest";
import { analyzeImage, setVisionAnalyzerModelId } from "../packages/core/src/multimodal/vision-analyzer";
import { sendFileTool } from "../packages/core/src/tools/core/index";
import { setChannelManager } from "../packages/core/src/gateway/channel-notify";
import { officeLeerXlsxTool } from "../packages/core/src/tools/office/office-leer-xlsx";
import { officeLeerPptxTool } from "../packages/core/src/tools/office/office-leer-pptx";
import { cargarXlsx } from "../packages/core/src/tools/office/xlsx-loader";
import { readOutboundDocument } from "../packages/core/src/channels/base";

const previousHome = process.env.HIVE_HOME;
let home = "";

beforeEach(async () => {
  closeHiveDb();
  home = mkdtempSync(join(tmpdir(), "hive-sdk-attach-"));
  process.env.HIVE_HOME = home;
  await ensureHiveDb();
});
afterEach(() => {
  closeHiveDb();
  setChannelManager(null);
  if (previousHome === undefined) delete process.env.HIVE_HOME; else process.env.HIVE_HOME = previousHome;
});

async function xlsxBytes(): Promise<Buffer> {
  const XLSX = await cargarXlsx();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["producto", "precio"], ["café", 12000]]), "Ventas");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

describe("clasificación y manifiesto", () => {
  test("la extensión manda sobre el mime", () => {
    expect(classifyAttachment("balance.xlsx", "application/pdf").kind).toBe("xlsx");
    expect(classifyAttachment("notas.md", "").kind).toBe("text");
    expect(classifyAttachment("adjunto", "application/x-foo").kind).toBe("other");
  });

  test("el manifiesto trae ruta, artifact_id, lector y vista previa", () => {
    const m = formatAttachmentManifest({
      fileName: "a.xlsx", mimeType: "x", size: 2048, kind: "xlsx",
      artifactId: "id-1", path: "/tmp/a.xlsx", preview: "# Hoja", scanned: false,
    });
    expect(m).toContain("Ruta: /tmp/a.xlsx");
    expect(m).toContain("artifact_id: id-1");
    expect(m).toContain("office_leer_xlsx");
  });
});

describe("ingesta de documentos", () => {
  test("un xlsx conserva la extensión, trae vista previa y se lee por artifact_id", async () => {
    const att = await ingestDocument({ buffer: await xlsxBytes(), fileName: "ventas.xlsx", mimeType: "application/pdf", userId: "u1" });
    expect(att.kind).toBe("xlsx");
    expect(att.path.endsWith(".xlsx")).toBe(true);
    expect(att.preview).toContain("café");
    const r = await officeLeerXlsxTool.execute({ artifact_id: att.artifactId }) as any;
    expect(r.ok).toBe(true);
  });

  test("un PDF con texto trae páginas y vista previa; uno escaneado se marca", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 300]).drawText("Factura 1024 total 50000", { x: 20, y: 250, size: 12, font });
    const att = await ingestDocument({ buffer: Buffer.from(await doc.save()), fileName: "factura.pdf", userId: "u1" });
    expect(att.pages).toBe(1);
    expect(att.preview).toContain("Factura 1024");

    const vacio = await PDFDocument.create();
    vacio.addPage([300, 300]);
    const esc = await ingestDocument({ buffer: Buffer.from(await vacio.save()), fileName: "scan.pdf", userId: "u1" });
    expect(esc.scanned).toBe(true);
    expect(formatAttachmentManifest(esc)).toContain("no se puede leer sin OCR");
  });

  test("un pptx trae diapositivas y se lee por artifact_id", async () => {
    const p = new PptxGenJS();
    p.addSlide().addText("Resultados Q3", { x: 1, y: 1, w: 5, h: 1 });
    const att = await ingestDocument({ buffer: Buffer.from(await (p as unknown as { write(o: { outputType: string }): Promise<ArrayBuffer> }).write({ outputType: "nodebuffer" })), fileName: "q3.pptx", userId: "u1" });
    expect(att.pages).toBe(1);
    expect(att.preview).toContain("Resultados Q3");
    const r = await officeLeerPptxTool.execute({ artifact_id: att.artifactId }) as any;
    expect(r.diapositivas[0].texto).toContain("Resultados Q3");
  });

  test("un adjunto vacío se rechaza con un mensaje claro", async () => {
    await expect(ingestDocument({ buffer: Buffer.alloc(0), fileName: "x.pdf", userId: "u1" })).rejects.toThrow("vacío");
  });
});

describe("send_file", () => {
  test("entrega el archivo por el ChannelManager con nombre, tipo y leyenda", async () => {
    const enviados: any[] = [];
    setChannelManager({ send: async (channel, sessionId, message) => { enviados.push({ channel, sessionId, message }); } });
    const ruta = join(home, "informe.csv");
    writeFileSync(ruta, "a,b\n1,2\n");
    const r = await sendFileTool.execute({ ruta, mensaje: "listo" }, { configurable: { channel: "telegram", user_id: "u1", thread_id: "u1/telegram/555" } }) as any;
    expect(r.ok).toBe(true);
    expect(enviados[0].channel).toBe("telegram");
    expect(enviados[0].sessionId).toBe("555");
    expect(enviados[0].message.document).toMatchObject({ filename: "informe.csv", mimeType: "text/csv", caption: "listo" });
    // El canal puede leer el archivo por su artifact_id.
    const doc = await readOutboundDocument(enviados[0].message.document);
    expect(doc?.bytes.toString()).toBe("a,b\n1,2\n");
  });

  test("respeta el workspace del agente", async () => {
    const r = await sendFileTool.execute({ ruta: "/etc/hostname" }, { configurable: { channel: "webchat", user_id: "u1", workspace: home } }) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside workspace");
  });

  test("sin ChannelManager conectado devuelve el motivo, no lo pierde en silencio", async () => {
    const ruta = join(home, "a.txt");
    writeFileSync(ruta, "x");
    const r = await sendFileTool.execute({ ruta }, { configurable: { channel: "telegram", user_id: "u1" } }) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("setChannelManager");
  });
});

describe("modelo analizador de imágenes", () => {
  async function addModel(id: string, caps: string[]) {
    await (await col<ModelDoc>("models")).put(id, {
      id, provider_id: "openrouter", name: id, model_type: "llm", context_window: 1000,
      capabilities: JSON.stringify(caps), enabled: true, active: true,
    } as ModelDoc);
  }
  const png = { type: "base64" as const, data: "aGk=", mimeType: "image/png" };

  test("sin modelo devuelve null; solo acepta modelos con visión", async () => {
    expect(await analyzeImage(png)).toBeNull();
    await addModel("solo-texto", ["chat"]);
    await expect(setVisionAnalyzerModelId("solo-texto")).rejects.toThrow("visión");
  });

  test("con modelo manda la imagen sin recortar el prefijo del proveedor", async () => {
    await addModel("openrouter/vendor/vl-x", ["chat", "vision"]);
    await setVisionAnalyzerModelId("openrouter/vendor/vl-x");
    const llamadas: any[] = [];
    const real = await import("../packages/core/src/agent/llm-client");
    const llm = {
      LLM_ERROR_PREFIX: real.LLM_ERROR_PREFIX,
      resolveProviderConfig: (async () => ({ provider: "openrouter", model: "x", apiKey: "k" })) as unknown as typeof real.resolveProviderConfig,
      callLLM: (async (o: any) => { llamadas.push(o); return { content: "Un recibo por $10", stop_reason: "stop" }; }) as unknown as typeof real.callLLM,
    };
    expect(await analyzeImage(png, llm)).toBe("Un recibo por $10");
    expect(llamadas[0].model).toBe("openrouter/vendor/vl-x");
    expect(llamadas[0].messages[0].content[1].image_url.url).toStartWith("data:image/png;base64,");
  });
});

describe("bundle del tool worker", () => {
  test("no arrastra dependencias nativas de HiveDB", async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "packages", "core", "src", "tool-runtime", "tool-worker.ts")],
      target: "bun",
    });
    expect(result.success).toBe(true);
    const fuente = await result.outputs[0]!.text();
    for (const prohibido of ["../native.cjs", "@johpaz/hive-db", "JsHiveDb"]) {
      expect(fuente.includes(prohibido), `el worker contiene ${prohibido}`).toBe(false);
    }
  }, 60_000);
});
