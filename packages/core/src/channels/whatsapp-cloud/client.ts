/**
 * Cliente de la WhatsApp Cloud API — la API oficial de Meta.
 *
 * No agrega dependencias: sólo `fetch`. Cada instancia habla por UN número
 * (`phoneNumberId`), que es la unidad con la que Meta cobra, limita el caudal y
 * numera los errores.
 *
 * Por qué existe acá y no en cada aplicación: la versión del Graph caduca sola.
 * Meta garantiza unos dos años por versión y después manda las llamadas a la
 * más vieja que siga viva, sin avisar y cambiando el comportamiento. Teniendo
 * un único cliente, subir de versión es una línea para todos los consumidores.
 */

import { logger } from "../../utils/logger";

const log = logger.child("whatsapp-cloud");

/** Última versión estable del Graph. Se puede pisar con `META_GRAPH_API_VERSION`. */
export const DEFAULT_GRAPH_VERSION = "v26.0";

/** Meta rechaza cualquier `text.body` de más de 4096 caracteres. */
export const WHATSAPP_TEXT_LIMIT = 4096;

/** La ventana de atención al cliente: fuera de ella sólo se aceptan plantillas. */
export const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;

const RATE_WINDOW_MS = 1000;
/** Meta acepta del orden de 80 mensajes por segundo por número. */
const MAX_REQUESTS_PER_WINDOW = 80;
/** Cuánto se espera como mucho a que se libere un lugar antes de fallar. */
const MAX_THROTTLE_WAIT_MS = 5000;

export interface WhatsAppCloudClientConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Por defecto `META_GRAPH_API_VERSION`, y si no está, `DEFAULT_GRAPH_VERSION`. */
  graphVersion?: string;
  /** Inyectable para tests. */
  fetch?: typeof fetch;
}

export interface WhatsAppTemplate {
  name: string;
  language?: string;
  components?: unknown[];
}

export interface WhatsAppMediaDownload {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
}

/**
 * Un error de la Cloud API con su código de Meta a mano.
 *
 * Los códigos importan porque cambian la decisión de quien llama: 131047 no es
 * un fallo, es "se cerró la ventana de 24 h y hay que mandar una plantilla".
 */
export class WhatsAppCloudError extends Error {
  readonly status: number;
  readonly code: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;

  constructor(
    status: number,
    code: number,
    message: string,
    extra?: { subcode?: number; fbtraceId?: string }
  ) {
    super(message);
    this.name = "WhatsAppCloudError";
    this.status = status;
    this.code = code;
    this.subcode = extra?.subcode;
    this.fbtraceId = extra?.fbtraceId;
  }

  static from(status: number, payload: unknown): WhatsAppCloudError {
    const error = (payload as { error?: Record<string, unknown> })?.error ?? {};
    const code = Number(error.code ?? 0);
    const message = String(error.message ?? `HTTP ${status}`);
    return new WhatsAppCloudError(status, code, `Meta API error: ${message}`, {
      subcode: error.error_subcode !== undefined ? Number(error.error_subcode) : undefined,
      fbtraceId: error.fbtrace_id ? String(error.fbtrace_id) : undefined,
    });
  }

  /** 131047: pasaron más de 24 h desde el último mensaje del cliente. */
  get windowClosed(): boolean {
    return this.code === 131047;
  }

  /** 130429: caudal de la app; 131056: demasiados mensajes al mismo destinatario. */
  get rateLimited(): boolean {
    return this.code === 130429 || this.code === 131056 || this.status === 429;
  }

  /** 190: el token expiró o fue revocado. */
  get tokenExpired(): boolean {
    return this.code === 190;
  }

  /** 131026: el destinatario no puede recibir el mensaje. */
  get undeliverable(): boolean {
    return this.code === 131026;
  }

  /** 368: la cuenta de WhatsApp Business está restringida por incumplir la política. */
  get accountRestricted(): boolean {
    return this.code === 368;
  }

  /** Si reintentar tiene sentido. Un 131047 o un 368 no se arreglan reintentando. */
  get retryable(): boolean {
    return this.rateLimited || this.status >= 500;
  }
}

/**
 * Parte un texto en trozos que Meta acepte, cortando donde menos se note:
 * primero entre párrafos, después entre líneas y, sólo si no queda otra, por
 * el último espacio antes del límite.
 */
export function splitWhatsAppText(text: string, limit = WHATSAPP_TEXT_LIMIT): string[] {
  if (text.length <= limit) return text ? [text] : [];

  const chunks: string[] = [];
  let pending = "";

  const push = (): void => {
    const trimmed = pending.trim();
    if (trimmed) chunks.push(trimmed);
    pending = "";
  };

  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = pending ? `${pending}\n\n${paragraph}` : paragraph;

    if (candidate.length <= limit) {
      pending = candidate;
      continue;
    }

    push();

    if (paragraph.length <= limit) {
      pending = paragraph;
      continue;
    }

    // Un párrafo solo ya no entra: se parte por líneas, y una línea gigante
    // (un log, una tabla) por el último espacio antes del límite.
    for (const line of paragraph.split("\n")) {
      const withLine = pending ? `${pending}\n${line}` : line;
      if (withLine.length <= limit) {
        pending = withLine;
        continue;
      }
      push();

      let rest = line;
      while (rest.length > limit) {
        const window = rest.slice(0, limit);
        const cut = window.lastIndexOf(" ");
        const at = cut > limit * 0.5 ? cut : limit;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trimStart();
      }
      pending = rest;
    }
  }

  push();
  return chunks;
}

