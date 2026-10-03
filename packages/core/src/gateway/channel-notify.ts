/**
 * Channel Notify — el camino de salida hacia el usuario.
 *
 * Esto era un stub que sólo hacía `console.log`, y estaba en el camino real: la
 * tool `notify`, los reportes de progreso, el aviso de que una tarea programada
 * terminó, el de un turno interrumpido por un crash y el de compactación pasan
 * todos por acá. Es decir, un agente sobre el SDK **no podía hablarle al
 * usuario por ningún canal** — mientras `channels/manager.ts` tenía adaptadores
 * funcionales de Slack, Discord, Telegram y WhatsApp, sin nada que los conectara.
 *
 * El cableado es explícito y opcional: la app registra su `ChannelManager` con
 * `setChannelManager()`. Sin registro se conserva el comportamiento anterior
 * —un log— porque un proceso que no maneja canales (un script, un test) no
 * debería fallar por intentar notificar.
 *
 * Resolver a quién enviar es la otra mitad. `ChannelManager.send` necesita un
 * `sessionId`, que es el contacto o grupo dentro del canal. Se obtiene del
 * `threadId` (`${userId}/${canal}/${peer}`) cuando viene, y si no, buscando la
 * conversación de ese usuario en ese canal. Sin eso el mensaje no sabe a qué
 * chat volver.
 */

import { logger } from "../utils/logger";
import { parseThreadId } from "../agent/thread-id";
import { threadForChannel, listThreads } from "../agent/thread-store";

const log = logger.child("channel-notify");

/** Lo mínimo que se necesita de un ChannelManager, para no atarse a su clase. */
export interface ChannelSender {
  send(channelName: string, sessionId: string, message: unknown, accountId?: string): Promise<void>;
}

let _sender: ChannelSender | null = null;

/**
 * Conecta el manager de canales. Llamalo una vez al arrancar, después de
 * `channelManager.initialize()`.
 */
export function setChannelManager(sender: ChannelSender | null): void {
  _sender = sender;
  log.info(sender ? "canales conectados: las notificaciones salen de verdad" : "canales desconectados");
}

export function getChannelManager(): ChannelSender | null {
  return _sender;
}

/**
 * A qué conversación del canal enviar.
 *
 * El `threadId` ya lleva el peer adentro, así que si viene se usa. Si no, se
 * busca el hilo del usuario en ese canal; y como último recurso se usa el
 * `userId`, que es lo que hacían las instalaciones anteriores a la separación
 * por canal.
 */
async function resolveSessionId(
  channel: string,
  userId: string,
  threadId?: string,
): Promise<string | null> {
  if (threadId) {
    const parts = parseThreadId(threadId);
    if (parts?.peerId) return parts.peerId;
  }
  // `threadForChannel` mira `userIdentities`, que es el registro canónico de
  // "por dónde se alcanza a este usuario".
  const delCanal = await threadForChannel(userId, channel).catch(() => null);
  if (delCanal) {
    const parts = parseThreadId(delCanal);
    if (parts?.peerId) return parts.peerId;
  }

  // Si no hay identidad registrada pero sí una conversación abierta en ese
  // canal, ahí es donde responder: es evidencia igual de válida de dónde está
  // el usuario, y evita perder el aviso por un registro que nadie llenó.
  const hilos = await listThreads(userId, { channel }).catch(() => []);
  const reciente = hilos[0];
  if (reciente) {
    const parts = parseThreadId(reciente.id);
    if (parts?.peerId) return parts.peerId;
  }

  return userId || null;
}

export async function notifyChannel(
  channel: string,
  userId: string,
  message: string,
  opts?: { threadId?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  if (!_sender) {
    // Sin canales conectados no es un error: hay procesos que legítimamente no
    // los tienen. Pero conviene que se note, porque un `notify` que no llega es
    // silencioso por naturaleza.
    log.warn(`sin ChannelManager conectado — el mensaje para ${channel} no sale: ${message.slice(0, 80)}`);
    return;
  }

  const sessionId = await resolveSessionId(channel, userId, opts?.threadId);
  if (!sessionId) {
    log.warn(`no pude resolver a qué conversación de ${channel} enviarle a ${userId}`);
    return;
  }

  await _sender.send(channel, sessionId, message);
}

export async function sendToUserChannel(
  channel: string,
  userId: string,
  message: string,
  opts?: { threadId?: string; metadata?: Record<string, unknown> }
): Promise<{ ok: boolean; error?: string }> {
  try {
    await notifyChannel(channel, userId, message, opts);
    return { ok: true };
  } catch (err) {
    // Un canal caído no debe tumbar el turno que estaba notificando.
    log.warn(`falló el envío a ${channel}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export async function broadcastNotification(
  channels: string[],
  message: string,
  userId = "",
): Promise<void> {
  for (const channel of channels) {
    await notifyChannel(channel, userId, message).catch(() => {});
  }
}
