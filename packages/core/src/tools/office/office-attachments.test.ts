import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extraerTextoPdf, textoDePagina } from "./pdf-text";
import { officeLeerPdfTool } from "./office-leer-pdf";
import { officeLeerPptxTool } from "./office-leer-pptx";
import { officeEditarPptxTool } from "./office-editar-pptx";
import { officeEditarDocxTool, reemplazarEnParrafo } from "./office-editar-docx";
import { officeEditarXlsxTool, aplicarCambioEnHoja, insertarCalcPr, parseReferencia } from "./office-editar-xlsx";
import { buscarArtifactEnDisco } from "./resolve-input";

const dir = mkdtempSync(join(tmpdir(), "hive-office-edit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function pdf(paginas: Array<Array<{ x: number; y: number; t: string }>>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const items of paginas) {
    const page = doc.addPage([400, 400]);
    for (const it of items) page.drawText(it.t, { x: it.x, y: it.y, size: 12, font });
  }
  return doc.save();
}

describe("lectura de PDF sin modelos", () => {
  test("separa renglones y columnas por posición", () => {
    const it = (str: string, x: number, y: number) => ({ str, width: str.length * 6, transform: [12, 0, 0, 12, x, y] });
    const t = textoDePagina([it("Producto", 10, 300), it("Precio", 200, 300), it("Café", 10, 285), it("12000", 200, 285), it("Fin", 10, 200)]);
    expect(t.split("\n")[0]).toMatch(/Producto {2}Precio/);
    expect(t).toContain("\n\nFin");
  });

  test("lee páginas con cabecera, respeta el tope y dice por dónde seguir", async () => {
    const pag = (n: number) => [{ x: 20, y: 350, t: `Pagina ${n} ${"x".repeat(60)}` }];
    const r = await extraerTextoPdf(await pdf([pag(1), pag(2), pag(3)]), { maxCaracteres: 200 });
    expect(r.texto).toContain("--- Página 1 ---");
    expect(r.truncado).toBe(true);
    expect(r.siguientePagina).toBe(3);
  });

  test("un PDF sin capa de texto se marca como escaneado", async () => {
    const r = await extraerTextoPdf(await pdf([[], []]));
    expect(r.sinTexto).toBe(true);
  });

  test("la tool no repite el contenido y conserva la validación de rango del SDK", async () => {
    const ruta = join(dir, "dos.pdf");
    writeFileSync(ruta, await pdf([[{ x: 20, y: 350, t: "Uno" }], [{ x: 20, y: 350, t: "Dos" }]]));
    const r = await officeLeerPdfTool.execute({ ruta, pagina_inicio: 2 }) as any;
    expect(r.ok).toBe(true);
    expect(r.texto).toContain("Dos");
    expect(r.texto).not.toContain("Uno");
    expect(r.paginas).toBeUndefined();
    const mal = await officeLeerPdfTool.execute({ ruta, pagina_inicio: 5 }) as any;
    expect(mal.ok).toBe(false);
    expect(mal.error).toContain("entre 1 y 2");
  });
});

async function crearPptx(nombre = "demo.pptx"): Promise<string> {
  const p = new PptxGenJS();
  const s1 = p.addSlide();
  s1.addText("Plan 2027", { x: 1, y: 1, w: 6, h: 1 });
  s1.addText("Ventas crecen 20%", { x: 1, y: 2.5, w: 6, h: 1 });
  s1.addNotes("Mencionar el contrato con Acme");
  p.addSlide().addText("Riesgos", { x: 1, y: 1, w: 6, h: 1 });
  const ruta = join(dir, nombre);
  writeFileSync(ruta, Buffer.from(await p.write({ outputType: "nodebuffer" }) as ArrayBuffer));
  return ruta;
}

describe("PowerPoint", () => {
  test("lee texto y notas, en el orden real de la presentación", async () => {
    const ruta = await crearPptx();
    const r = await officeLeerPptxTool.execute({ ruta }) as any;
    expect(r.diapositivas[0].texto).toContain("Plan 2027");
    expect(r.diapositivas[0].notas).toContain("Acme");
    expect(r.diapositivas[0].fragmentos).toBeUndefined();

    const zip = await JSZip.loadAsync(readFileSync(ruta));
    const pres = await zip.file("ppt/presentation.xml")!.async("string");
    const ids = [...pres.matchAll(/<p:sldId [^>]*\/>/g)].map((m) => m[0]);
    zip.file("ppt/presentation.xml", pres.replace(ids[0] + ids[1], ids[1] + ids[0]));
    const invertida = join(dir, "invertida.pptx");
    writeFileSync(invertida, await zip.generateAsync({ type: "nodebuffer" }));
    const inv = await officeLeerPptxTool.execute({ ruta: invertida }) as any;
    expect(inv.diapositivas[0].texto).toContain("Riesgos");
  });

  test("edita una copia, solo la diapositiva pedida, sin tocar el original", async () => {
    const ruta = await crearPptx("editar.pptx");
    const antes = readFileSync(ruta);
    const r = await officeEditarPptxTool.execute({ ruta, reemplazos: [{ buscar: "Ventas", reemplazar: "Ingresos", diapositiva: 1 }] }) as any;
    expect(r.ok).toBe(true);
    expect(readFileSync(ruta).equals(antes)).toBe(true);
    const leido = await officeLeerPptxTool.execute({ ruta: r.ruta }) as any;
    expect(leido.diapositivas[0].texto).toContain("Ingresos crecen 20%");
  });

  test("respeta el workspace del agente", async () => {
    const ruta = await crearPptx("ws.pptx");
    const r = await officeEditarPptxTool.execute(
      { ruta, reemplazos: [{ buscar: "Plan", reemplazar: "Meta" }], guardar_como: "/tmp/fuera.pptx" },
      { configurable: { workspace: dir } },
    ) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside workspace");
  });
});

