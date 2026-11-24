import { statSync } from "node:fs";

export const MAX_PDF_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_XLSX_INPUT_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_PAGES_PER_REQUEST = 200;
export const MAX_XLSX_SHEETS = 50;
export const MAX_XLSX_ROWS_PER_SHEET = 10_000;
export const OFFICE_PROCESSING_TIMEOUT_MS = 30_000;
/** Word, PowerPoint y Excel editados por XML: se cargan enteros en memoria. */
export const MAX_OFFICE_ZIP_INPUT_BYTES = 50 * 1024 * 1024;
/** Tope de caracteres de una parte XML ya descomprimida (defensa contra zip bombs). */
export const MAX_OFFICE_XML_CHARS = 20_000_000;
/** Tope de caracteres por llamada de las tools de lectura (se continúa con siguiente_pagina / desde_diapositiva). */
export const DEFAULT_READ_MAX_CHARS = 40_000;

export function validateOfficeInput(
  filePath: string,
  maxBytes: number,
  label: string,
): string | null {
  const stat = statSync(filePath);
  if (!stat.isFile()) return `${label} debe ser un archivo regular`;
  if (stat.size > maxBytes) {
    const maxMiB = maxBytes / (1024 * 1024);
    return `${label} excede el límite de ${maxMiB} MiB`;
  }
  return null;
}

export function assertBeforeDeadline(deadline: number, label: string): void {
  if (Date.now() > deadline) {
    throw new Error(`${label} excedió el límite de procesamiento de 30 segundos`);
  }
}

export function assertXmlSize(xml: string, label: string): void {
  if (xml.length > MAX_OFFICE_XML_CHARS) {
    throw new Error(`${label} es demasiado grande tras descomprimirse (máximo ${MAX_OFFICE_XML_CHARS / 1_000_000} millones de caracteres)`);
  }
}
