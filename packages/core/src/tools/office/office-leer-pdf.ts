/**
 * office_leer_pdf - Leer contenido de un archivo PDF
 *
 * @category office
 * @seedId office_leer_pdf
 * @spanish leer pdf, abrir pdf, extraer texto de pdf, contenido pdf
 */

import type { Tool } from "../types";
import { logger } from "../../utils/logger";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBeforeDeadline,
  MAX_PDF_INPUT_BYTES,
  MAX_PDF_PAGES_PER_REQUEST,
  OFFICE_PROCESSING_TIMEOUT_MS,
  validateOfficeInput,
} from "./security-limits";

const log = logger.child("office-leer-pdf");

export const officeLeerPdfTool: Tool = {
  name: "office_leer_pdf",
  description:
    "Leer contenido de un archivo PDF y retornar texto plano con metadata. Spanish: leer pdf, abrir pdf, extraer texto de pdf, pdf a texto",
  parameters: {
    type: "object",
    properties: {
      ruta: {
        type: "string",
        description: "Ruta absoluta o relativa al archivo PDF",
      },
      pagina_inicio: {
        type: "number",
        description: "Página desde la que empezar (1-indexed, default: 1)",
      },
      pagina_fin: {
        type: "number",
        description: "Última página a leer (default: todas las páginas)",
      },
    },
    required: ["ruta"],
  },
  execute: async (params: Record<string, unknown>) => {
    const ruta = params.ruta as string;
    const paginaInicio = Math.max(1, (params.pagina_inicio as number) ?? 1);
    const paginaFin = params.pagina_fin as number | undefined;

    log.debug(`Leyendo PDF: ${ruta}`);

    try {
      const rutaAbsoluta = path.resolve(ruta);
      if (!fs.existsSync(rutaAbsoluta)) {
        return { ok: false, error: `Archivo no encontrado: ${rutaAbsoluta}` };
      }

      const inputError = validateOfficeInput(
        rutaAbsoluta,
        MAX_PDF_INPUT_BYTES,
        "El PDF",
      );
      if (inputError) return { ok: false, error: inputError };

      const buffer = fs.readFileSync(rutaAbsoluta);
      const uint8Array = new Uint8Array(buffer);

      // La build legacy conserva compatibilidad con Bun. PDF.js configura su
      // propio fake worker en Node/Bun; borrar workerSrc rompe PDF.js 6+.
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as any).catch(
        () => import("pdfjs-dist" as any)
      );

      const lib = pdfjsLib.default ?? pdfjsLib;
      const pdfjsPackageUrl = import.meta.resolve("pdfjs-dist/package.json");
      const loadingTask = lib.getDocument({
        data: uint8Array,
        enableScripting: false,
        isEvalSupported: false,
        // Bun's process.getBuiltinModule("fs/promises") expects a filesystem
        // path here; a file:// URL string is not accepted.
        standardFontDataUrl: fileURLToPath(
          new URL("./standard_fonts/", pdfjsPackageUrl),
        ),
      });

      try {
        const deadline = Date.now() + OFFICE_PROCESSING_TIMEOUT_MS;
        const doc = await loadingTask.promise;
        const totalPaginas = doc.numPages;

        // Metadata
        let titulo: string | undefined;
        try {
          const meta = await doc.getMetadata();
          titulo = (meta?.info as any)?.Title ?? undefined;
        } catch {
          // metadata opcional
        }

        const inicio = paginaInicio;
        if (!Number.isInteger(inicio) || inicio > totalPaginas) {
          return {
            ok: false,
            error: `La página inicial debe estar entre 1 y ${totalPaginas}`,
          };
        }
        if (paginaFin !== undefined && (!Number.isInteger(paginaFin) || paginaFin < inicio)) {
          return {
            ok: false,
            error: "La página final debe ser un entero mayor o igual a la página inicial",
          };
        }

        const fin = paginaFin ? Math.min(paginaFin, totalPaginas) : totalPaginas;
        const paginasSolicitadas = fin - inicio + 1;
        if (paginasSolicitadas > MAX_PDF_PAGES_PER_REQUEST) {
          return {
            ok: false,
            error: `Se pueden leer como máximo ${MAX_PDF_PAGES_PER_REQUEST} páginas por solicitud`,
          };
        }

        const textosPorPagina: Array<{ pagina: number; texto: string }> = [];

        for (let i = inicio; i <= fin; i++) {
          assertBeforeDeadline(deadline, "La lectura del PDF");
          const pagina = await doc.getPage(i);
          const contenido = await pagina.getTextContent();
          const texto = (contenido.items as any[])
            .map((item: any) => item.str ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          textosPorPagina.push({ pagina: i, texto });
        }

        const textoCompleto = textosPorPagina.map((p) => p.texto).join("\n\n");

        log.info(`PDF leído: ${totalPaginas} páginas, ${textoCompleto.length} caracteres`);

        return {
          ok: true,
          ruta: rutaAbsoluta,
          totalPaginas,
          paginasLeidas: paginasSolicitadas,
          titulo,
          texto: textoCompleto,
          paginas: textosPorPagina,
        };
      } finally {
        await loadingTask.destroy();
      }
    } catch (error) {
      log.error(`Error leyendo PDF: ${(error as Error).message}`);
      return {
        ok: false,
        error: `No se pudo leer el PDF: ${(error as Error).message}`,
      };
    }
  },
};
