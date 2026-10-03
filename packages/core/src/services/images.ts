/**
 * Imágenes como servicio — para el usuario final, no para el agente.
 *
 * Las tools de `tools/images/` existen para que el agente manipule imágenes
 * dentro de un turno, y trabajan con ids de artefacto porque devolverle bytes a
 * un modelo es lo que llena la ventana de contexto.
 *
 * Esto es lo otro: la superficie para que una aplicación ofrezca "convertí y
 * redimensioná tus imágenes" como funcionalidad propia. **Entra y sale por
 * bytes** —una app móvil o web sube un archivo y descarga el resultado— y por
 * dentro se persiste como artefacto para que exista una galería y un historial.
 *
 * La retención la decide el usuario. Los artefactos internos se limpian solos a
 * los 7 días, pero lo que alguien sube o transforma nace **sin expiración**:
 * borrárselo a la semana convertiría un servicio en una pérdida de datos.
 */

import { measureImage, transformImage, type ImageFormat, type TransformOptions, imagesSupported } from "../images/index";
import {
  createArtifact, readArtifactBytes, listArtifacts, setArtifactRetention, deleteArtifact,
} from "../artifacts/store";
import type { ArtifactDoc } from "../storage/collections";
import { resolveUserId } from "../storage/onboarding";
import { logger } from "../utils/logger";

const log = logger.child("services/images");

/** Lo que ve la UI de una imagen guardada. Nunca incluye los bytes. */
export interface StoredImage {
  id: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  createdAt: number;
  /** `null` = no expira. */
  expiresAt: number | null;
}

export type ImageInput = Uint8Array | ArrayBuffer | Buffer | string;

function toSummary(doc: ArtifactDoc): StoredImage {
  return {
    id: doc.id,
    mimeType: doc.mime_type,
    width: doc.width,
    height: doc.height,
    bytes: doc.size,
    createdAt: doc.created_at,
    expiresAt: doc.expires_at,
  };
}

function toBytes(input: ImageInput): Uint8Array {
  if (typeof input === "string") return Uint8Array.from(Buffer.from(input, "base64"));
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input as ArrayBuffer);
}

async function owner(userId?: string): Promise<string> {
  if (userId) return userId;
  return (await resolveUserId({}).catch(() => null)) ?? "";
}

function requireSupport(): void {
  if (!imagesSupported()) {
    throw new Error("El procesamiento de imágenes necesita Bun >= 1.4 (Bun.Image no está disponible)");
  }
}

export interface UploadOptions {
  userId?: string;
  mimeType?: string;
  /** Cuándo caduca. Por omisión **nunca**: es del usuario, no basura transitoria. */
  expiresAt?: number | null;
}

/** Guarda una imagen y devuelve su ficha. Acepta bytes o base64. */
export async function uploadImage(input: ImageInput, opts: UploadOptions = {}): Promise<StoredImage> {
  requireSupport();
  const bytes = toBytes(input);
  const meta = await measureImage(bytes);

  const doc = await createArtifact({
    bytes,
    mimeType: opts.mimeType ?? `image/${meta.format}`,
    kind: "image",
    userId: await owner(opts.userId),
    width: meta.width,
    height: meta.height,
    expiresAt: opts.expiresAt !== undefined ? opts.expiresAt : null,
  });
  return toSummary(doc);
}

export interface TransformResult extends StoredImage {
  /** Los bytes del resultado, para que la UI los descargue sin otra llamada. */
  data: Uint8Array;
}

/**
 * De dónde sale la imagen: una ya guardada o datos crudos.
 *
 * Es explícito a propósito. La alternativa —aceptar un `string` y adivinar si es
 * un id o un base64 por su longitud— funciona hasta que alguien manda una imagen
 * de 4×4 píxeles, cuyo base64 es más corto que un UUID.
 */
export type TransformSource = { imageId: string } | { data: ImageInput };