describe("Word", () => {
  test("une fragmentos de texto y conserva el formato del primero", () => {
    const p = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hola Mun</w:t></w:r><w:r><w:t>do cruel</w:t></w:r></w:p>';
    const r = reemplazarEnParrafo(p, "Mundo", "Colombia");
    expect(r.cuenta).toBe(1);
    expect(r.xml).toContain("<w:b/>");
    expect(r.xml).toContain("Hola Colombia");
  });

  test("añade párrafos antes de sectPr y no pisa el original", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Estimado cliente</w:t></w:r></w:p><w:sectPr/></w:body></w:document>");
    const ruta = join(dir, "carta.docx");
    writeFileSync(ruta, await zip.generateAsync({ type: "nodebuffer" }));
    const antes = readFileSync(ruta);
    const r = await officeEditarDocxTool.execute({ ruta, reemplazos: [{ buscar: "cliente", reemplazar: "señor Pérez" }], anadir_parrafos: ["Atentamente"] }) as any;
    expect(r.ok).toBe(true);
    expect(readFileSync(ruta).equals(antes)).toBe(true);
    const out = await (await JSZip.loadAsync(readFileSync(r.ruta))).file("word/document.xml")!.async("string");
    expect(out).toContain("Estimado señor Pérez");
    expect(out.indexOf("Atentamente")).toBeLessThan(out.indexOf("<w:sectPr"));
  });
});

const HOJA = (filas: string) =>
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C2"/><sheetData>${filas}</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`;

