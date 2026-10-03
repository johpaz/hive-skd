/**
 * Canal de WhatsApp por la API oficial de Meta (Cloud API).
 *
 * Es el camino para empresas: número de WhatsApp Business propio, plantillas de
 * marketing y atribución de los anuncios que abren una conversación. El otro
 * canal de WhatsApp del SDK (`whatsapp`, con Baileys y código QR) no es oficial
 * y sirve para uso personal, no para un negocio.
 *
 * A diferencia de los demás canales, este no abre ninguna conexión: Meta empuja
 * los mensajes a una URL pública. Quien hospeda el canal tiene que enrutarle las
 * peticiones a `handleWebhook()`; el gateway del SDK ya lo hace en
 * `/webhooks/whatsapp-cloud/:accountId`.
 */

import { BaseChannel, type ChannelConfig, type IncomingMessage, type OutboundMessage } from "../base";
import { logger } from "../../utils/logger";
import { updateDoc } from "../../storage/hive";
import type { ChannelDoc } from "../../storage/collections";
import {
  CUSTOMER_WINDOW_MS,
  WhatsAppCloudClient,
  WhatsAppCloudError,
  type WhatsAppTemplate,
} from "./client";
import {
  parseWebhook,
  safeTokenEquals,
  verifyChallenge,
  verifySignature,
  type WhatsAppInbound,
} from "./webhook";

/** Cuántos ids de mensaje se recuerdan para descartar los reintentos de Meta. */
const SEEN_LIMIT = 1000;

export interface WhatsAppCloudConfig extends ChannelConfig {
  accountId: string;
  /** Id del número en Meta (no el número en sí). */
  phoneNumberId: string;
  /** Token permanente, normalmente de un usuario del sistema. */
  accessToken: string;
  /** Secreto de la app de Meta, con el que se firma cada webhook. */
  appSecret: string;
  /** El token que uno inventa y pega en el panel de Meta al registrar la URL. */
  verifyToken: string;
  graphVersion?: string;
  /**
   * Mandar la narración intermedia del agente como mensajes sueltos.
   *
   * Apagado a propósito: desde el 1/10/2026 Meta cobra cada mensaje de servicio
   * dentro de la ventana, así que narrar el progreso sale caro. En su lugar se
   * renueva el "escribiendo…", que no cuesta nada.
   */
  sendProgress?: boolean;
  /** Plantilla aprobada para hablarle a alguien fuera de la ventana de 24 h. */
  windowFallbackTemplate?: WhatsAppTemplate;
  /** Inyectable para tests o para salir por un proxy. */
  fetch?: typeof fetch;
}

export interface WhatsAppCloudState {
  status: "disconnected" | "pending_verification" | "connected" | "error";
  phoneNumberId: string;
  lastWebhookAt?: number;
  error?: string;
}

export class WhatsAppCloudChannel extends BaseChannel {
  name = "whatsapp_cloud";
  accountId: string;
  config: WhatsAppCloudConfig;

  readonly client: WhatsAppCloudClient;

  private state: WhatsAppCloudState;
  private log = logger.child("whatsapp-cloud");
  /** Último mensaje entrante por sesión: abre la ventana y da el id para el "escribiendo…". */
  private lastInbound: Map<string, { at: number; messageId: string }> = new Map();
  private seen: Set<string> = new Set();

  constructor(config: WhatsAppCloudConfig) {
    super();
    this.config = config;
    this.accountId = config.accountId;
    this.client = new WhatsAppCloudClient({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      graphVersion: config.graphVersion,
      fetch: config.fetch,
    });
    this.state = { status: "disconnected", phoneNumberId: config.phoneNumberId };
  }

  /** La ruta que hay que registrar en el panel de Meta, detrás de HTTPS público. */
  get webhookPath(): string {
    return `/webhooks/whatsapp-cloud/${this.accountId}`;
  }

