import { fileURLToPath } from "node:url"
import { assertBeforeDeadline, MAX_PDF_INPUT_BYTES, MAX_PDF_PAGES_PER_REQUEST, OFFICE_PROCESSING_TIMEOUT_MS } from "./security-limits"

/**
 * Extracción de texto de PDF sin modelos: solo la capa de texto del archivo
 * (pdfjs). Reconstruye renglones y columnas a partir de las posiciones, en vez
 * de aplastar todo en una línea, para que tablas y párrafos sigan legibles.
 *
 * Un PDF escaneado no tiene capa de texto: aquí se informa como tal
 * (`sinTexto`) y no se intenta adivinar con un modelo.
 */

export interface PdfTextResult {
  totalPaginas: number
  paginasLeidas: number
  titulo?: string
  texto: string
  /** Caracteres de texto por página leída (sirve para ver cuáles están vacías). */
  caracteresPorPagina: number[]
  /** true si ninguna de las páginas leídas tiene texto extraíble (PDF escaneado o solo imágenes). */
  sinTexto: boolean
  /** true si se cortó por el tope de caracteres. */
  truncado: boolean
  /** Primera página que no se llegó a leer (para continuar), si hubo corte o rango. */
  siguientePagina?: number
}


/**
 * pdfjs hace referencia a DOMMatrix, ImageData y Path2D al cargarse. En desarrollo se
 * las presta `@napi-rs/canvas`, pero en el ejecutable compilado (app de escritorio,
 * paquete) ese módulo no existe y la carga muere con «DOMMatrix is not defined». Para
 * extraer texto no hace falta dibujar nada: bastan clases mínimas, solo si faltan.
 */
function instalarPolyfillsPdf(): void {
  const g = globalThis as any
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
      constructor(init?: ArrayLike<number> | string) {
        if (init && typeof init !== "string" && init.length >= 6) {
          const [a, b, c, d, e, f] = Array.from(init)
          this.a = a ?? 1; this.b = b ?? 0; this.c = c ?? 0; this.d = d ?? 1; this.e = e ?? 0; this.f = f ?? 0
        }
      }
      multiplySelf(): this { return this }
      preMultiplySelf(): this { return this }
      translateSelf(): this { return this }
      scaleSelf(): this { return this }
      invertSelf(): this { return this }
    }
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class ImageData { constructor(public width = 0, public height = 0, public data: Uint8ClampedArray = new Uint8ClampedArray(0)) {} }
  }
  if (typeof g.Path2D === "undefined") {
    g.Path2D = class Path2D {}
  }
}

