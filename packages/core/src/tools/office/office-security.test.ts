import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { officeLeerPdfTool } from "./office-leer-pdf";
import { officeLeerXlsxTool } from "./office-leer-xlsx";
import { cargarXlsx } from "./xlsx-loader";

const tempDir = mkdtempSync(join(tmpdir(), "hive-office-security-"));

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("Office reader security boundaries", () => {
  test("rejects an oversized PDF before parsing it", async () => {
    const file = join(tempDir, "oversized.pdf");
    writeFileSync(file, "");
    truncateSync(file, 25 * 1024 * 1024 + 1);

    const result = await officeLeerPdfTool.execute({ ruta: file }) as {
      ok: boolean;
      error?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("25 MiB");
  });

  test("rejects requests for more than 200 PDF pages", async () => {
    const file = join(tempDir, "many-pages.pdf");
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 201; page++) pdf.addPage([100, 100]);
    writeFileSync(file, await pdf.save());

    const result = await officeLeerPdfTool.execute({
      ruta: file,
      pagina_inicio: 1,
      pagina_fin: 201,
    }) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("200 páginas");
  });

  test("continues to extract text from a small PDF", async () => {
    const file = join(tempDir, "small.pdf");
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 200]);
    page.drawText("Hive security");
    writeFileSync(file, await pdf.save());

    const result = await officeLeerPdfTool.execute({ ruta: file }) as {
      ok: boolean;
      texto?: string;
      paginasLeidas?: number;
    };

    expect(result.ok).toBe(true);
    expect(result.texto).toContain("Hive security");
    expect(result.paginasLeidas).toBe(1);
  });

  test("rejects an oversized XLSX before parsing it", async () => {
    const file = join(tempDir, "oversized.xlsx");
    writeFileSync(file, "");
    truncateSync(file, 15 * 1024 * 1024 + 1);

    const result = await officeLeerXlsxTool.execute({ ruta: file }) as {
      ok: boolean;
      error?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("15 MiB");
  });

  test("rejects XLSX sheets with more than 10,000 returned rows", async () => {
    const file = join(tempDir, "many-rows.xlsx");
    const XLSX = await cargarXlsx();
    const workbook = XLSX.utils.book_new();
    const rows = Array.from({ length: 10_001 }, (_, index) => ({ index }));
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(rows),
      "data",
    );
    writeFileSync(file, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

    const result = await officeLeerXlsxTool.execute({ ruta: file }) as {
      ok: boolean;
      error?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("10.000 filas");
  });

  test("continues to read a small XLSX workbook", async () => {
    const file = join(tempDir, "small.xlsx");
    const XLSX = await cargarXlsx();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([{ name: "Hive" }]),
      "data",
    );
    writeFileSync(file, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

    const result = await officeLeerXlsxTool.execute({ ruta: file }) as {
      ok: boolean;
      totalFilas?: number;
    };

    expect(result.ok).toBe(true);
    expect(result.totalFilas).toBe(1);
  });
});
