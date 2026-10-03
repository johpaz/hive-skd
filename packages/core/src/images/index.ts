/**
 * Imágenes — redimensionar, convertir y medir, sin dependencias nativas.
 *
 * Usa `Bun.Image` (Bun 1.4), que es sharp integrado en el runtime: no hay que
 * instalar nada ni compilar bindings. El SDK ya exige Bun ≥ 1.4, así que esto
 * no agrega ningún requisito.
 *
 * Sirve para dos cosas distintas y conviene no confundirlas:
 *
 *  1. **Tools activables** para el agente (`tools/images/`) — recortar, convertir
 *     de formato, leer dimensiones. Es una capacidad de producto.
 *  2. **Normalizar lo que entra** — una foto de 4 MB que un usuario manda por
 *     WhatsApp no tiene por qué viajar entera al modelo. Redimensionarla antes
 *     cuesta una fracción de los tokens y no cambia lo que el modelo puede ver.
 *
 * Nota sobre `Bun.Image`: las transformaciones son **diferidas**. `metadata()`
 * sobre una cadena sin materializar devuelve las dimensiones del origen, no las
 * del resultado — hay que pedir los bytes y releerlos. `measureImage()` lo hace
 * por vos cuando hace falta.
 */

import { logger } from "../utils/logger";

const log = logger.child("images");

/** Los que `Bun.Image` sabe escribir. */
export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "heic";

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
}

export interface TransformOptions {
  /** Ancho máximo; la altura se ajusta manteniendo la proporción si no se da. */
  width?: number;
  height?: number;
  format?: ImageFormat;
  /** 1–100. Sólo lo respetan los formatos con pérdida. */
  quality?: number;
  /** Grados: 90, 180, 270. */
  rotate?: number;
  flip?: boolean;
  flop?: boolean;
}

function bunImage(): any {
  const I = (Bun as any).Image;
  if (!I) {
    throw new Error("Bun.Image no está disponible: se necesita Bun >= 1.4");
  }
  return I;
}

function toBytes(input: Uint8Array | ArrayBuffer | Buffer | string): Uint8Array {
  if (typeof input === "string") return Uint8Array.from(Buffer.from(input, "base64"));
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input as ArrayBuffer);
}

/** Dimensiones y formato sin decodificar la imagen entera. */
export async function measureImage(input: Uint8Array | ArrayBuffer | Buffer | string): Promise<ImageMetadata> {
  const meta = await new (bunImage())(toBytes(input)).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

/**
 * Aplica las transformaciones y devuelve los bytes resultantes.
 *
 * Sin `format` conserva el de origen. Sin nada que hacer devuelve la entrada tal
 * cual, para no recomprimir de gusto.
 */
export async function transformImage(
  input: Uint8Array | ArrayBuffer | Buffer | string,
  opts: TransformOptions,
): Promise<{ bytes: Uint8Array; metadata: ImageMetadata }> {
  const bytes = toBytes(input);
  const hayQueHacer = opts.width || opts.height || opts.format || opts.rotate || opts.flip || opts.flop;
  if (!hayQueHacer) return { bytes, metadata: await measureImage(bytes) };

  let img = new (bunImage())(bytes);

  if (opts.width || opts.height) img = img.resize(opts.width, opts.height);
  if (opts.rotate) img = img.rotate(opts.rotate);
  if (opts.flip) img = img.flip();
  if (opts.flop) img = img.flop();

  const formato = opts.format ?? ((await measureImage(bytes)).format as ImageFormat);
  const args = opts.quality !== undefined ? [{ quality: opts.quality }] : [];
  img = typeof img[formato] === "function" ? img[formato](...args) : img;

  const salida: Uint8Array = await img.bytes();
  // Se releen los bytes porque `metadata()` sobre la cadena diferida informa el
  // origen, no el resultado.
  return { bytes: salida, metadata: await measureImage(salida) };
}

export interface NormalizeOptions {
  /** Lado mayor permitido. Por encima se reduce manteniendo la proporción. */
  maxDimension?: number;
  /** Formato de salida; `webp` pesa mucho menos que un JPEG equivalente. */
  format?: ImageFormat;
  quality?: number;
}

/** Por defecto: 1024 px de lado mayor y webp al 80 — el punto donde un modelo de visión deja de ganar detalle. */
const NORMALIZE_DEFAULTS: Required<NormalizeOptions> = {
  maxDimension: 1024,
  format: "webp",
  quality: 80,
};

export interface NormalizeResult {
  bytes: Uint8Array;
  metadata: ImageMetadata;
  /** Bytes originales, para saber cuánto se ahorró. */
  originalBytes: number;
  /** true si hubo que tocarla; false si ya era chica. */
  changed: boolean;
}

/**
 * Deja una imagen entrante en un tamaño razonable para mandársela a un modelo.
 *
 * Una foto de teléfono son varios megabytes y unos cuantos miles de tokens; a
 * 1024 px el modelo ve lo mismo por una fracción del costo. Si ya está por
 * debajo del límite no se toca — recomprimir una imagen chica sólo la empeora.
 */
export async function normalizeForModel(
  input: Uint8Array | ArrayBuffer | Buffer | string,
  opts: NormalizeOptions = {},
): Promise<NormalizeResult> {
  const cfg = { ...NORMALIZE_DEFAULTS, ...opts };
  const bytes = toBytes(input);
  const meta = await measureImage(bytes);
  const mayor = Math.max(meta.width, meta.height);

  if (mayor <= cfg.maxDimension && meta.format === cfg.format) {
    return { bytes, metadata: meta, originalBytes: bytes.length, changed: false };
  }

  const escala = mayor > cfg.maxDimension ? cfg.maxDimension / mayor : 1;
  const { bytes: salida, metadata } = await transformImage(bytes, {
    width: Math.round(meta.width * escala),
    height: Math.round(meta.height * escala),
    format: cfg.format,
    quality: cfg.quality,
  });

  log.info(
    `imagen normalizada: ${meta.width}x${meta.height} ${meta.format} (${bytes.length}b) → ` +
    `${metadata.width}x${metadata.height} ${metadata.format} (${salida.length}b)`,
  );
  return { bytes: salida, metadata, originalBytes: bytes.length, changed: true };
}

/** true si este runtime puede procesar imágenes. */
export function imagesSupported(): boolean {
  return typeof (Bun as any).Image === "function";
}
