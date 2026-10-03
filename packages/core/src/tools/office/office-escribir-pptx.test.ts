import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { officeEscribirPptxTool } from "./office-escribir-pptx";

const tempDir = mkdtempSync(join(tmpdir(), "hive-pptx-writer-"));

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("office_escribir_pptx", () => {
  test("genera OOXML con portada, contenido, viñetas y notas", async () => {
    const file = join(tempDir, "presentacion.pptx");
    const result = await officeEscribirPptxTool.execute({
      ruta: file,
      titulo_presentacion: "Seguridad Hive",
      diapositivas: [
        { titulo: "Resumen", contenido: "Contenido libre" },
        {
          titulo: "Controles",
          puntos: ["Límite de tamaño", "Tiempo máximo"],
          notas: "Nota privada del presentador",
        },
      ],
    }) as {
      ok: boolean;
      totalDiapositivas?: number;
      bytesEscritos?: number;
      error?: string;
    };

    expect(result).toMatchObject({ ok: true, totalDiapositivas: 3 });
    expect(result.bytesEscritos).toBeGreaterThan(0);

    const archive = await JSZip.loadAsync(readFileSync(file));
    expect(archive.file("[Content_Types].xml")).not.toBeNull();
    expect(archive.file("ppt/presentation.xml")).not.toBeNull();
    expect(archive.file("ppt/slides/slide1.xml")).not.toBeNull();
    expect(archive.file("ppt/slides/slide2.xml")).not.toBeNull();
    expect(archive.file("ppt/slides/slide3.xml")).not.toBeNull();

    const slide2 = await archive.file("ppt/slides/slide2.xml")!.async("text");
    const slide3 = await archive.file("ppt/slides/slide3.xml")!.async("text");
    expect(slide2).toContain("Resumen");
    expect(slide2).toContain("Contenido libre");
    expect(slide3).toContain("Límite de tamaño");
    expect(slide3).toContain("Tiempo máximo");

    const noteParts = Object.keys(archive.files).filter((name) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)
    );
    const notes = await Promise.all(
      noteParts.map((name) => archive.file(name)!.async("text")),
    );
    expect(notes.some((xml) => xml.includes("Nota privada del presentador"))).toBe(true);
  });
});
