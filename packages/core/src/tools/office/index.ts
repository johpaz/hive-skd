/**
 * Office Tools - 8 tools para manejo de archivos Office
 *
 * @category office
 *
 * Herramientas:
 * - office_leer_pdf     — Leer PDF y extraer texto + metadata
 * - office_escribir_pdf — Generar PDF desde texto
 * - office_leer_docx    — Leer Word (.docx) y extraer texto
 * - office_escribir_docx — Generar Word (.docx) con párrafos y tablas
 * - office_leer_xlsx    — Leer Excel (.xlsx) como JSON
 * - office_escribir_xlsx — Generar Excel (.xlsx) desde JSON
 * - office_leer_pptx    — Leer PowerPoint (.pptx) y extraer texto por slide
 * - office_escribir_pptx — Generar PowerPoint (.pptx) desde array de slides
 */

import type { Tool } from "../types";
import { officeLeerPdfTool } from "./office-leer-pdf";
import { officeEscribirPdfTool } from "./office-escribir-pdf";
import { officeLeerDocxTool } from "./office-leer-docx";
import { officeEscribirDocxTool } from "./office-escribir-docx";
import { officeLeerXlsxTool } from "./office-leer-xlsx";
import { officeEscribirXlsxTool } from "./office-escribir-xlsx";
import { officeLeerPptxTool } from "./office-leer-pptx";
import { officeEscribirPptxTool } from "./office-escribir-pptx";

export function createTools(): Tool[] {
  return [
    officeLeerPdfTool,
    officeEscribirPdfTool,
    officeLeerDocxTool,
    officeEscribirDocxTool,
    officeLeerXlsxTool,
    officeEscribirXlsxTool,
    officeLeerPptxTool,
    officeEscribirPptxTool,
  ];
}

export * from "./office-leer-pdf";
export * from "./office-escribir-pdf";
export * from "./office-leer-docx";
export * from "./office-escribir-docx";
export * from "./office-leer-xlsx";
export * from "./office-escribir-xlsx";
export * from "./office-leer-pptx";
export * from "./office-escribir-pptx";
