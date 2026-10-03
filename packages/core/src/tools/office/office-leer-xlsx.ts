/**
 * office_leer_xlsx - Leer un archivo Excel (.xlsx)
 *
 * @category office
 * @seedId office_leer_xlsx
 * @spanish leer excel, abrir xlsx, extraer datos de excel, hojas excel
 */

import type { Tool } from "../types";
import { logger } from "../../utils/logger";
import * as fs from "node:fs";
import * as path from "node:path";
import { cargarXlsx } from "./xlsx-loader";
import {
  assertBeforeDeadline,
  MAX_XLSX_INPUT_BYTES,
  MAX_XLSX_ROWS_PER_SHEET,
  MAX_XLSX_SHEETS,
  OFFICE_PROCESSING_TIMEOUT_MS,
  validateOfficeInput,
} from "./security-limits";

const log = logger.child("office-leer-xlsx");

export const officeLeerXlsxTool: Tool = {
  name: "office_leer_xlsx",
  description:
    "Leer un archivo Excel (.xlsx) y retornar las hojas con sus datos como objetos JSON. Spanish: leer excel, abrir xlsx, extraer datos de excel, hojas excel",
  parameters: {
    type: "object",
    properties: {
      ruta: {
        type: "string",
        description: "Ruta absoluta o relativa al archivo .xlsx",
      },
      hoja: {
        type: "string",
        description: "Nombre de hoja específica a leer (default: todas las hojas)",
      },
      incluir_encabezados: {
        type: "boolean",
        description:
          "Usar primera fila como encabezados de columna (default: true)",
      },
      rango: {
        type: "string",
        description:
          "Rango de celdas a leer en notación Excel (ej: 'A1:D10', default: toda la hoja)",
      },
    },
    required: ["ruta"],
  },
  execute: async (params: Record<string, unknown>) => {
    const ruta = params.ruta as string;
    const hojaFiltro = params.hoja as string | undefined;
    const incluirEncabezados = (params.incluir_encabezados as boolean) ?? true;
    const rango = params.rango as string | undefined;

    log.debug(`Leyendo XLSX: ${ruta}`);

    try {
      const rutaAbsoluta = path.resolve(ruta);
      if (!fs.existsSync(rutaAbsoluta)) {
        return { ok: false, error: `Archivo no encontrado: ${rutaAbsoluta}` };
      }

      const inputError = validateOfficeInput(
        rutaAbsoluta,
        MAX_XLSX_INPUT_BYTES,
        "El XLSX",
      );
      if (inputError) return { ok: false, error: inputError };

      const XLSX = await cargarXlsx();
      const buffer = fs.readFileSync(rutaAbsoluta);
      const deadline = Date.now() + OFFICE_PROCESSING_TIMEOUT_MS;
      const workbook = XLSX.read(buffer, {
        type: "buffer",
        sheetRows: MAX_XLSX_ROWS_PER_SHEET + 2,
        sheets: hojaFiltro,
      });

      const nombresHojas = hojaFiltro
        ? [hojaFiltro]
        : workbook.SheetNames;

      if (nombresHojas.length > MAX_XLSX_SHEETS) {
        return {
          ok: false,
          error: `El XLSX contiene más de ${MAX_XLSX_SHEETS} hojas`,
        };
      }

      const hojas: Record<string, any[]> = {};

      for (const nombreHoja of nombresHojas) {
        assertBeforeDeadline(deadline, "La lectura del XLSX");
        const hoja = workbook.Sheets[nombreHoja];
        if (!hoja) {
          log.warn(`Hoja '${nombreHoja}' no encontrada en el archivo`);
          continue;
        }

        if (incluirEncabezados) {
          // La primera fila se usa como encabezados
          hojas[nombreHoja] = XLSX.utils.sheet_to_json(hoja, {
            defval: "",
            range: rango,
          });
        } else {
          // Devolver como array de arrays (sin encabezados)
          hojas[nombreHoja] = XLSX.utils.sheet_to_json(hoja, {
            header: 1,
            defval: "",
            range: rango,
          });
        }

        if (hojas[nombreHoja].length > MAX_XLSX_ROWS_PER_SHEET) {
          return {
            ok: false,
            error: `La hoja '${nombreHoja}' supera el máximo de 10.000 filas`,
          };
        }
      }

      const totalFilas = Object.values(hojas).reduce(
        (acc, filas) => acc + filas.length,
        0
      );

      log.info(
        `XLSX leído: ${nombresHojas.length} hojas, ${totalFilas} filas totales`
      );

      return {
        ok: true,
        ruta: rutaAbsoluta,
        hojas: workbook.SheetNames,
        datos: hojas,
        totalFilas,
      };
    } catch (error) {
      log.error(`Error leyendo XLSX: ${(error as Error).message}`);
      return {
        ok: false,
        error: `No se pudo leer el archivo Excel: ${(error as Error).message}`,
      };
    }
  },
};