export class WhatsAppCloudClient {
  readonly phoneNumberId: string;
  readonly graphVersion: string;

  private readonly accessToken: string;
  // Deliberadamente más laxo que `typeof fetch`: lo que se inyecta en los tests
  // no implementa extras del runtime como `preconnect`, y acá no hacen falta.
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private bucket = { count: 0, resetAt: 0 };

  constructor(config: WhatsAppCloudClientConfig) {
    this.phoneNumberId = config.phoneNumberId;
    this.accessToken = config.accessToken;
    this.graphVersion =
      config.graphVersion ?? process.env.META_GRAPH_API_VERSION ?? DEFAULT_GRAPH_VERSION;
    this.fetchImpl = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Manda un texto, partido en varios mensajes si hace falta. Devuelve los ids. */
  async sendText(to: string, text: string, opts?: { previewUrl?: boolean }): Promise<string[]> {
    const chunks = splitWhatsAppText(text);
    const ids: string[] = [];

    // En serie a propósito: en paralelo los mensajes llegarían desordenados.
    for (const chunk of chunks) {
      const data = await this.post<{ messages?: { id?: string }[] }>({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: opts?.previewUrl ?? false, body: chunk },
      });
      const id = data.messages?.[0]?.id;
      if (id) ids.push(id);
    }

    if (chunks.length > 1) {
      log.debug(`texto de ${text.length} caracteres enviado en ${chunks.length} mensajes`);
    }
    return ids;
  }

  /** Manda una plantilla aprobada: lo único que Meta acepta fuera de la ventana. */
  async sendTemplate(to: string, template: WhatsAppTemplate): Promise<string> {
    const data = await this.post<{ messages?: { id?: string }[] }>({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language ?? "es" },
        components: template.components ?? [],
      },
    });
    return data.messages?.[0]?.id ?? "";
  }

  /** Sube el audio y lo manda como nota de voz. */
  async sendAudio(to: string, audio: Buffer, mimeType = "audio/ogg"): Promise<string> {
    const mediaId = await this.uploadMedia(audio, mimeType, "audio.ogg");
    const data = await this.post<{ messages?: { id?: string }[] }>({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "audio",
      audio: { id: mediaId },
    });
    return data.messages?.[0]?.id ?? "";
  }

  /**
   * Marca el mensaje como leído y, si se pide, muestra "escribiendo…".
   *
   * Van juntos en la misma llamada porque así lo define Meta. El indicador se
   * apaga solo al responder, o a los 25 segundos.
   */
  async markRead(messageId: string, opts?: { typing?: boolean }): Promise<void> {
    await this.post({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      ...(opts?.typing ? { typing_indicator: { type: "text" } } : {}),
    });
  }

  /** Sube un archivo y devuelve su id de medio. */
  async uploadMedia(bytes: Buffer, mimeType: string, fileName = "file"): Promise<string> {
    await this.throttle();

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), fileName);

    const res = await this.fetchImpl(this.url(`${this.phoneNumberId}/media`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    if (!res.ok || !data.id) throw WhatsAppCloudError.from(res.status, data);
    return data.id;
  }

  /**
   * Baja un medio recibido. Son dos pasos: el id da una URL firmada, y esa URL
   * también exige el token.
   */
  async downloadMedia(mediaId: string): Promise<WhatsAppMediaDownload> {
    await this.throttle();
    const metaRes = await this.fetchImpl(this.url(mediaId), {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    const meta = (await metaRes.json().catch(() => ({}))) as {
      url?: string;
      mime_type?: string;
      file_name?: string;
    };
    if (!metaRes.ok || !meta.url) throw WhatsAppCloudError.from(metaRes.status, meta);

    const fileRes = await this.fetchImpl(meta.url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!fileRes.ok) {
      throw new WhatsAppCloudError(fileRes.status, 0, `No se pudo bajar el medio ${mediaId}`);
    }

    return {
      buffer: Buffer.from(await fileRes.arrayBuffer()),
      mimeType: meta.mime_type ?? "application/octet-stream",
      fileName: meta.file_name,
    };
  }

  private url(path: string): string {
    return `https://graph.facebook.com/${this.graphVersion}/${path}`;
  }

  private async post<T = unknown>(body: Record<string, unknown>): Promise<T> {
    await this.throttle();

    const res = await this.fetchImpl(this.url(`${this.phoneNumberId}/messages`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) throw WhatsAppCloudError.from(res.status, data);
    return data;
  }

  /**
   * Cupo por número. A diferencia del de hive-cloud, que fallaba al llenarse,
   * este espera a que se abra la ventana: un texto largo sale en varios
   * mensajes seguidos y no tiene por qué morir por su propio caudal.
   */
  private async throttle(): Promise<void> {
    const deadline = Date.now() + MAX_THROTTLE_WAIT_MS;

    for (;;) {
      const now = Date.now();
      if (now >= this.bucket.resetAt) {
        this.bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
      }
      if (this.bucket.count < MAX_REQUESTS_PER_WINDOW) {
        this.bucket.count++;
        return;
      }
      if (now >= deadline) {
        throw new WhatsAppCloudError(
          429,
          130429,
          `Caudal propio superado para el número ${this.phoneNumberId}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.bucket.resetAt - now));
    }
  }
}

export function createWhatsAppCloudClient(
  config: WhatsAppCloudClientConfig
): WhatsAppCloudClient {
  return new WhatsAppCloudClient(config);
}
