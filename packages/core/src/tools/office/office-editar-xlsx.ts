/**
 * office_editar_xlsx - Modificar celdas de un Excel existente conservando todo lo demás
 *
 * Edita el XML de la hoja directamente: estilos, anchos, formatos, fórmulas de las
 * demás celdas, gráficos, imágenes, tablas y celdas combinadas quedan intactos (una
 * relectura/reescritura con una librería de hojas de cálculo los pierde). Nunca pisa
 * el original: guarda una copia («<nombre>_corregido.xlsx»).
 *
 * @category office
 * @seedId office_editar_xlsx
 * @spanish editar excel, corregir excel, modificar celdas, mejorar hoja de cálculo
 */

import type JSZip from "jszip";
import type { Tool } from "../types";
import { logger } from "../../utils/logger";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveOfficeInput, ARTIFACT_ID_PARAM } from "./resolve-input";
import { resolveInWorkspace, getWorkspace } from "../filesystem/workspace-guard";
import { MAX_OFFICE_ZIP_INPUT_BYTES, assertXmlSize, validateOfficeInput } from "./security-limits";

const log = logger.child("office-editar-xlsx");

interface Cambio {
  hoja: string;
  celda: string;
  valor?: string | number | boolean | null;
  formula?: string;
}

const MAX_CAMBIOS = 2000;

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Caracteres que XML 1.0 no admite ni escapados.
const sinControl = (s: string): string => {
  let salida = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c === 13 || c >= 32) salida += ch;
  }
  return salida;
};

/** "AB" → 28 */
export function columnaANumero(letras: string): number {
  let n = 0;
  for (const c of letras.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

export function parseReferencia(ref: string): { columna: number; fila: number; letras: string } | null {
  const m = /^([A-Za-z]{1,3})([0-9]{1,7})$/.exec(ref);
  if (!m) return null;
  const letras = m[1] ?? "";
  const columna = columnaANumero(letras);
  const fila = Number(m[2]);
  if (columna < 1 || columna > 16384 || fila < 1 || fila > 1048576) return null;
  return { columna, fila, letras: letras.toUpperCase() };
}

const RE_FILA = /<row\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/row>)/g;
const RE_CELDA = /<c\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/c>)/g;

function atributo(etiqueta: string, nombre: string): string | undefined {
  return new RegExp(`\\s${nombre}="([^"]*)"`).exec(etiqueta)?.[1];
}

/** XML de la celda con su estilo conservado. */
export function construirCelda(ref: string, estilo: string | undefined, cambio: Cambio): string {
  const s = estilo !== undefined ? ` s="${estilo}"` : "";
  if (typeof cambio.formula === "string" && cambio.formula.trim()) {
    return `<c r="${ref}"${s}><f>${escapeXml(sinControl(cambio.formula.trim().replace(/^=/, "")))}</f></c>`;
  }
  const v = cambio.valor;
  if (v === null || v === undefined || v === "") return `<c r="${ref}"${s}/>`;
  if (typeof v === "boolean") return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`El valor de ${ref} no es un número finito`);
    return `<c r="${ref}"${s}><v>${v}</v></c>`;
  }
  // Texto como cadena en línea: no toca la tabla de cadenas compartidas del libro.
  // Un texto que empieza por «=» nunca se evalúa como fórmula.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(sinControl(String(v)))}</t></is></c>`;
}