export interface ServiceTransformOptions extends TransformOptions {
  userId?: string;
  expiresAt?: number | null;
}

/**
 * Transforma una imagen y guarda el resultado como una nueva.
 *
 * Acepta un id de una imagen ya guardada o bytes sueltos, y devuelve **la ficha
 * y los bytes**: una UI que acaba de pedir una conversión quiere el archivo, no
 * tener que ir a buscarlo. El original nunca se modifica.
 */
export async function transformStoredImage(
  source: TransformSource,
  opts: ServiceTransformOptions = {},
): Promise<TransformResult> {
  requireSupport();

  let entrada: Uint8Array;
  if ("imageId" in source) {
    const datos = await readArtifactBytes(source.imageId);
    if (!datos) throw new Error(`No encontré la imagen ${source.imageId}`);
    entrada = datos.bytes;
  } else {
    entrada = toBytes(source.data);
  }

  const { bytes, metadata } = await transformImage(entrada, opts);
  const doc = await createArtifact({
    bytes,
    mimeType: `image/${metadata.format}`,
    kind: "image",
    userId: await owner(opts.userId),
    width: metadata.width,
    height: metadata.height,
    expiresAt: opts.expiresAt !== undefined ? opts.expiresAt : null,
  });

  log.info(`imagen transformada → ${doc.id} (${metadata.width}x${metadata.height} ${metadata.format})`);
  return { ...toSummary(doc), data: bytes };
}

/** Los bytes de una imagen guardada, para descargarla. */
export async function getImageBytes(
  imageId: string,
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  const datos = await readArtifactBytes(imageId);
  return datos ? { data: new Uint8Array(datos.bytes), mimeType: datos.mimeType } : null;
}

/** La galería del usuario, de la más reciente a la más vieja. */
export async function listImages(
  userId?: string,
  opts: { limit?: number; includeExpired?: boolean } = {},
): Promise<StoredImage[]> {
  const docs = await listArtifacts(await owner(userId), { kind: "image", ...opts });
  return docs.map(toSummary);
}

/**
 * Cambia cuándo caduca. `null` = conservarla indefinidamente.
 *
 * Es el control que pediste: el usuario decide qué guarda y qué deja ir.
 */
export async function setImageRetention(imageId: string, expiresAt: number | null): Promise<StoredImage> {
  const doc = await setArtifactRetention(imageId, expiresAt);
  if (!doc) throw new Error(`No encontré la imagen ${imageId}`);
  return toSummary(doc);
}

/** Borra la imagen y su archivo, ahora. */
export async function deleteImage(imageId: string): Promise<boolean> {
  return deleteArtifact(imageId);
}

// ─── Presets ─────────────────────────────────────────────────────────────────

/**
 * Tamaños de uso corriente, para que quien monte la UI no tenga que decidir
 * cuánto es "una miniatura". Son un punto de partida, no una imposición:
 * `transformStoredImage` acepta cualquier combinación.
 */
export const IMAGE_PRESETS = {
  /** Vista en cuadrícula. */
  thumbnail: { width: 256, height: 256, format: "webp" as ImageFormat, quality: 75 },
  /** Publicar en una página sin que pese de más. */
  web: { width: 1600, format: "webp" as ImageFormat, quality: 82 },
  /** Foto de perfil. */
  avatar: { width: 512, height: 512, format: "webp" as ImageFormat, quality: 85 },
} as const;

export type ImagePreset = keyof typeof IMAGE_PRESETS;

/** Aplica un preset. Atajo sobre `transformStoredImage`. */
export async function applyPreset(
  source: TransformSource,
  preset: ImagePreset,
  opts: { userId?: string; expiresAt?: number | null } = {},
): Promise<TransformResult> {
  const p = IMAGE_PRESETS[preset];
  if (!p) throw new Error(`Preset desconocido: ${preset}. Disponibles: ${Object.keys(IMAGE_PRESETS).join(", ")}`);
  return transformStoredImage(source, { ...p, ...opts });
}
