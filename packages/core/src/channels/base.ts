import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { readArtifactBytes } from "../artifacts/store";

/**
 * Resuelve un OutboundMessage.document a bytes + nombre para los canales que suben el
 * archivo directamente. Prefiere el artifact, luego la ruta en disco y al final el base64.
 */
export async function readOutboundDocument(
  doc: NonNullable<OutboundMessage["document"]>,
): Promise<{ bytes: Buffer; filename: string; mimeType: string } | null> {
  const filename = doc.filename || (doc.path ? basename(doc.path) : "documento");
  if (doc.artifactId) {
    const artifact = await readArtifactBytes(doc.artifactId);
    if (artifact) return { bytes: artifact.bytes, filename, mimeType: doc.mimeType || artifact.mimeType };
  }
  if (doc.path && existsSync(doc.path)) {
    return { bytes: readFileSync(doc.path), filename, mimeType: doc.mimeType || "application/octet-stream" };
  }
  if (doc.base64) return { bytes: Buffer.from(doc.base64, "base64"), filename, mimeType: doc.mimeType || "application/octet-stream" };
  return null;
}

export interface OutboundMessage {
  type: "message" | "stream" | "status" | "error" | "pong" | "command_result" | "log" | "typing" | "audio" | "process" | "progress" | "notification";
  sessionId: string;
  id?: string; // Message ID for streaming
  messageId?: string;
  content?: string;
  chunk?: string;
  isChunk?: boolean; // True if this is a streaming chunk
  isLast?: boolean;
  isStep?: boolean;
  processKind?: "analysis" | "tool" | "observation" | "writing";
  processStatus?: "thinking" | "done" | "error";
  label?: string;
  detail?: string;
  summary?: string;
  stepType?: "plan" | "tool_call" | "tool_result" | "text";
  audio?: {
    buffer?: Buffer;
    base64?: string;
    mimeType?: string;
  };
  /** Archivo para el usuario (Word, Excel, PDF…). `artifactId` o `path` los leen los canales del servidor; `url` es para la web. */
  document?: {
    artifactId?: string;
    path?: string;
    url?: string;
    base64?: string;
    mimeType?: string;
    filename?: string;
    caption?: string;
  };
  status?: {
    state: string;
    model?: string;
    tokens?: number;
  };
  error?: string;
  result?: unknown;
  notificationId?: string;
  createdAt?: number;
  logEntry?: {
    timestamp: string;
    level: string;
    source: string;
    message: string;
    meta?: Record<string, unknown>;
  };
}

export interface IncomingMessage {
  sessionId: string;
  channel: string;
  accountId: string;
  peerId: string;
  peerKind: "direct" | "group";
  content: string;
  audio?: {
    buffer?: Buffer;
    url?: string;
    base64?: string;
    mimeType?: string;
  };
  image?: {
    url?: string;
    base64?: string;
    buffer?: Buffer;
    mimeType?: string;
    caption?: string;
  };
  document?: {
    url?: string;
    base64?: string;
    buffer?: Buffer;
    mimeType?: string;
    fileName?: string;
  };
  metadata?: Record<string, unknown>;
  replyToId?: string;
}

export interface ChannelConfig {
  enabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist";
  allowFrom: string[];
}

export interface IChannel {
  name: string;
  accountId: string;
  config: ChannelConfig;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(sessionId: string, message: OutboundMessage): Promise<void>;
  sendAudio?(sessionId: string, audio: Buffer, mimeType: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
  isRunning(): boolean;
  startTyping?(sessionId: string): Promise<void>;
  stopTyping?(sessionId: string): Promise<void>;
  markAsRead?(sessionId: string, messageId?: string): Promise<void>;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

export abstract class BaseChannel implements IChannel {
  abstract name: string;
  abstract accountId: string;
  abstract config: ChannelConfig;

  protected messageHandler?: MessageHandler;
  protected running = false;
  protected typingIntervals: Map<string, Timer> = new Map();

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(sessionId: string, message: OutboundMessage): Promise<void>;

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  isRunning(): boolean {
    return this.running;
  }

  async startTyping(_sessionId: string): Promise<void> {
    // Default: no-op, override in subclasses
  }

  async stopTyping(sessionId: string): Promise<void> {
    const interval = this.typingIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(sessionId);
    }
  }

  async markAsRead(_sessionId: string, _messageId?: string): Promise<void> {
    // Default: no-op, override in subclasses
  }

  protected async handleMessage(message: IncomingMessage): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(message);
    }
  }

  protected isUserAllowed(peerId: string): boolean {
    if (this.config.dmPolicy === "open") {
      return true;
    }

    const normalizedPeerId = `${this.name}:${peerId}`;

    if (this.config.dmPolicy === "allowlist") {
      return this.config.allowFrom.some(
        (allowed) => allowed === peerId || allowed === normalizedPeerId
      );
    }

    if (this.config.dmPolicy === "pairing") {
      return this.config.allowFrom.some(
        (allowed) => allowed === peerId || allowed === normalizedPeerId
      );
    }

    return false;
  }

  protected formatSessionId(peerId: string, _kind: "direct" | "group"): string {
    return peerId;
  }
}
