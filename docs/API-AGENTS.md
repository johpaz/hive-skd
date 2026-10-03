# API Reference — Agentes

## Índice

1. [createAgent](#createagent)
2. [AgentLoop](#agentloop)
3. [Tool Selector](#tool-selector)
4. [Skill Selector](#skill-selector)
5. [LLM Providers](#llm-providers)
6. [Multi-inquilino: credenciales y Jev](#multi-inquilino-credenciales-y-jev)
7. [Jev: plano de decisión](#jev-plano-de-decisión)

---

## createAgent

Función de alto nivel para crear y ejecutar agentes.

### Firma

```typescript
import { createAgent } from "@johpaz/hive-sdk";

const agent = await createAgent(config: AgentConfig): Promise<Agent>
```

### AgentConfig

```typescript
interface AgentConfig {
  name: string;
  model?: string;         // id tal como lo nombra su dueño, ej. "claude-opus-5"
  provider?: Provider;    // cualquiera de los 16 del catálogo
  systemPrompt?: string;
  tools?: ToolDefinition[];                 // Tools custom
  skills?: SkillDefinition[];               // Skills custom
  mcpServers?: Record<string, {             // Servidores MCP
    command?: string;                       // STDIO transport
    url?: string;                           // SSE transport
    args?: string[];
    env?: Record<string, string>;
  }>;
  maxIterations?: number;
  thinking?: "off" | "auto" | "on";         // razonamiento: "on" por defecto, "auto" lo decide Jev por turno
  maxOutputTokens?: number;                 // tope de tokens de salida por llamada
  credentials?: ProviderCredentials;        // llave y URL del provider para este agente
  jev?: JevOption;                          // ver "Jev: plano de decisión"
  seed?: "full" | "minimal";                // catálogo de fábrica que se siembra (por defecto "full")
  browser?: boolean;                        // false: no inicia el navegador (por defecto true)
  workspace?: string;
}
```

**Arranque ligero.** `seed: "minimal"` no crea los especialistas del catálogo y
deja activas solo las tools de arranque más las que declares en `tools`: ni el
modelo ni Jev ven un catálogo que no es tuyo, y el prompt es más corto. Solo
afecta a filas nuevas; lo que un usuario ya activó o apagó en esa base no se
pisa. `browser: false` no inicia Bun.WebView y las tools `browser_*` responden
que el navegador no está disponible (sin la opción, el navegador no se abre
hasta el primer uso).

```typescript
const agent = await createAgent({
  name: "soporte",
  provider: "anthropic",
  model: "claude-opus-5",
  seed: "minimal",
  browser: false,
  tools: [buscarCurso],
});
```

La config **se persiste en la fila del agente**, que es de donde el loop resuelve
provider y modelo en cada turno. Consecuencias que conviene tener presentes:

- `model` exige `provider`: el mismo modelo lo sirven varios providers y la clave
  del catálogo depende de cuál. Sin provider, `createAgent` lanza.
- El modelo tiene que existir en `SEED_DATA.models`, o lanza con el nombre del
  provider al que no pertenece.
- `name` deriva el id del agente (`"Mi Agente"` → `mi_agente`), así que dos
  `createAgent` con el mismo nombre comparten fila e historial.
- Las tools pasadas acá quedan registradas **y** indexadas, así que el modelo
  puede descubrirlas con `search_knowledge` como a las nativas.

> Hasta 0.1.5 `provider`, `model`, `maxIterations`, `skills` y `workspace` se
> aceptaban y se descartaban: el agente corría con lo que hubiera en la base.

### Agent

```typescript
interface Agent {
  readonly name: string;
  readonly config: AgentConfig;

  // Streaming chat
  chat(message: string, opts?: {
    threadId?: string;
    channel?: string;
  }): AsyncGenerator<AgentEvent>;

  // Run to completion (devuelve string final)
  run(task: string, opts?: {
    threadId?: string;
    channel?: string;
  }): Promise<string>;
}
```

### AgentEvent

```typescript
type AgentEvent =
  | { type: "token"; content: string }      // sólo con `stream: true`
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "done"; response: string };
```

#### Streaming por token

```typescript
for await (const ev of agent.chat("resumime esto", { stream: true })) {
  if (ev.type === "token") process.stdout.write(ev.content);   // se va pintando
  if (ev.type === "done") console.log("\n", ev.response);
}
```

Sin `stream: true` el comportamiento es el de siempre: `text` con la respuesta
completa del turno. Los proveedores ya emitían estos deltas, pero hasta 0.3.0
ningún punto de entrada los pasaba, así que la respuesta aparecía de golpe al
terminar.

### Ejemplo

```typescript
import { createAgent, defineTool } from "@johpaz/hive-sdk";

const agent = await createAgent({
  name: "asistente",
  provider: "openai",
  model: "gpt-5.6-luna",
  systemPrompt: "Eres un asistente útil.",
});

// Streaming
for await (const event of agent.chat("Hola!")) {
  if (event.type === "text") process.stdout.write(event.content);
}

// Run to completion
const respuesta = await agent.run("Analiza las ventas del mes");
```

---

## defineTool

Define una herramienta que el agente puede invocar.

```typescript
import { defineTool } from "@johpaz/hive-sdk";

const tool = defineTool({
  name: "saludar",
  description: "Saluda a alguien por su nombre",
  // JSON Schema: es lo que ve el modelo y con lo que se validan los argumentos.
  parameters: {
    type: "object",
    properties: { nombre: { type: "string", description: "Nombre de la persona" } },
    required: ["nombre"],
  },
  execute: async ({ nombre }) => ({ mensaje: `¡Hola ${nombre}!` }),
});
```

Sin `parameters` el modelo ve una tool sin argumentos y no sabe pasarle nada. Si
los argumentos no cumplen el esquema, la tool no corre: el modelo recibe el error
con los parámetros que sí existen y corrige la llamada en la siguiente iteración.
(Hasta 0.5.1 se declaraba con `schema` de zod; desde 0.5.2 ya no existe, ver el
[CHANGELOG](../CHANGELOG.md).)

### ToolDefinition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters?: {                  // JSON Schema de los argumentos
    type: "object";
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  execute: (args: any, config?: any) => Promise<any>;
  category?: string;
}
```

---

## defineSkill

Define una composición de herramientas con triggers semánticos.

```typescript
import { defineSkill } from "@johpaz/hive-sdk";

const skill = defineSkill({
  name: "analisis-datos",
  description: "Analiza datos y genera reportes",
  steps: [
    { action: "web_search", instruction: "Buscar datos relevantes" },
    { action: "create_report", instruction: "Generar reporte" },
  ],
  tools: ["web_search", "create_report"],
  triggers: ["analizar", "reporte", "datos"],
});
```

---

## AgentLoop

Clase de bajo nivel para control directo del bucle del agente.

```typescript
import { AgentLoop, buildAgentLoop } from "@johpaz/hive-sdk";

const loop = buildAgentLoop({ mcpManager });

const stream = loop.stream(
  { messages: [{ role: "user", content: "Hola" }] },
  { configurable: { thread_id: "thread-1" } }
);

for await (const chunk of stream) {
  if (chunk.agent?.messages) {
    console.log(chunk.agent.messages[0].content);
  }
  if (chunk.tools?.messages) {
    console.log("Tool result:", chunk.tools.messages);
  }
}
```

### StreamChunk

```typescript
interface StreamChunk {
  agent?: { messages: any[]; streamed?: boolean };
  tools?: { messages: any[] };
  usage?: { input_tokens: number; output_tokens: number };
  /** Imágenes que produjeron las tools de este turno, como referencias. */
  artifacts?: { images: Array<{ artifactId: string; mimeType: string }> };
}
```

Cada `yield` es **una respuesta completa del modelo** o un resultado de tool, no
un delta. Para deltas, `onToken` en `AgentLoopOptions` o `stream: true` en
`agent.chat()`.

### runAgent (bajo nivel)

```typescript
import { runAgent, runAgentIsolated } from "@johpaz/hive-sdk";

// Streaming
for await (const chunk of runAgent({
  agentId: "assistant",
  userMessage: "Analiza las ventas",
  threadId: "thread-123",
})) {
  // procesar chunk
}

// Modo aislado (para workers DAG)
const result = await runAgentIsolated({
  agentId: "processor",
  taskDescription: "Procesa estos datos",
  threadId: "dag-thread",
});
```

### Multi-inquilino: credenciales y Jev

Un host que sirve a varios clientes desde un mismo proceso corre cada turno
dentro de `runInTenant(tenantKey, …)` y pasa las claves **por llamada**:

```typescript
import { runAgent } from "@johpaz/hive-sdk";
import { runInTenant } from "@johpaz/hive-sdk/storage";

await runInTenant(tenantKey, async () => {
  for await (const chunk of runAgent({
    agentId, threadId, userMessage,
    credentials: { apiKey: claveDelModelo, baseUrl },     // gana y corta ahí
    jev: claveOpenRouter ? { apiKey: claveOpenRouter } : false,
    onStep: async (paso) => { /* text · tool_call · tool_result · jev_decision */ },
  })) { /* … */ }
});
```

Reglas con un inquilino activo (desde 0.5.1):

- `credentials.apiKey` gana. Sin ella, la clave sale de los secretos **de ese
  inquilino** (`storeProviderApiKey` dentro de su `runInTenant`).
- Nunca se usa `<PROVIDER>_API_KEY` del entorno ni el llavero del SO: son de la
  máquina, no del cliente. Si no hay clave, la llamada falla en vez de cobrarse
  a la plataforma. Para tus propias tools usa `envSecret(nombre)`
  (`@johpaz/hive-sdk/storage`), que aplica la misma regla.
- `credentials` y `jev` se propagan a `runAgentIsolated`, `runRoleSwarm` y
  `runSwarm`.

### Jev: plano de decisión

Jev hace preguntas acotadas a la API Decisions de OpenRouter
(`typesafe/jev-1.13`) y usa las respuestas para recortar lo que recibe el
modelo principal. **Es opcional**: sin clave no existe, no se hace ninguna
llamada y el turno corre exactamente igual.

| Momento | Qué decide |
|---|---|
| Al compilar el contexto | Qué mensajes previos, tools, skills, notas del scratchpad y reglas del playbook entran; a qué especialista conviene delegar, y si depende de un MCP apagado. Los últimos 4 mensajes siempre quedan. |
| Entre iteraciones | Qué resultados viejos de tools se omiten y la siguiente acción (continuar, delegar, descubrir, cerrar). Sólo si hay ≥ 4 000 caracteres podables. |
| Antes de ejecutar tools | Si un lote de lecturas independientes, o de delegaciones a workers distintos, corre en paralelo. |

Lo omitido se puede recuperar: el prompt lista los ids y el coordinador tiene
`conversation_read`.

**Activación**, por orden:

1. `jev: { apiKey, endpoint?, model?, share?, mcpSettingsPath? }` en la llamada. `mcpSettingsPath` es el
   texto con el que el coordinador le dice al usuario dónde encender un MCP
   (por defecto «Ajustes → Entorno → MCP Servers»).
2. `jev: false` lo apaga.
3. Sin la opción: el provider `openrouter` habilitado y activo, con su clave
   guardada; sin inquilino, también `OPENROUTER_API_KEY`.

**Qué ve el host.** Cada decisión llega por `onStep` como
`{ type: "jev_decision", message, jev }`, con agente, tipo (`context`,
`iteration`, `parallel`), resumen, tokens ahorrados estimados, latencia, costo,
especialista recomendado y MCP apagados. También se emite
`canvas:jev_decision`. `getUsageStats().jev` suma decisiones, costo y ahorro
(total y por agente). Fallos y cooldown se llevan por inquilino.

**Modelo propio.** `endpoint` apunta a otro servidor de decisiones (llama.cpp
sirve `/v1/systemone`) y `model` cambia el nombre del modelo; con un servidor
propio el texto del turno no sale de tu máquina. `apiKey` sigue siendo
obligatoria (cualquier cadena no vacía si el servidor no la comprueba).

**Qué se comparte.** `share` recorta lo que viaja al modelo de decisión; todo es
`true` por defecto y el mensaje del usuario siempre viaja, porque sin él Jev no
puede decidir nada:

```typescript
jev: {
  apiKey,
  share: {
    instructions: false, // no se envía el extracto del system prompt: Jev juzga las tools solo por su nombre
    history: false,      // no se envían mensajes previos: el historial no se poda
    toolResults: false,  // no se envían resultados ni argumentos de tools: esa decisión la toma el runtime
  },
}
```

Apagar una parte cuesta decisiones, nunca corrección: Jev cae a la ruta clásica
para las que la necesitan. `resolveShare` se exporta para los hosts.

**Privacidad.** Se envían a OpenRouter, con la clave de la llamada, extractos
acotados: el objetivo del turno, fragmentos de mensajes previos, nombres y
descripciones de tools y skills, notas y reglas, fragmentos de resultados de
tools y el mapa del enjambre (nombres, no ids con prefijo de inquilino). Nunca
credenciales ni adjuntos. El detalle está en el [CHANGELOG](../CHANGELOG.md).

---

## Tool Selector

Selección automática de tools por búsqueda BM25 sobre el índice de capacidad.

```typescript
import { selectTools, CORE_TOOL_CATALOG } from "@johpaz/hive-sdk";

// Seleccionar tools relevantes
const tools = selectTools("Buscar archivos en el proyecto");
console.log(tools.map(t => t.name));

// Con límite personalizado
const limited = selectTools("search query", CORE_TOOL_CATALOG, 3);
```

### Constantes

```typescript
const MIN_RELEVANCE_THRESHOLD = -30;
```

### CORE_TOOL_CATALOG

60 tools built-in organizadas por categoría:

| Categoría | # | Descripción |
|-----------|---|-------------|
| agents | 15 | delegación (`task_delegate`, `task_revise`), memoria, catálogo de modelos |
| web | 10 | `web_search`, `web_fetch`, automatización de browser, `artifact_inspect` |
| cron | 8 | tareas programadas |
| office | 8 | PDF, DOCX, XLSX, PPTX |
| filesystem | 7 | read, write, edit, delete, list, glob, exists |
| a2ui | 4 | superficies de UI generadas por el agente |
| core | 4 | `save_note`, `notify`, `report_progress`, `search_knowledge` |
| cli | 1 | ejecución de comandos |
| api | 1 | `api_request` |

Las categorías `projects`, `canvas`, `codebridge`, `voice` y `meeting`
desaparecieron en 0.1.5 junto con sus tools.

---

## Skill Selector

```typescript
import { selectSkills, getMinimalSkills } from "@johpaz/hive-sdk";

// Skills según mensaje
const skills = selectSkills("Analyze the sales data");

// Skills mínimos siempre disponibles
const minimal = getMinimalSkills();
```

---

## LLM Providers

### Providers Soportados

16 providers, todos sembrados con su catálogo de modelos y su precio por millón
de tokens. `provider` en `createAgent` acepta cualquiera de estos ids.

| Provider | Adapter | Notas |
|----------|---------|-------|
| `anthropic` | nativo | extended thinking, round-trip de thinking blocks |
| `gemini` | nativo | REST v1beta |
| `ollama` | nativo | modelos locales, flag `think` |
| `openai` | OpenAI-compat | Sol / Terra / Luna |
| `deepseek`, `kimi` | OpenAI-compat | round-trip de `reasoning_content` |
| `mistral`, `groq`, `qwen`, `minimax` | OpenAI-compat | |
| `z-ai` | OpenAI-compat | sirve en `/api/paas/v4`, no en `/v1` |
| `hiveagents` | OpenAI-compat | |
| `nvidia`, `openrouter`, `opencode-go`, `modelscope` | OpenAI-compat | **revendedores** |

Los cuatro revendedores prefijan sus ids de modelo con su propio id de provider
(`modelscope/Qwen/Qwen3.5-397B-A17B`), porque sirven modelos de terceros que se
solapan entre sí y la colección `models` se indexa por una sola clave. El
prefijo no llega al cable: el adapter lo quita antes del request.

```typescript
import { catalogModelKey, wireModelId } from "@johpaz/hive-sdk";

catalogModelKey("modelscope", "Qwen/Qwen3.5-397B-A17B"); // modelscope/Qwen/Qwen3.5-397B-A17B
wireModelId("modelscope", "modelscope/Qwen/Qwen3.5-397B-A17B"); // Qwen/Qwen3.5-397B-A17B
```

### Errores del provider

`callLLM` nunca lanza: devuelve `stop_reason: "error"` con un campo `error`
tipado. Chequealo antes de persistir `content` en cualquier lado — es texto para
mostrar, no salida del modelo.

```typescript
const response = await callLLM({ ... });

if (response.stop_reason === "error") {
  console.error(response.error?.message);
  // HTTP 404/410 → el proveedor retiró el modelo; reintentar no sirve.
  if (response.error?.modelUnavailable) selectAnotherModel();
}
```

### callLLM

```typescript
import { callLLM, resolveProviderConfig } from "@johpaz/hive-sdk";

const config = await resolveProviderConfig("openai", "gpt-5.6-luna");

const response = await callLLM({
  provider: config.provider,
  model: config.model,
  messages: [{ role: "user", content: "Hola" }],
});
```

---

## Errores Comunes

### createAgent: no se encuentra el agente

```typescript
// El agente no necesita existir en DB — createAgent lo gestiona internamente
// Si falla, verificar API keys en variables de entorno
```

### Tool no encontrada

```typescript
// Verificar que la tool está registrada
const reg = new ToolRegistry();
reg.register(myTool);
reg.has("my_tool"); // true
```

### Context too large

```typescript
// Usar maybeCompact para reducir historial
const { maybeCompact } = await import("../agent/Compaction.ts");
await maybeCompact(threadId, { channel, userId });
```

## Resto de la superficie del loop

Todo desde `@johpaz/hive-sdk`.

### Ejecutar

| | |
|---|---|
| `runAgent(opts)` | El loop. Devuelve un `AsyncGenerator<StreamChunk>`. |
| `runAgentIsolated(opts)` | Un worker en contexto aislado; devuelve sólo el texto final. Es lo que usan el enjambre y `task_delegate`. |
| `runAgentIsolatedDetailed(opts)` | Igual, pero además devuelve la evidencia de las tools que usó — la necesita quien tenga que justificar una entrega. |
| `createAgentRunner(config, opts?)` | Un `AgentRunner` listo. Construye el loop global, que es lo que `generate()` necesita: `new AgentRunner()` a secas se instancia sin quejarse y falla en la primera llamada. |

### El loop global

`buildAgentLoop(opts)` lo construye, `getAgentLoop()` lo devuelve (o `null`), y
`rebuildAgentLoop(opts)` lo rehace — por ejemplo tras conectar un manager MCP.

Es estado de proceso: un host multi-inquilino que corra varias colmenas a la vez
debería usar `runAgent()` directo con `credentials` por llamada, no este
singleton.

### Errores

| | |
|---|---|
| `LLMCallTimeoutError` | Una llamada al proveedor agotó su ventana. Es por llamada, no del turno entero. |
| `AgentSynthesisError` | El modelo no pudo redactar la respuesta final tras dos intentos. |

`withTimeout(op, ms)` acota una operación a su propia ventana, independiente de
la del turno. Es lo que evita que una tool lenta se lleve puesto el turno entero.

### Interno, expuesto por utilidad

`synthesizeFinalResponse` fuerza el cierre de un turno que se quedó sin
iteraciones. `injectArtifactReadIfNeeded` agrega `artifact_read` al loadout en
cuanto un resultado devuelve un `artifact_ref` que el modelo va a necesitar
abrir: descubrirla por búsqueda costaría una iteración y asume que al modelo se
le ocurra buscarla.

*Documentación Hive SDK — ver `version` en package.json*
