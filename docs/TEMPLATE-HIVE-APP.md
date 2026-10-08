# Template `hive-app` — Documentación Completa

El template `hive-app` genera una **aplicación harness completa** lista para ejecutar. Incluye gateway HTTP/WebSocket, agente coordinador, configuración de canales, base de datos HiveDB, y deployment con Docker.

---

## Generar una app

```bash
hives create-app my-hive
```

Esto crea el directorio `my-hive/` con la estructura completa.

---

## Estructura generada

```
my-hive/
├── package.json              # Dependencias y scripts
├── hive.config.ts            # Configuración del harness
├── docker-compose.yml        # Deployment con Docker
├── .env.example              # Variables de entorno de ejemplo
├── .gitignore                # Archivos ignorados por git
└── src/
    ├── main.ts               # Entry point — arranca gateway + agente
    └── agents/
        └── coordinator.ts    # Definición del agente coordinador
```

---

## Archivos y opciones

### `package.json`

```json
{
  "name": "my-hive",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun run src/main.ts",
    "start": "bun run src/main.ts",
    "build": "bun build src/main.ts --outdir dist --target bun"
  },
  "dependencies": {
    "@johpaz/hive-sdk": "latest"
  }
}
```

| Script | Comando | Descripción |
|--------|---------|-------------|
| `dev` | `bun run src/main.ts` | Ejecutar en desarrollo |
| `start` | `bun run src/main.ts` | Ejecutar en producción |
| `build` | `bun build ...` | Compilar a `dist/` |

---

### `hive.config.ts`

Configuración central del harness.

```typescript
import type { Config } from "@johpaz/hive-sdk";

export default {
  name: "my-hive",
  gateway: {
    host: process.env.HIVE_HOST ?? "127.0.0.1",
    port: Number(process.env.HIVE_PORT ?? 18790),
  },
  channels: {
    webchat: { enabled: true },    // Siempre habilitado
    telegram: { enabled: false },  // Requiere TELEGRAM_BOT_TOKEN
    discord: { enabled: false },   // Requiere DISCORD_BOT_TOKEN
    whatsapp: { enabled: false },  // Requiere configuración adicional
    slack: { enabled: false },     // Requiere SLACK_BOT_TOKEN
  },
  database: {
    path: process.env.HIVE_DATA_DIR ?? "./data/hive.db",
  },
} satisfies Config;
```

#### Opciones de configuración

| Opción | Tipo | Default | Descripción |
|--------|------|---------|-------------|
| `name` | `string` | `"my-hive"` | Nombre de la aplicación |
| `gateway.host` | `string` | `"127.0.0.1"` | Host del gateway |
| `gateway.port` | `number` | `18790` | Puerto del gateway |
| `channels.webchat.enabled` | `boolean` | `true` | Canal webchat integrado |
| `channels.telegram.enabled` | `boolean` | `false` | Bot de Telegram |
| `channels.discord.enabled` | `boolean` | `false` | Bot de Discord |
| `channels.whatsapp.enabled` | `boolean` | `false` | Bot de WhatsApp |
| `channels.slack.enabled` | `boolean` | `false` | Bot de Slack |
| `database.path` | `string` | `"./data/hive"` | Ruta de la base de datos HiveDB |

---

### `src/main.ts`

Entry point de la aplicación. Realiza:

1. Inicializa la base de datos (`ensureHiveDb`, que además siembra el catálogo)
2. Crea el agente coordinador (`createAgent`)
3. Inicializa el ChannelManager
4. Arranca el gateway (`startGateway`)
5. Maneja shutdown graceful (`SIGINT` y `SIGTERM`): vacía las trazas y cierra HiveDB limpio, para que la próxima apertura tarde milisegundos

```typescript
import {
  createAgent,
  startGateway,
  ensureHiveDb,
  ChannelManager,
  logger,
} from "@johpaz/hive-sdk";
import config from "../hive.config.ts";

const log = logger.child("app");

async function main() {
  log.info(`Starting my-hive...`);

  await ensureHiveDb();

  const agent = await createAgent({
    name: "coordinator",
    provider: "openai",
    model: "gpt-5.6-luna",
    systemPrompt: "You are a helpful AI assistant...",
  });

  const channelManager = new ChannelManager();
  // TODO: configure channels from hive.config.ts

  const gateway = await startGateway({
    host: config.gateway?.host,
    port: config.gateway?.port,
    agentId: "coordinator",
  });

  log.info(`my-hive is running at http://${gateway.hostname}:${gateway.port}`);
}