/** Inserta o reemplaza una celda en el XML de la hoja, respetando el orden de filas y columnas. */
export function aplicarCambioEnHoja(xml: string, cambio: Cambio): string {
  const ref = parseReferencia(cambio.celda);
  if (!ref) throw new Error(`referencia inválida: ${cambio.celda}`);
  const celdaRef = `${ref.letras}${ref.fila}`;

  const abre = xml.search(/<sheetData\b/);
  if (abre === -1) throw new Error("formato de hoja no soportado (sin sheetData)");
  const finAbre = xml.indexOf(">", abre);
  const autocerrada = xml[finAbre - 1] === "/";
  const cierra = autocerrada ? -1 : xml.indexOf("</sheetData>", finAbre);
  if (!autocerrada && cierra === -1) throw new Error("formato de hoja no soportado (sheetData sin cierre)");

  const antes = xml.slice(0, abre);
  const apertura = autocerrada ? xml.slice(abre, finAbre - 1) + ">" : xml.slice(abre, finAbre + 1);
  const cuerpo = autocerrada ? "" : xml.slice(finAbre + 1, cierra);
  const despues = autocerrada ? xml.slice(finAbre + 1) : xml.slice(cierra + "</sheetData>".length);

  const filas = [...cuerpo.matchAll(RE_FILA)];
  let nuevoCuerpo: string;
  const idx = filas.findIndex((m) => Number(atributo(m[0], "r")) === ref.fila);

  const reescribirFila = (filaXml: string): string => {
    const autoCerrada = /\/>$/.test(filaXml.slice(0, filaXml.indexOf(">") + 1));
    const cabecera = autoCerrada ? filaXml.slice(0, -2) + ">" : filaXml.slice(0, filaXml.indexOf(">") + 1);
    const interior = autoCerrada ? "" : filaXml.slice(cabecera.length, filaXml.lastIndexOf("</row>"));
    // `spans` es opcional y quedaría desactualizado al añadir una columna.
    const cab = cabecera.replace(/\sspans="[^"]*"/, "");
    const celdas = [...interior.matchAll(RE_CELDA)];
    const pos = celdas.findIndex((c) => (atributo(c[0], "r") ?? "").toUpperCase() === celdaRef);
    if (pos >= 0) {
      const vieja = celdas[pos]!;
      const nueva = construirCelda(celdaRef, atributo(vieja[0], "s"), cambio);
      return `${cab}${interior.slice(0, vieja.index)}${nueva}${interior.slice(vieja.index + vieja[0].length)}</row>`;
    }
    const nueva = construirCelda(celdaRef, undefined, cambio);
    const siguiente = celdas.find((c) => {
      const r = parseReferencia(atributo(c[0], "r") ?? "");
      return r !== null && r.columna > ref.columna;
    });
    const punto = siguiente ? siguiente.index! : interior.length;
    return `${cab}${interior.slice(0, punto)}${nueva}${interior.slice(punto)}</row>`;
  };

  if (idx >= 0) {
    const f = filas[idx]!;
    nuevoCuerpo = cuerpo.slice(0, f.index) + reescribirFila(f[0]) + cuerpo.slice(f.index + f[0].length);
  } else {
    const fila = `<row r="${ref.fila}">${construirCelda(celdaRef, undefined, cambio)}</row>`;
    const siguiente = filas.find((m) => Number(atributo(m[0], "r")) > ref.fila);
    const punto = siguiente ? siguiente.index! : cuerpo.length;
    nuevoCuerpo = cuerpo.slice(0, punto) + fila + cuerpo.slice(punto);
  }
  return ampliarDimension(`${antes}${apertura}${nuevoCuerpo}</sheetData>${despues}`, ref);
}

function letrasDeColumna(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** `<dimension ref>` declara el rango usado: si la celda nueva queda fuera, otros lectores (SheetJS) la ignoran. */
function ampliarDimension(xml: string, ref: { columna: number; fila: number }): string {
  return xml.replace(/<dimension\b([^>]*?)\sref="([^"]*)"([^>]*)\/>/, (todo, antes: string, valor: string, despues: string) => {
    const m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(valor);
    if (!m) return todo;
    const c1 = columnaANumero(m[1] ?? ""), f1 = Number(m[2]);
    const c2 = m[3] ? columnaANumero(m[3]) : c1, f2 = m[4] ? Number(m[4]) : f1;
    const minC = Math.min(c1, ref.columna), minF = Math.min(f1, ref.fila);
    const maxC = Math.max(c2, ref.columna), maxF = Math.max(f2, ref.fila);
    const nuevo = `${letrasDeColumna(minC)}${minF}:${letrasDeColumna(maxC)}${maxF}`;
    return `<dimension${antes} ref="${nuevo}"${despues}/>`;
  });
}