export function textoDePagina(items: any[]): string {
  const lineas: string[] = []
  let actual = ""
  let prevY: number | null = null
  let prevFin = 0

  const cerrar = (blanco: boolean) => {
    if (actual.trim()) lineas.push(actual.replace(/[ \t]+$/g, ""))
    if (blanco && lineas.length && lineas[lineas.length - 1] !== "") lineas.push("")
    actual = ""
    prevFin = 0
  }

  for (const it of items) {
    if (typeof it?.str !== "string") continue
    const x: number | undefined = it.transform?.[4]
    const y: number | undefined = it.transform?.[5]
    const alto = Math.abs(it.transform?.[3] ?? it.height ?? 10) || 10

    if (prevY !== null && y !== undefined) {
      const salto = Math.abs(y - prevY)
      if (salto > alto * 0.5) cerrar(salto > alto * 1.9)
    }
    if (actual && x !== undefined && it.str) {
      const hueco = x - prevFin
      if (hueco > alto * 1.5) actual += "  "          // columna distinta
      else if (hueco > alto * 0.15 && !/\s$/.test(actual) && !/^\s/.test(it.str)) actual += " "
    }
    actual += it.str
    if (x !== undefined) prevFin = x + (it.width ?? 0)
    if (y !== undefined) prevY = y
    if (it.hasEOL) { cerrar(false); prevY = null }
  }
  cerrar(false)
  return lineas.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

export async function extraerTextoPdf(
  bytes: Uint8Array,
  opts: { desde?: number; hasta?: number; maxCaracteres?: number } = {},
): Promise<PdfTextResult> {
  if (bytes.byteLength > MAX_PDF_INPUT_BYTES) {
    throw new Error(`El PDF excede el límite de ${MAX_PDF_INPUT_BYTES / (1024 * 1024)} MiB`)
  }
  const plazo = Date.now() + OFFICE_PROCESSING_TIMEOUT_MS
  instalarPolyfillsPdf()
  // La build legacy conserva compatibilidad con Bun; pdfjs 6 monta su propio fake worker.
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs" as any).catch(() => import("pdfjs-dist" as any))
  const lib = pdfjs.default ?? pdfjs
  const paqueteUrl = import.meta.resolve("pdfjs-dist/package.json")
  const tarea = lib.getDocument({
    data: new Uint8Array(bytes),
    enableScripting: false,
    isEvalSupported: false,
    // Bun espera una ruta de sistema aquí, no una URL file://.
    standardFontDataUrl: fileURLToPath(new URL("./standard_fonts/", paqueteUrl)),
  })

  let doc: any
  try {
    doc = await tarea.promise
  } catch (err: any) {
    if (err?.name === "PasswordException") throw new Error("El PDF está protegido con contraseña.")
    if (err?.name === "InvalidPDFException") throw new Error("El archivo no es un PDF válido o está dañado.")
    throw err
  }

  const total: number = doc.numPages
  const desdePedido = Math.floor(opts.desde ?? 1)
  if (desdePedido < 1 || desdePedido > total) throw new Error(`La página inicial debe estar entre 1 y ${total}`)
  const desde = desdePedido
  const hastaPedido = Math.min(Math.max(desde, Math.floor(opts.hasta ?? total)), total)
  // Nunca más de MAX_PDF_PAGES_PER_REQUEST páginas por llamada; el resto se pide con siguientePagina.
  const hasta = Math.min(hastaPedido, desde + MAX_PDF_PAGES_PER_REQUEST - 1)
  const tope = opts.maxCaracteres ?? Infinity

  let titulo: string | undefined
  try { titulo = (await doc.getMetadata())?.info?.Title || undefined } catch { /* metadata opcional */ }

  const bloques: string[] = []
  const caracteres: number[] = []
  let usados = 0
  let truncado = false
  let siguiente: number | undefined
  let ultimaLeida = desde - 1

  for (let n = desde; n <= hasta; n++) {
    assertBeforeDeadline(plazo, "La lectura del PDF")
    const texto = textoDePagina((await (await doc.getPage(n)).getTextContent()).items as any[])
    const bloque = `--- Página ${n} ---\n${texto}`
    if (usados > 0 && usados + bloque.length > tope) { truncado = true; siguiente = n; break }
    if (bloque.length > tope) {
      // Una sola página ya excede el tope: se recorta, pero siempre se entrega algo.
      bloques.push(bloque.slice(0, tope))
      caracteres.push(texto.length)
      ultimaLeida = n
      truncado = true
      siguiente = n < total ? n + 1 : undefined
      usados += tope
      break
    }
    bloques.push(bloque)
    caracteres.push(texto.length)
    usados += bloque.length
    ultimaLeida = n
  }
  if (!truncado && ultimaLeida < total) siguiente = ultimaLeida + 1

  try { await tarea.destroy() } catch { /* best effort */ }

  const sinTexto = caracteres.length > 0 && caracteres.every((c) => c === 0)
  return {
    totalPaginas: total,
    paginasLeidas: caracteres.length,
    titulo,
    texto: bloques.join("\n\n"),
    caracteresPorPagina: caracteres,
    sinTexto,
    truncado,
    ...(siguiente !== undefined && siguiente <= total ? { siguientePagina: siguiente } : {}),
  }
}
