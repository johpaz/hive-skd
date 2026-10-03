/**
 * Tools de imagen — redimensionar, convertir y medir.
 *
 * Se apoyan en `Bun.Image` (ver `images/`), así que no agregan dependencias: el
 * SDK ya exige Bun ≥ 1.4.
 *
 * Trabajan sobre **artefactos**, no sobre base64 suelto, y eso es deliberado.
 * Devolver una imagen en base64 al modelo es exactamente lo que llena la
 * ventana de contexto —el problema que `mcp-result-normalizer.ts` existe para
 * evitar—. Acá la entrada es un `artifact_id` y la salida es otro: el modelo
 * maneja referencias y sólo mira la imagen si de verdad la necesita.
 *
 * Como cualquier otra tool, se activan o desactivan desde el catálogo.
 */

import type { Tool } from "../types";
import { createArtifact, readArtifactBytes } from "../../artifacts/store";
import { measureImage, transformImage, imagesSupported, type ImageFormat } from "../../images/index";
import { resolveUserId } from "../../storage/onboarding";
import { logger } from "../../utils/logger";

const log = logger.child("tools/images");

const FORMATOS: ImageFormat[] = ["jpeg", "png", "webp", "avif", "heic"];

/** Mensaje común: sin Bun 1.4 estas tools no pueden hacer nada. */
function sinSoporte() {
  return { ok: false, error: "El procesamiento de imágenes necesita Bun >= 1.4 (Bun.Image no está disponible)" };
}

async function leerArtefacto(artifactId: string) {
  const datos = await readArtifactBytes(artifactId);
  if (!datos) return null;
  return datos;
}

export const imageMetadataTool: Tool = {
  name: "image_metadata",
  description:
    "Lee las dimensiones y el formato de una imagen guardada, sin abrirla ni cargarla al contexto. " +
    "Spanish: medir imagen, dimensiones de la imagen, tamaño de la foto, formato de imagen",
  parameters: {
    type: "object",
    properties: {
      artifact_id: { type: "string", description: "Id del artefacto que contiene la imagen" },
    },
    required: ["artifact_id"],
  },
  execute: async (params: Record<string, unknown>) => {
    if (!imagesSupported()) return sinSoporte();
    const id = params.artifact_id as string;
    try {
      const datos = await leerArtefacto(id);
      if (!datos) return { ok: false, error: `No encontré el artefacto ${id}` };
      const meta = await measureImage(datos.bytes);
      return { ok: true, artifact_id: id, ...meta, bytes: datos.bytes.length };
    } catch (error) {
      return { ok: false, error: `No pude leer la imagen: ${(error as Error).message}` };
    }
  },
};

export const imageTransformTool: Tool = {
  name: "image_transform",
  description:
    "Redimensiona, rota o convierte de formato una imagen guardada y devuelve un artefacto nuevo. " +
    "El original no se toca. Spanish: redimensionar imagen, cambiar tamaño, convertir a webp, " +
    "comprimir imagen, rotar foto, achicar imagen",
  parameters: {
    type: "object",
    properties: {
      artifact_id: { type: "string", description: "Id del artefacto de origen" },
      width: { type: "number", description: "Ancho en píxeles. Si sólo se da uno, se mantiene la proporción" },
      height: { type: "number", description: "Alto en píxeles" },
      format: { type: "string", description: "Formato de salida", enum: FORMATOS },
      quality: { type: "number", description: "1–100, sólo para formatos con pérdida", minimum: 1, maximum: 100 },
      rotate: { type: "number", description: "Grados: 90, 180 o 270" },
    },
    required: ["artifact_id"],
  },
  execute: async (params: Record<string, unknown>) => {
    if (!imagesSupported()) return sinSoporte();
    const id = params.artifact_id as string;

    const formato = params.format as ImageFormat | undefined;
    if (formato && !FORMATOS.includes(formato)) {
      return { ok: false, error: `Formato no soportado: ${formato}. Disponibles: ${FORMATOS.join(", ")}` };
    }

    try {
      const datos = await leerArtefacto(id);
      if (!datos) return { ok: false, error: `No encontré el artefacto ${id}` };

      const { bytes, metadata } = await transformImage(datos.bytes, {
        width: params.width as number | undefined,
        height: params.height as number | undefined,
        format: formato,
        quality: params.quality as number | undefined,
        rotate: params.rotate as number | undefined,
      });

      const userId = (await resolveUserId({}).catch(() => null)) ?? "";
      const artefacto = await createArtifact({
        bytes,
        mimeType: `image/${metadata.format}`,
        kind: "image",
        userId,
      });

      log.info(`imagen ${id} → ${artefacto.id} (${metadata.width}x${metadata.height} ${metadata.format})`);
      // Se devuelve la referencia, nunca los bytes: el base64 en el contexto es
      // justo lo que se quiere evitar.
      return {
        ok: true,
        artifact_id: artefacto.id,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        bytes: bytes.length,
        original_bytes: datos.bytes.length,
      };
    } catch (error) {
      return { ok: false, error: `No pude transformar la imagen: ${(error as Error).message}` };
    }
  },
};

export function createTools(): Tool[] {
  return [imageMetadataTool, imageTransformTool];
}