  async start(): Promise<void> {
    this.running = true;
    // No hay nada que conectar: queda esperando el webhook. Hasta que Meta haga
    // su verificación, el canal está dado de alta pero no recibe nada.
    this.state.status = this.state.lastWebhookAt ? "connected" : "pending_verification";
    this.log.info(`Canal listo — registrá ${this.webhookPath} en la app de Meta`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.state.status = "disconnected";
    this.log.info("Canal detenido");
  }

  /**
   * Atiende una petición de Meta: la verificación inicial y cada mensaje.
   *
   * Responde 200 en cuanto el evento es válido, sin esperar el turno del
   * agente: Meta reintenta lo que tarde y termina desuscribiendo la app.
   */
  async handleWebhook(req: Request): Promise<Response> {
    if (req.method === "GET") {
      const challenge = verifyChallenge(new URL(req.url).searchParams, (token) =>
        safeTokenEquals(token, this.config.verifyToken)
      );
      if (!challenge) {
        this.log.warn("verificación rechazada: token incorrecto");
        return new Response("Verification failed", { status: 403 });
      }
      await this.setStatus("connected");
      return new Response(challenge, { status: 200 });
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = await req.text();
    if (!verifySignature(rawBody, req.headers.get("x-hub-signature-256"), this.config.appSecret)) {
      this.log.warn("firma HMAC inválida — evento descartado");
      return new Response("Invalid signature", { status: 401 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    this.state.lastWebhookAt = Date.now();
    if (this.state.status !== "connected") await this.setStatus("connected");

    for (const event of parseWebhook(body)) {
      // Un mismo WABA puede tener varios números apuntando a la misma URL.
      if (event.phoneNumberId !== this.config.phoneNumberId) continue;

      for (const message of event.messages) {
        void this.ingest(message).catch((error) =>
          this.log.error(`no se pudo procesar ${message.id}: ${(error as Error).message}`)
        );
      }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  async send(sessionId: string, message: OutboundMessage): Promise<void> {
    const isInterim = message.type === "progress";
    if (isInterim && !this.config.sendProgress) {
      // La narración no se manda: cada mensaje intermedio se cobra. El
      // "escribiendo…" cuenta lo mismo y es gratis.
      await this.startTyping(sessionId).catch(() => {});
      return;
    }

    const text = message.content ?? message.chunk ?? "";
    if (!text) return;

    const to = this.toRecipient(sessionId);
    const last = this.lastInbound.get(sessionId);
    const expired = last ? Date.now() - last.at >= CUSTOMER_WINDOW_MS : false;

    // Sin registro de entrante (por ejemplo tras un reinicio) se intenta igual:
    // la ventana puede estar abierta y quien manda la última palabra es Meta.
    if (!expired) {
      try {
        await this.client.sendText(to, text);
        return;
      } catch (error) {
        if (!(error instanceof WhatsAppCloudError) || !error.windowClosed) throw error;
        this.log.info(`ventana cerrada para ${to} según Meta`);
      }
    }

    await this.sendOutsideWindow(to, text);
  }

  async sendAudio(sessionId: string, audio: Buffer, mimeType: string): Promise<void> {
    await this.client.sendAudio(this.toRecipient(sessionId), audio, mimeType);
  }

  /** Muestra "escribiendo…". Meta lo apaga al responder o a los 25 segundos. */
  async startTyping(sessionId: string): Promise<void> {
    const last = this.lastInbound.get(sessionId);
    if (!last) return;
    await this.client.markRead(last.messageId, { typing: true }).catch(() => {});
  }

  /** No hace falta apagarlo: responder ya lo apaga. */
  async stopTyping(_sessionId: string): Promise<void> {}

  async markAsRead(sessionId: string, messageId?: string): Promise<void> {
    const id = messageId ?? this.lastInbound.get(sessionId)?.messageId;
    if (!id) return;
    await this.client.markRead(id).catch(() => {});
  }

  getState(): WhatsAppCloudState {
    return { ...this.state };
  }

  getConfig(): WhatsAppCloudConfig {
    return { ...this.config };
  }

  private async ingest(message: WhatsAppInbound): Promise<void> {
    if (!message.id || this.seen.has(message.id)) return;
    this.remember(message.id);

    if (!this.isUserAllowed(message.from)) {
      this.log.info(`mensaje descartado, ${message.from} no está en la lista permitida`);
      return;
    }

    const sessionId = this.formatSessionId(message.from, "direct");
    this.lastInbound.set(sessionId, { at: Date.now(), messageId: message.id });

    const incoming: IncomingMessage = {
      sessionId,
      channel: this.name,
      accountId: this.accountId,
      peerId: message.from,
      peerKind: "direct",
      content: message.text ?? "",
      metadata: {
        messageId: message.id,
        timestamp: message.timestamp,
        pushName: message.profileName,
        type: message.type,
        ...(message.referral ? { referral: message.referral } : {}),
        ...(message.interactive ? { interactive: message.interactive } : {}),
      },
    };

    if (message.media?.id && message.mediaKind) {
      try {
        const media = await this.client.downloadMedia(message.media.id);
        if (message.mediaKind === "audio") {
          incoming.audio = { buffer: media.buffer, mimeType: media.mimeType };
          if (!incoming.content) incoming.content = "[Audio message]";
        } else if (message.mediaKind === "image" || message.mediaKind === "sticker") {
          incoming.image = {
            buffer: media.buffer,
            mimeType: media.mimeType,
            caption: message.media.caption,
          };
        } else if (message.mediaKind === "document") {
          incoming.document = {
            buffer: media.buffer,
            mimeType: media.mimeType,
            fileName: message.media.fileName ?? media.fileName,
          };
        }
      } catch (error) {
        this.log.warn(`no se pudo bajar el medio ${message.media.id}: ${(error as Error).message}`);
      }
    }

    if (!incoming.content && !incoming.audio && !incoming.image && !incoming.document) {
      this.log.debug(`mensaje ${message.id} de tipo ${message.type} sin contenido utilizable`);
      return;
    }

    // Acuse de recibo inmediato: el doble tilde y el "escribiendo…" son lo que
    // le dice a la persona que su mensaje llegó, aunque la respuesta demore.
    void this.client.markRead(message.id, { typing: true }).catch(() => {});

    await this.handleMessage(incoming);
  }

  private async sendOutsideWindow(to: string, text: string): Promise<void> {
    const template = this.config.windowFallbackTemplate;
    if (!template) {
      throw new WhatsAppCloudError(
        400,
        131047,
        "Pasaron más de 24 h desde el último mensaje del cliente: Meta sólo acepta " +
          "una plantilla aprobada. Configurá `windowFallbackTemplate` en el canal."
      );
    }
    this.log.info(`fuera de la ventana: se manda la plantilla "${template.name}" en vez del texto`);
    this.log.debug(`texto no enviado: ${text.slice(0, 120)}`);
    await this.client.sendTemplate(to, template);
  }

  /** El sessionId es el `wa_id`; se tolera un prefijo por si alguien lo compone. */
  private toRecipient(sessionId: string): string {
    const parts = sessionId.split(":");
    return (parts[parts.length - 1] ?? "").replace(/\D/g, "");
  }

  private remember(messageId: string): void {
    this.seen.add(messageId);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
  }

  private async setStatus(status: WhatsAppCloudState["status"]): Promise<void> {
    this.state.status = status;
    try {
      await updateDoc<ChannelDoc>("channels", this.accountId, {
        status,
        last_active: Date.now(),
      });
    } catch {
      // Sin base no se pierde nada: el estado en memoria ya quedó bien.
    }
  }
}

export function createWhatsAppCloudChannel(config: WhatsAppCloudConfig): WhatsAppCloudChannel {
  return new WhatsAppCloudChannel(config);
}
