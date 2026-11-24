export { startGateway } from "./server";
export type { GatewayConfig } from "./server";

// Salida hacia el usuario: la app conecta su ChannelManager con setChannelManager().
export { setChannelManager, getChannelManager, notifyChannel, sendToUserChannel, sendFileToUserChannel, broadcastNotification, type ChannelSender, type OutboundFile } from "./channel-notify";
