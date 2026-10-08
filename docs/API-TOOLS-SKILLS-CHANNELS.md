# API Reference — Tools, Skills, MCP, Gateway, Channels y Storage

## Índice

1. [Tools](#tools)
2. [Skills](#skills)
3. [MCP](#mcp)
4. [Gateway](#gateway)
5. [Channels](#channels)
6. [Tool Runtime](#tool-runtime)
7. [Canvas](#canvas)
8. [Storage](#storage)
9. [Config](#config)

---

## Tools

### defineTool

Función para definir herramientas que el agente puede invocar.

```typescript
import { defineTool } from "@johpaz/hive-sdk";

const tool = defineTool({
  name: "saludar",
  description: "Saluda a alguien por su nombre",
  execute: async (args: { nombre: string }) => {
    return { mensaje: `¡Hola ${args.nombre}!` };
  },
});
```

### ToolRegistry

Registro central de herramientas.

```typescript
import { ToolRegistry, defineTool } from "@johpaz/hive-sdk";

const reg = new ToolRegistry();

reg.register(defineTool({ name: "t1", description: "...", execute: async () => ({}) }));

reg.has("t1");              // true
reg.get("t1");              // ToolDefinition
reg.list();                 // ToolDefinition[]
reg.getByCategory("web");   // Filtrar por categoría
reg.getNames();             // ["t1"]
reg.size();                 // 1
reg.merge(otherRegistry);
reg.clear();
```

### ToolExecutor

Ejecutor de herramientas con validación Zod.

```typescript
import { ToolRegistry, ToolExecutor, defineTool } from "@johpaz/hive-sdk";

const reg = new ToolRegistry();
reg.register(defineTool({
  name: "echo",
  description: "Echo",
  execute: async (args) => args,
}));

const exec = new ToolExecutor(reg);
const result = await exec.execute("echo", { msg: "hola" });
```

### Tool Selection (BM25)

```typescript
import { selectTools, CORE_TOOL_CATALOG } from "@johpaz/hive-sdk";

const tools = selectTools("Buscar archivos en el proyecto");
const webTools = tools.filter(t => t.category === "web");
```

### Built-in Web + API Tools

El SDK expone herramientas web/browser listas para usar:

```typescript
import {
  webSearchTool,
  webFetchTool,
  apiRequestTool,
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserExtractTool,
  browserScriptTool,
  browserWaitTool,
} from "@johpaz/hive-sdk";
```

#### Browser automation (`Bun.WebView`)

Las herramientas `browser_*` hablan con `BrowserBackend`, que hoy tiene una sola
implementación: `Bun.WebView` in-process sobre un Chromium del sistema. No se
instala ni se descarga nada — sólo hace falta un Chromium (o `BUN_CHROME_PATH`)
y **Bun ≥ 1.4.2**, porque es el que lanza el navegador con `--headless` y permite
correr en un servidor sin pantalla.

> Antes existía un segundo backend por CLI (`agent-browser`). Se retiró: medido
> en Bun 1.4.2 el WebView sí corre headless, que era la única razón para
> mantenerlo, y lo que quedaba era su costo —~40 ms de `Bun.spawn` por operación
> contra ~0,3 ms, ~88 MB con su propia copia de Chrome, y un
> `bun add agent-browser@latest` ejecutado **en el entorno del consumidor** al
> primer uso. La clave de configuración `tools.browser.backend` sobrevive:
> `"agent-browser"` se acepta, avisa una vez y usa el WebView.

Las cookies se guardan y restauran a mano (`tools/web/browser-session.ts`)
porque el perfil de Chrome que abre Bun es efímero: sin eso, cada reinicio
empezaría sin sesiones iniciadas. Se controla con `tools.browser.persistSession`.

```typescript
import { initializeBrowserService, getBrowserService } from "@johpaz/hive-sdk/tools";

const browserService = initializeBrowserService(config);
const view = await browserService.getView();
await view.navigate("https://example.com");
const snapshot = await view.snapshot({ compact: true, depth: 3 });
```

#### API del backend de navegador

Todo esto sale de `@johpaz/hive-sdk/tools`.

| | |
|---|---|
| `initializeBrowserService(config)` | Arranca el servicio. Las browser tools están en el catálogo desde el seed pero no operan hasta que alguien lo levanta. |
| `getBrowserService()` | La instancia viva, o `null`. |
| `shutdownBrowser()` | Cierra la vista y libera el proceso del navegador. |
| `isWebViewSupported()` | Si este entorno puede abrir un navegador. **Ojo**: comprueba que exista un binario de Chromium, no que arranque — en un contenedor sin sandbox el binario está y Chromium muere igual. |
| `findChrome()` | Dónde está el Chromium que se va a usar. |
| `resolveBackendKind(pref)` | Traduce `tools.browser.backend` a un backend real. Acepta `"agent-browser"` por compatibilidad: avisa una vez y devuelve WebView. |
| `resolveWebViewEngine(pref)` | `chrome` (con CDP, headless real) o el WebKit del sistema en macOS, que no tiene CDP y por eso ofrece menos. |
| `browserInstallHint()` | Qué decirle a alguien que no tiene navegador instalado. |

Helpers sobre una vista abierta: `waitForSelector` · `waitForCondition` ·
`screenshotElement` · `clicEnPunto` · `hoverEnPunto` — los dos últimos operan por
coordenadas, que es lo que usa `computer_use_task` cuando no hay un selector CSS
estable (canvas, UIs generadas, visores embebidos).

`reducirCaptura` y `podarCapturas` recortan las capturas antes de que lleguen al
modelo. Una captura de pantalla completa son cientos de miles de tokens si viaja
en crudo; ver también `@johpaz/hive-sdk/images`, que hace lo propio con las
imágenes que manda el usuario.

#### Sesión del navegador

El perfil de Chrome que abre Bun es **efímero** —su ruta lleva un hash que cambia
entre procesos— así que las cookies se guardan y restauran a mano. Sin esto, cada
reinicio empezaría sin ninguna sesión iniciada y el agente tendría que volver a
autenticarse en todos lados.

| | |
|---|---|
| `sessionPersistenceEnabled()` | Si está activo (`tools.browser.persistSession`, encendido por defecto). |
| `storeCookies(cookies)` / `loadStoredCookies()` | Guardar y restaurar. Van cifradas, como cualquier otro secreto. |
| `normalizeCookies(raw)` | Normaliza lo que devuelve CDP a una forma estable. |
| `clearStoredSession()` | Cerrar la sesión: olvida los logins guardados. |

#### api_request

Conecta APIs REST con autenticación y métodos HTTP:

```typescript
const result = await apiRequestTool.execute({
  method: "POST",
  url: "https://api.example.com/items",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.API_TOKEN}`,
  },
  body: JSON.stringify({ name: "example" }),
  query_params: { verbose: "1" },
  timeout_ms: 30000,
});

// → { ok, status, statusText, headers, body, contentType, url }
// `body` viene parseado si la respuesta es JSON, y como string si no.
```

Nunca lanza: un fallo de red o un método inválido vuelven como
`{ ok: false, error }`. No tiene helpers de autenticación — la credencial va
como un header más.

---

## Skills

### defineSkill

```typescript
import { defineSkill } from "@johpaz/hive-sdk";

const skill = defineSkill({
  name: "file-manager",
  description: "Gestiona archivos y directorios",
  steps: [
    { action: "fs_list", instruction: "Listar archivos" },
    { action: "fs_read", instruction: "Leer archivo" },
  ],
  tools: ["fs_list", "fs_read"],
  triggers: ["archivo", "directorio", "listar"],
});
```

### SkillLoader

```typescript
import { SkillLoader } from "@johpaz/hive-sdk";

const loader = new SkillLoader({
  allowBundled: ["file-manager", "web-researcher"],
  managedDir: "./skills",
});

const skills = loader.list();
const skill = loader.get("file-manager");
```

### Skills empaquetadas

El SDK incluye 23 skills empaquetadas. Algunas útiles para web y APIs:

- `web_research` — búsqueda y síntesis con `web_search` + `web_fetch`.
- `browser_scrape` — captura de contenido renderizado con screenshots.
- `browser_automate` — automatización de flujos web (clicks, formularios).
- `api_client` — consumo de APIs REST con `api_request`.
- `capability_discovery` — la skill mínima: enseña al agente a encontrar el resto.

Se generan desde los `SKILL.md` de `packages/core/src/skills/bundled/`:

```bash
bun run skills:bundle
```

En 0.1.5 se retiraron 21 skills que invocaban tools inexistentes (`voice_*`,
`meeting_transcription`, `canvas_*`, `code_*`, `project_*`): el selector se las
podía ofrecer al modelo y la ejecución moría sin ejecutor. Hay un test que falla
si alguna vuelve a declarar una tool que no está en el registry.

---

## MCP

Model Context Protocol — herramientas externas via STDIO/SSE/WebSocket.

### MCPClientManager

```typescript
import { MCPClientManager } from "@johpaz/hive-sdk";

const mcp = new MCPClientManager({
  servers: {
    "filesystem": {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./data"],
      enabled: true,
    },
    "weather-api": {
      transport: "sse",
      url: "https://api.weather.com/mcp",
      enabled: true,
    },
  },
});

await mcp.initialize();
const tools = mcp.getTools("filesystem");
```

### Transports

```typescript
import { createTransport, SSETransport, WebSocketTransport } from "@johpaz/hive-sdk";

const transport = createTransport({
  type: "stdio",
  stdio: { command: "npx", args: ["-y", "server"], env: {} },
});
```

---

## Gateway

Servidor HTTP/WebSocket simplificado para exponer el agente como API.

### startGateway

```typescript
import { startGateway } from "@johpaz/hive-sdk";

const server = await startGateway({
  host: "127.0.0.1",
  port: 18790,
  agentId: "coordinator",
  mcpManager: null,
});

console.log(`Gateway at http://127.0.0.1:18790`);
```

### Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/status` | Health check |
| POST | `/chat` | Chat con el agente |
| WS | `/ws` | WebSocket streaming |

### Ejemplo: Chat HTTP

```typescript
const res = await fetch("http://127.0.0.1:18790/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Hello!", threadId: "t1" }),
});

const data = await res.json();
console.log(data.response);
```

---

## Channels

Integraciones con plataformas de mensajería.

### ChannelManager

```typescript
import { ChannelManager } from "@johpaz/hive-sdk";

const manager = new ChannelManager(config);
await manager.initialize();
```

### Canales soportados

```typescript
import {
  TelegramChannel,
  DiscordChannel,
  WhatsAppCloudChannel,
  WhatsAppChannel,
  SlackChannel,
  WebChatChannel,
} from "@johpaz/hive-sdk";

// Telegram
const telegram = new TelegramChannel({ botToken: process.env.TELEGRAM_BOT_TOKEN! });

// Discord
const discord = new DiscordChannel({ botToken: process.env.DISCORD_BOT_TOKEN! });

// WhatsApp por la API oficial de Meta — el camino para un negocio
const whatsapp = new WhatsAppCloudChannel({
  enabled: true,
  accountId: "ventas",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  appSecret: process.env.WHATSAPP_APP_SECRET!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
  dmPolicy: "open",
  allowFrom: [],
});

// WhatsApp por código QR (Baileys). No es oficial: uso personal.
const whatsappQr = new WhatsAppChannel();

// Slack
const slack = new SlackChannel({ botToken: process.env.SLACK_BOT_TOKEN! });

// Webchat
const webchat = new WebChatChannel();
```

### WhatsApp: cuál de los dos

| | `whatsapp_cloud` | `whatsapp` |
|---|---|---|
| Qué es | La API oficial de Meta (Cloud API) | Baileys, WhatsApp Web por código QR |
| Para quién | Un negocio: número de WhatsApp Business propio, plantillas de marketing y atribución de los anuncios que abren la conversación | Uso personal |
| Riesgo | Ninguno: es el camino soportado | Va contra los términos de WhatsApp; el número puede terminar bloqueado |
| Cómo recibe | Webhook: hace falta una URL HTTPS pública | Conexión propia, sin URL pública |

El canal oficial no abre ninguna conexión: Meta empuja los mensajes a una URL.
El gateway la sirve en `/webhooks/whatsapp-cloud/<cuenta>` si se le pasa el
manager, y esa es la que se registra en el panel de Meta junto con el
`verifyToken`.

```typescript
const channelManager = new ChannelManager(await loadConfig());
await channelManager.initialize();

// Sin esto, el gateway no tiene a quién entregarle lo que manda Meta.
await startGateway({ channelManager });
```

Tres cosas que conviene saber antes de ponerlo en producción:

- **La ventana de 24 h.** Pasado ese tiempo desde el último mensaje del cliente,
  Meta sólo acepta plantillas aprobadas (error 131047). Con
  `windowFallbackTemplate` el canal manda esa plantilla; sin ella, lanza un
  error que lo explica en vez de fallar en silencio.
- **Cada mensaje se cobra.** Desde el 1 de octubre de 2026 los mensajes de
  servicio dentro de la ventana también se pagan, así que la narración de
  progreso del agente no se envía salvo que se encienda `sendProgress`. En su
  lugar se renueva el "escribiendo…", que es gratis.
- **4096 caracteres por mensaje.** El cliente parte las respuestas largas solo,
  cortando entre párrafos.

La versión del Graph sale de `META_GRAPH_API_VERSION` (por defecto la estable
más reciente). Conviene fijarla a conciencia: cada versión caduca a los ~2 años
y Meta redirige las llamadas a la más vieja que siga viva, sin avisar.

---

## Tool Runtime

Ejecución paralela de herramientas vía Bun Workers.

### executeToolBatch

```typescript
import { executeToolBatch, shutdownToolRuntime } from "@johpaz/hive-sdk";

const results = await executeToolBatch({
  toolCalls: [
    { id: "1", function: { name: "search", arguments: JSON.stringify({ q: "AI" }) } },
    { id: "2", function: { name: "fetch", arguments: JSON.stringify({ url: "..." }) } },
  ],
  allTools: [searchTool, fetchTool],
  toolConfig: { user_id: "u1", thread_id: "t1" },
  hiveConfig: loadConfig(),
  workerPool: {
    enabled: true,
    maxWorkers: 4,
    toolTimeoutMs: 30000,
    parallelToolCalls: true,
  },
});

// Limpieza
shutdownToolRuntime();
```

### ToolBatchResult

```typescript
interface ToolBatchResult {
  toolCall: ToolCallLike;
  toolName: string;
  result: unknown;
  ok: boolean;
  durationMs: number;
  error?: SerializedError;
  timedOut?: boolean;
  aborted?: boolean;
}
```

---

## Canvas

Visualización en tiempo real del estado de agentes.

```typescript
import { emitCanvas, subscribeCanvas, unsubscribeCanvas } from "@johpaz/hive-sdk";

const handler = (data: any) => console.log("Canvas:", data);
subscribeCanvas(handler);

emitCanvas("canvas:node_update", {
  nodeId: "agent-1",
  changes: { status: "running", currentTool: "web_search" },
});

unsubscribeCanvas(handler);
```

---

## Storage

HiveDB (`@johpaz/hive-db` 0.6.1 o posterior), un motor embebido con colecciones
de documentos e índice BM25. Reemplazó a SQLite + FTS5 en 0.1.5.

```typescript
import { ensureHiveDb, col } from "@johpaz/hive-sdk";
import type { AgentDoc } from "@johpaz/hive-sdk";

// Abre la base, crea los índices y siembra el catálogo. Idempotente.
await ensureHiveDb();

const agents = await col<AgentDoc>("agents");

const one = await agents.get(agentId);          // { id, doc, version } | undefined
const workers = await agents.findBy("role", "worker");
const all = await agents.scan({});
const scoped = await agents.scan({ prefix: `${threadId}:` });

// Escritura con concurrencia optimista
await agents.put(agentId, { ...one.doc, status: "idle" }, { expectedVersion: one.version });
```

`HIVE_DB_PATH=":memory:"` abre una base efímera — es lo que usa la suite de
tests para no tocar la del usuario.

### Búsqueda de capacidad

El índice BM25 es lo que hace funcionar a `search_knowledge`: el agente arranca
con un loadout mínimo y descubre el resto en runtime.

```typescript
import { selectTools, selectSkills } from "@johpaz/hive-sdk";

const tools = await selectTools("leer un archivo del workspace");
const skills = await selectSkills("investigar en la web");
```

El reindexado de arranque es incremental: el SDK guarda un hash por documento
(colección `capability_sync`) y solo reescribe lo que cambió o desapareció, así
que un arranque con el catálogo igual no toca el índice.

> **Búsqueda por significado.** Opcional y apagada por defecto; mide poco sobre
> BM25 con el catálogo de tools. Cuándo activarla y qué cuesta, en
> [HIVEDB.md](./HIVEDB.md).

Una tool declarada con `defineTool` y pasada a `createAgent` queda indexada
automáticamente, así que el modelo puede descubrirla igual que a las nativas.

### Catálogo compartido entre inquilinos

En un host multi-inquilino (varios enjambres en una sola HiveDB, ver
`runInTenant`) el catálogo —`tools`, `skills` y `ethics`— es contenido de la
INSTALACIÓN, no de cada inquilino: su contenido se instala una sola vez en la
colección sin prefijo, y cada inquilino guarda únicamente lo que activó.

```typescript
import { col, runInTenant, setCatalogActivation } from "@johpaz/hive-sdk";

// Sin inquilino: esto instala el catálogo, una vez para todos.
await ensureHiveDb();

await runInTenant(tenantKey, async () => {
  const tools = await col<ToolDoc>("tools");
  await tools.scan({});                              // ve el catálogo entero

  // Encender una tool para ESTE inquilino: guarda su elección, no una copia.
  await setCatalogActivation("tools", "web_search", { active: true });
});
```

Lo que el inquilino crea —la tool de un endpoint de API, una skill propia— se
escribe en su partición y no lo ve nadie más. Editar el contenido de una fila del
catálogo deja una copia privada; borrarla la oculta sólo para él. Sin inquilino
en scope nada de esto se activa y `col()` se comporta como siempre.

---

## Config

```typescript
import { loadConfig, loadEnv, getHiveDir } from "@johpaz/hive-sdk";

const config = await loadConfig();
const hiveDir = getHiveDir();  // ~/.hive o HIVE_DATA_DIR
```

---

*Documentación Hive SDK — ver `version` en package.json*
