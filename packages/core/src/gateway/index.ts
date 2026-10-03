export { startGateway } from "./server";
export type { GatewayConfig } from "./server";

// Salida hacia el usuario: la app conecta su ChannelManager con setChannelManager().
export { setChannelManager, getChannelManager, notifyChannel, sendToUserChannel, broadcastNotification, type ChannelSender } from "./channel-notify";