/** Nombre de hoja → ruta de su XML dentro del zip. */
async function mapaDeHojas(zip: JSZip): Promise<Map<string, string>> {
  const libro = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!libro || !rels) throw new Error("El archivo no parece un .xlsx válido (falta workbook.xml)");
  const destinos = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = atributo(m[0], "Id");
    const target = atributo(m[0], "Target");
    if (id && target) destinos.set(id, target);
  }
  const hojas = new Map<string, string>();
  for (const m of libro.matchAll(/<sheet\b[^>]*>/g)) {
    const nombre = atributo(m[0], "name");
    const rid = /\sr:id="([^"]*)"/.exec(m[0])?.[1];
    const target = rid ? destinos.get(rid) : undefined;
    if (!nombre || !target) continue;
    hojas.set(unescapeXml(nombre), target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  return hojas;
}

/**
 * Las fórmulas cambiadas no tienen valor en caché y el calcChain viejo puede
 * referirse a celdas que ya no son fórmulas (Excel lo marcaría como archivo dañado).
 * Se elimina el calcChain y se pide recalcular al abrir.
 */
/** `calcPr` debe ir antes de estos elementos del esquema; Excel marca como dañado un libro con otro orden. */
const DESPUES_DE_CALCPR = [
  "<oleSize", "<customWorkbookViews", "<pivotCaches", "<smartTagPr", "<smartTagTypes",
  "<webPublishing", "<fileRecoveryPr", "<webPublishObjects", "<extLst", "</workbook>",
];

export function insertarCalcPr(xml: string): string {
  const posiciones = DESPUES_DE_CALCPR.map((m) => xml.indexOf(m)).filter((i) => i >= 0);
  const en = posiciones.length ? Math.min(...posiciones) : xml.length;
  return `${xml.slice(0, en)}<calcPr fullCalcOnLoad="1"/>${xml.slice(en)}`;
}

async function prepararRecalculo(zip: JSZip): Promise<void> {
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");
    const tipos = zip.file("[Content_Types].xml");
    if (tipos) {
      zip.file("[Content_Types].xml", (await tipos.async("string")).replace(/<Override\b[^>]*calcChain[^>]*\/>/g, ""));
    }
    const rels = zip.file("xl/_rels/workbook.xml.rels");
    if (rels) {
      zip.file("xl/_rels/workbook.xml.rels", (await rels.async("string")).replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, ""));
    }
  }
  const libro = zip.file("xl/workbook.xml");
  if (libro) {
    let xml = await libro.async("string");
    if (/<calcPr\b/.test(xml)) {
      xml = /<calcPr\b[^>]*\sfullCalcOnLoad=/.test(xml)
        ? xml.replace(/(<calcPr\b[^>]*\sfullCalcOnLoad=")[^"]*"/, '$11"')
        : xml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
    } else {
      xml = insertarCalcPr(xml);
    }
    zip.file("xl/workbook.xml", xml);
  }
}

