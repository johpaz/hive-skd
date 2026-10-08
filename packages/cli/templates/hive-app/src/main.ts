#!/usr/bin/env bun

import {
  startGateway,
  ensureHiveDb,
  closeHiveDb,
  ChannelManager,
  loadConfig,
  logger,
} from "@johpaz/hive-sdk";
import { flushTraces } from "@johpaz/hive-sdk/agent";
import { coordinatorAgent } from "./agents/coordinator";
import config from "../hive.config";

const log = logger.child("app");

async function main() {
  log.info(`Starting {{APP_NAME}}...`);

  // Abre HiveDB, crea los índices y siembra el catálogo de providers y modelos.
  // Es idempotente: correrlo en cada arranque es cómo se actualiza el catálogo.
  await ensureHiveDb();

  log.info(`Agent ready: ${coordinatorAgent.name}`);

  // Initialize channels. `loadConfig()` mezcla los defaults del SDK con
  // hive.config.ts y el entorno; `config` sólo tiene lo que declaraste vos.
  const channelManager = new ChannelManager(await loadConfig());
  await channelManager.initialize();

  // Start the gateway
  const gateway = await startGateway({
    host: config.gateway?.host,
    port: config.gateway?.port,
    agentId: coordinatorAgent.id,
    // Los canales que reciben por webhook —WhatsApp por la API oficial de
    // Meta— entran por el gateway, así que necesita el manager.
    channelManager,
  });

  log.info(`{{APP_NAME}} is running at http://${gateway.hostname}:${gateway.port}`);

  // Graceful shutdown. Cerrar HiveDB limpio deja guardados el grafo y el índice
  // de texto: la próxima apertura tarda milisegundos en vez de reconstruirlos.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log.info("Shutting down...");
    gateway.stop(true);
    await flushTraces().catch(() => {});
    closeHiveDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Fatal error:", err);
  process.exit(1);
});