describe("Excel por XML", () => {
  test("parsea referencias", () => {
    expect(parseReferencia("b7")).toEqual({ columna: 2, fila: 7, letras: "B" });
    expect(parseReferencia("AB10")?.columna).toBe(28);
    expect(parseReferencia("A0")).toBeNull();
    expect(parseReferencia("1A")).toBeNull();
    expect(parseReferencia("XFE1")).toBeNull();
  });

  test("reemplaza conservando el estilo, e inserta celdas y filas en orden", () => {
    const base = HOJA('<row r="1" spans="1:3"><c r="A1" s="3" t="s"><v>0</v></c><c r="C1"><v>5</v></c></row><row r="3"><c r="A3"><v>1</v></c></row>');
    let xml = aplicarCambioEnHoja(base, { hoja: "H", celda: "A1", valor: "Nuevo" });
    expect(xml).toContain('<c r="A1" s="3" t="inlineStr"><is><t xml:space="preserve">Nuevo</t></is></c>');
    xml = aplicarCambioEnHoja(xml, { hoja: "H", celda: "B1", valor: 7 });
    expect(xml.indexOf('r="A1"')).toBeLessThan(xml.indexOf('r="B1"'));
    expect(xml.indexOf('r="B1"')).toBeLessThan(xml.indexOf('r="C1"'));
    expect(xml).not.toContain('spans="1:3"'); // el atributo opcional ya no sería correcto
    xml = aplicarCambioEnHoja(xml, { hoja: "H", celda: "A2", valor: true });
    expect(xml.indexOf('<row r="1"')).toBeLessThan(xml.indexOf('<row r="2"'));
    expect(xml.indexOf('<row r="2"')).toBeLessThan(xml.indexOf('<row r="3"'));
    expect(xml).toContain('<c r="A2" t="b"><v>1</v></c>');
    expect(xml).toContain('<mergeCells'); // lo que no se toca queda intacto
    expect(aplicarCambioEnHoja(base, { hoja: "H", celda: "E9", valor: 1 })).toContain('<dimension ref="A1:E9"/>');
  });

  test("calcPr se inserta en el orden del esquema", () => {
    const conExt = insertarCalcPr("<workbook><sheets/><extLst/></workbook>");
    expect(conExt.indexOf("<calcPr")).toBeLessThan(conExt.indexOf("<extLst"));
    expect(insertarCalcPr("<workbook><sheets/></workbook>")).toBe('<workbook><sheets/><calcPr fullCalcOnLoad="1"/></workbook>');
  });

  test("escapa XML, no evalúa «=» como fórmula y soporta sheetData vacío", () => {
    const vacia = '<worksheet><sheetData/></worksheet>';
    const xml = aplicarCambioEnHoja(vacia, { hoja: "H", celda: "A1", valor: "=1+1 <b> & más" });
    expect(xml).toContain("=1+1 &lt;b&gt; &amp; más");
    expect(xml).not.toContain("<f>");
    const f = aplicarCambioEnHoja(vacia, { hoja: "H", celda: "A1", formula: "=SUM(B1:B2)" });
    expect(f).toContain("<f>SUM(B1:B2)</f>");
  });

  async function libro(conCalcChain: boolean): Promise<string> {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<Types><Override PartName="/xl/calcChain.xml" ContentType="x"/></Types>');
    zip.file("xl/workbook.xml", '<workbook xmlns:r="r"><sheets><sheet name="Ventas &amp; Co" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Target="calcChain.xml"/></Relationships>');
    zip.file("xl/worksheets/sheet1.xml", HOJA('<row r="1"><c r="A1" s="2"><v>1</v></c></row>'));
    zip.file("xl/styles.xml", "<styleSheet/>");
    zip.file("xl/charts/chart1.xml", "<chart/>");
    if (conCalcChain) zip.file("xl/calcChain.xml", "<calcChain/>");
    const ruta = join(dir, `libro-${conCalcChain}.xlsx`);
    writeFileSync(ruta, await zip.generateAsync({ type: "nodebuffer" }));
    return ruta;
  }

  test("edita una copia, conserva gráficos y estilos, y retira el calcChain", async () => {
    const ruta = await libro(true);
    const antes = readFileSync(ruta);
    const r = await officeEditarXlsxTool.execute({
      ruta,
      cambios: [{ hoja: "Ventas & Co", celda: "A1", valor: 99 }, { hoja: "Nada", celda: "A1", valor: 1 }, { hoja: "Ventas & Co", celda: "Z", valor: 1 }],
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.celdas_modificadas).toBe(1);
    expect(r.omitidos.length).toBe(2);
    expect(readFileSync(ruta).equals(antes)).toBe(true);
    const out = await JSZip.loadAsync(readFileSync(r.ruta));
    expect(await out.file("xl/worksheets/sheet1.xml")!.async("string")).toContain('<c r="A1" s="2"><v>99</v></c>');
    expect(out.file("xl/charts/chart1.xml")).not.toBeNull();
    expect(out.file("xl/calcChain.xml")).toBeNull();
    expect(await out.file("[Content_Types].xml")!.async("string")).not.toContain("calcChain");
    expect(await out.file("xl/_rels/workbook.xml.rels")!.async("string")).not.toContain("calcChain");
    expect(await out.file("xl/workbook.xml")!.async("string")).toContain('fullCalcOnLoad="1"');
  });

  test("el resultado se abre con la librería de hojas de cálculo del SDK", async () => {
    const { cargarXlsx } = await import("./xlsx-loader");
    const XLSX = await cargarXlsx();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["producto", "precio"], ["café", 12000]]), "Ventas");
    const ruta = join(dir, "real.xlsx");
    writeFileSync(ruta, Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })));
    const r = await officeEditarXlsxTool.execute({ ruta, cambios: [{ hoja: "Ventas", celda: "B2", valor: 99 }, { hoja: "Ventas", celda: "C2", formula: "B2*2" }, { hoja: "Ventas", celda: "A3", valor: "té" }] }) as any;
    expect(r.ok).toBe(true);
    // sheetStubs: una fórmula sin valor en caché (aún no calculada) solo aparece como celda vacía con su fórmula.
    const leido = XLSX.read(readFileSync(r.ruta), { type: "buffer", sheetStubs: true });
    const hoja = leido.Sheets["Ventas"];
    expect(hoja["B2"].v).toBe(99);
    expect(hoja["A3"].v).toBe("té");
    expect(hoja["A2"].v).toBe("café"); // la celda no tocada sigue igual
    expect(hoja["C2"].f).toBe("B2*2");
  });
});

describe("artifact_id sin base de datos", () => {
  const id = "0a1b2c3d-1111-4222-8333-444455556666";
  test("encuentra el archivo por id y rechaza ids que no son UUID", () => {
    const raiz = mkdtempSync(join(tmpdir(), "art-"));
    mkdirSync(join(raiz, "2026-11-20"), { recursive: true });
    writeFileSync(join(raiz, "2026-11-20", `${id}.xlsx`), "x");
    expect(buscarArtifactEnDisco(id, raiz)).toBe(join(raiz, "2026-11-20", `${id}.xlsx`));
    expect(buscarArtifactEnDisco("../../etc/passwd", raiz)).toBeNull();
  });
});