export const officeEditarXlsxTool: Tool = {
  name: "office_editar_xlsx",
  description:
    "Editar un Excel (.xlsx) existente cambiando solo las celdas indicadas, conservando estilos, gráficos e imágenes. Guarda una copia (no pisa el original) y devuelve su ruta para enviarla con send_file. Spanish: editar excel, corregir excel, modificar celdas, mejorar hoja de cálculo",
  parameters: {
    type: "object",
    properties: {
      ruta: { type: "string", description: "Ruta del .xlsx a editar" },
      artifact_id: ARTIFACT_ID_PARAM,
      cambios: {
        type: "array",
        description: "Celdas a modificar. Usa 'valor' para texto/número o 'formula' (sin el signo =) para una fórmula.",
        items: {
          type: "object",
          properties: {
            hoja: { type: "string", description: "Nombre de la hoja" },
            celda: { type: "string", description: "Referencia, p. ej. B7" },
            valor: { type: "string", description: "Nuevo valor (texto o número; vacío para limpiar la celda)" },
            formula: { type: "string", description: "Fórmula sin '=', p. ej. SUM(B2:B6)" },
          },
          required: ["hoja", "celda"],
        },
      },
      guardar_como: { type: "string", description: "Ruta de salida (default: <nombre>_corregido.xlsx junto al original)" },
    },
    required: ["cambios"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const entrada = await resolveOfficeInput(params);
    if ("error" in entrada) return { ok: false, error: entrada.error };
    const cambios = Array.isArray(params.cambios) ? (params.cambios as Cambio[]) : [];
    if (cambios.length === 0) return { ok: false, error: "Indica al menos un cambio en 'cambios'." };
    if (cambios.length > MAX_CAMBIOS) return { ok: false, error: `Demasiados cambios en una llamada (máximo ${MAX_CAMBIOS}).` };

    try {
      const workspace = getWorkspace(config);
      const origen = path.resolve(entrada.ruta);
      if (!fs.existsSync(origen)) return { ok: false, error: `Archivo no encontrado: ${origen}` };
      if (!/\.xlsx$/i.test(origen)) return { ok: false, error: "Solo se pueden editar archivos .xlsx." };
      const inputError = validateOfficeInput(origen, MAX_OFFICE_ZIP_INPUT_BYTES, "El XLSX");
      if (inputError) return { ok: false, error: inputError };

      const base = path.basename(origen).replace(/\.xlsx$/i, "");
      const pedido = typeof params.guardar_como === "string" && params.guardar_como.trim() ? params.guardar_como.trim() : null;
      const destino = path.resolve(
        pedido
          ? resolveInWorkspace(pedido, workspace)
          : workspace
            ? resolveInWorkspace(`${base}_corregido.xlsx`, workspace)
            : path.join(path.dirname(origen), `${base}_corregido.xlsx`),
      );
      if (destino === origen) return { ok: false, error: "El destino no puede ser el archivo original." };

      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(fs.readFileSync(origen)).catch(() => {
        throw new Error("El archivo no es un .xlsx válido o está dañado.");
      });
      const hojas = await mapaDeHojas(zip);

      const aplicados: string[] = [];
      const omitidos: string[] = [];
      let hayFormulas = false;
      const porHoja = new Map<string, Cambio[]>();
      for (const c of cambios) {
        if (!hojas.has(c.hoja)) { omitidos.push(`${c.hoja}!${c.celda} (no existe la hoja)`); continue; }
        if (!parseReferencia(c.celda ?? "")) { omitidos.push(`${c.hoja}!${c.celda} (referencia inválida)`); continue; }
        if (!(typeof c.formula === "string" && c.formula.trim()) && !("valor" in c)) {
          omitidos.push(`${c.hoja}!${c.celda} (falta 'valor' o 'formula')`);
          continue;
        }
        porHoja.set(c.hoja, [...(porHoja.get(c.hoja) ?? []), c]);
      }

      for (const [nombre, lista] of porHoja) {
        const archivo = hojas.get(nombre)!;
        const entradaZip = zip.file(archivo);
        if (!entradaZip) { for (const c of lista) omitidos.push(`${nombre}!${c.celda} (hoja sin contenido)`); continue; }
        let xml = await entradaZip.async("string");
        assertXmlSize(xml, `La hoja «${nombre}»`);
        for (const c of lista) {
          try {
            xml = aplicarCambioEnHoja(xml, c);
            aplicados.push(`${nombre}!${c.celda.toUpperCase()}`);
            if (typeof c.formula === "string" && c.formula.trim()) hayFormulas = true;
          } catch (err) {
            omitidos.push(`${nombre}!${c.celda} (${(err as Error).message})`);
          }
        }
        zip.file(archivo, xml);
      }
      if (aplicados.length === 0) return { ok: false, error: `No se aplicó ningún cambio. ${omitidos.join("; ")}` };

      // Cualquier cambio puede dejar el calcChain apuntando a una celda que ya no es fórmula.
      await prepararRecalculo(zip);

      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
      log.info(`XLSX editado: ${aplicados.length} celdas → ${destino}`);
      return {
        ok: true,
        ruta: destino,
        celdas_modificadas: aplicados.length,
        ...(omitidos.length ? { omitidos } : {}),
        nota: hayFormulas
          ? "Las fórmulas se calculan al abrir el archivo en Excel. Envíalo con send_file."
          : "Envíalo con send_file.",
      };
    } catch (error) {
      return { ok: false, error: `No se pudo editar el Excel: ${(error as Error).message}` };
    }
  },
};