main().catch((err) => {
  log.error("Fatal error:", err);
  process.exit(1);
});
```

#### Personalizar el agente

Puedes cambiar el `provider`, `model`, y `systemPrompt`:

```typescript
const agent = await createAgent({
  name: "coordinator",
  provider: "anthropic",        // cualquiera de los 16 del catálogo
  model: "claude-3-5-sonnet-20241022",
  systemPrompt: "Tu system prompt personalizado...",
});
```

#### Añadir tools al agente

```typescript
import { defineTool } from "@johpaz/hive-sdk";

const searchTool = defineTool({
  name: "search",
  description: "Search the web",
  execute: async (args: { query: string }) => {
    // Implementation
    return { results: [] };
  },
});

const agent = await createAgent({
  name: "coordinator",
  provider: "openai",
  model: "gpt-5.6-luna",
  tools: [searchTool],
});
```

---

### `src/agents/coordinator.ts`

Definición standalone del agente coordinador. Puedes importarlo desde `main.ts` o usarlo directamente.

```typescript
import { createAgent } from "@johpaz/hive-sdk";

export const coordinatorAgent = await createAgent({
  name: "coordinator",
  provider: "openai",
  model: "gpt-5.6-luna",
  systemPrompt: "You are the coordinator agent...",
});
```

---

### `docker-compose.yml`

Deployment containerizado.

```yaml
services:
  app:
    image: oven/bun:latest
    working_dir: /app
    volumes:
      - .:/app
      - hive-data:/app/data
    ports:
      - "${HIVE_PORT:-18790}:18790"
    environment:
      - HIVE_HOST=0.0.0.0
      - HIVE_PORT=18790
      - HIVE_DATA_DIR=/app/data
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    command: ["bun", "run", "src/main.ts"]
    restart: unless-stopped

volumes:
  hive-data:
```

#### Deployment

```bash
# Copiar variables de entorno
cp .env.example .env
# Editar .env con tus API keys

# Levantar con Docker
docker compose up -d

# Ver logs
docker compose logs -f
```

---

### `.env.example`

Variables de entorno disponibles:

```bash
# Hive Harness Configuration
HIVE_HOST=127.0.0.1
HIVE_PORT=18790
HIVE_DATA_DIR=./data

# LLM Providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...

# Channels (enable as needed)
TELEGRAM_BOT_TOKEN=
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=

# Logging
LOG_LEVEL=info
```

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `HIVE_HOST` | No | Host del gateway |
| `HIVE_PORT` | No | Puerto del gateway |
| `HIVE_HOME` | No | Directorio de datos (HiveDB en `<HIVE_HOME>/data`) |
| `OPENAI_API_KEY` | Sí* | API key de OpenAI |
| `ANTHROPIC_API_KEY` | Sí* | API key de Anthropic |
| `GOOGLE_API_KEY` | Sí* | API key de Gemini |
| `TELEGRAM_BOT_TOKEN` | No | Token del bot de Telegram |
| `DISCORD_BOT_TOKEN` | No | Token del bot de Discord |
| `SLACK_BOT_TOKEN` | No | Token del bot de Slack |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` |

\* Al menos una API key de LLM es requerida.

---

## Personalización avanzada

### Añadir canales

```typescript
// src/main.ts
import { TelegramChannel, DiscordChannel } from "@johpaz/hive-sdk";

const channelManager = new ChannelManager(config);

if (config.channels.telegram.enabled) {
  channelManager.register("telegram", new TelegramChannel({
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
  }));
}

if (config.channels.discord.enabled) {
  channelManager.register("discord", new DiscordChannel({
    botToken: process.env.DISCORD_BOT_TOKEN!,
  }));
}

await channelManager.initialize();
```

### Añadir workers especializados

```bash
cd my-hive
hives add-worker researcher
hives add-worker coder
```

Esto genera `src/workers/researcher.worker.ts` y `src/workers/coder.worker.ts`.

### Añadir tools

```bash
cd my-hive
hives add-tool search-docs
```

Genera `src/tools/search-docs.ts`.

### Añadir skills

```bash
cd my-hive
hives add-skill onboarding
```

Genera `src/skills/onboarding.ts`.

---

## Tests del template

El template incluye tests para verificar que la estructura se genera correctamente.

```bash
cd my-hive
bun test
```

---

*Documentación Hive SDK — ver `version` en package.json*
