# API Reference — Context Compiler y Componentes Avanzados

## Índice

1. [Context Compiler](#context-compiler)
2. [Message History](#message-history)
3. [Scratchpad](#scratchpad)
4. [EthicsGuard](#ethicsguard)
5. [ACE (Tracer, Reflector, Curator)](#ace)
6. [MCP Internals](#mcp)

---

## Context Compiler

Compila todo el contexto necesario para cada ejecución del agente.

### compileContext

```typescript
import { compileContext } from "@johpaz/hive-sdk";

const ctx = await compileContext({
  agentId: "analyst",
  threadId: "thread-123",
  userMessage: "Analiza esto",
  channel: "slack",
  mcpManager: mcpClient,
  isolated: false,
});

// Resultado
console.log(ctx.systemPrompt);
console.log(ctx.messages);   // Historial compilado
```

### Estrategias

El Context Compiler implementa 4 estrategias de Context Engineering:

| Estrategia | Descripción |
|------------|-------------|
| **ESCRIBIR** | Guardar información fuera del contexto (Scratchpad, trazas) |
| **SELECCIONAR** | Traer solo lo relevante (selección BM25 de tool/skill/playbook) |
| **COMPRIMIR** | Reducir tokens (compaction, tool result clearing) |
| **AISLAR** | Separar contextos por agente (workers reciben contexto mínimo) |

---

## Message History

### addMessage

```typescript
import { addMessage } from "@johpaz/hive-sdk";

await addMessage(
  threadId: string,
  role: "user" | "assistant" | "system",
  content: string | ContentPart[],
  options?: {
    channel?: string;
    tool_calls?: ToolCall[];
  }
);
```

### getRecentMessages

```typescript
import { getRecentMessages } from "@johpaz/hive-sdk";

const messages = await getRecentMessages(threadId, {
  maxTokens: 32000,
  maxMessages: 50,
});
```

### maybeCompact

Reduce el historial cuando excede el límite de tokens.

```typescript
import { maybeCompact } from "@johpaz/hive-sdk";

await maybeCompact(threadId, { channel: "slack", userId: "U123" });
```

### clearOldToolResults

```typescript
import { clearOldToolResults } from "@johpaz/hive-sdk";

const clean = clearOldToolResults(messages);
```

### ConversationStore

```typescript
import { getSummary, saveSummary, getScratchpad, saveScratchpadNote } from "@johpaz/hive-sdk";

// Resumen de conversación
const summary = getSummary(threadId);

// Notas del scratchpad
const notes = getScratchpad(threadId, "worker-1");
```

---

## Scratchpad

Memoria temporal por hilo de conversación.

```typescript
import { Scratchpad } from "@johpaz/hive-sdk";

const pad = new Scratchpad();

await pad.write("thread-1", "mi-nota", "contenido");
const value = await pad.read("thread-1", "mi-nota");
const all = await pad.list("thread-1");   // { "mi-nota": "contenido" }
await pad.delete("thread-1", "mi-nota");
await pad.clear("thread-1");
```

El scratchpad se inyecta al system prompt en cada turno bajo
`# SCRATCHPAD (Persistent Notes)`, comprimido con TOON. La clase es una fachada
sobre las funciones de `conversation-store`: hasta 0.1.5 tenía implementación
propia y, como usaba el mismo id, escribía las mismas filas con un documento
incompleto que rompía el orden por recencia.

---

## EthicsGuard

Capa opcional de reglas de calidad de respuesta, leídas de la colección
`playbook` (`category: "response_quality"`).

```typescript
import { EthicsGuard } from "@johpaz/hive-sdk";

const guard = new EthicsGuard();

const rules = await guard.getRules();                     // sólo las globales
const rulesForRole = await guard.getRules("coordinator"); // filtra por applicable_to
const rulesForUser = await guard.getRules(undefined, userId); // globales + las de ese usuario

const prompt = guard.injectIntoPrompt("Eres un asistente.", rules);

if (await guard.hasEthicsLayer()) {
  console.log("Reglas de calidad activas");
}
```

> El constructor ya no recibe un handle de base y todos los métodos son async:
> hasta 0.1.5 la clase armaba SQL a mano contra la tabla `playbook` y hacía un
> JOIN con la tabla virtual `playbook_fts`. Ninguna de las dos existe.

**Esto no es la ética constitucional del agente.** Esa vive en la colección
`ethics` y la ensambla `buildSystemPrompt()` como primera sección, completa y sin
comprimir. `EthicsGuard` es un complemento para hosts que quieran inyectar,
además, reglas aprendidas por ACE.

---

## ACE (Tracer, Reflector, Curator)

Sistema de Auto-Corrección por Experiencia.

### Tracer

```typescript
import { saveTrace, recordLLMUsage } from "@hive/core/ace";

// Guardar traza de ejecución
saveTrace({
  agentId: "analyst",
  model: "gpt-5.6-luna",
  messages: 5,
  toolCalls: ["web_search", "read_file"],
  durationMs: 1200,
  tokensUsed: 450,
  success: true,
});

// Registrar uso de LLM
recordLLMUsage({
  model: "gpt-5.6-luna",
  inputTokens: 200,
  outputTokens: 250,
  durationMs: 800,
});
```

### Reflector + Curator

```typescript
import { runReflector, runCurator } from "@hive/core/ace";

// Analizar trazas y generar insights
await runReflector();

// Curar insights en reglas del playbook
await runCurator();
```

### A quién se le aplica lo aprendido

Una regla del playbook se inyecta en el system prompt de cada turno, así que
quién la ve importa tanto como qué dice. `PlaybookDoc.user_id` y
`ReflectionDoc.user_id` marcan de quién salió:

| `user_id` | Origen | Quién la ve |
|---|---|---|
| `""` | Sembrada con el producto (`INITIAL_PLAYBOOK_RULES`) | Todos |
| `"user-ana"` | Aprendida de las trazas de esa persona | Sólo ella |

El reflector agrupa el lote de trazas por usuario antes de analizarlo —lo saca
del `thread_id`, que es `${userId}/${channel}/${peerId}`— y emite una reflexión
por grupo. El curador propaga ese dueño a la regla, y deduplica **dentro** del
usuario: la misma observación en dos personas son dos reglas, no una reforzada
al doble.

Las tres puertas de lectura filtran igual (global + propio):

```typescript
await selectPlaybookRules(texto, userId)          // inyección en el prompt
await guard.getRules(undefined, userId)           // EthicsGuard
// search_knowledge toma el usuario de config.configurable.user_id
```

`selectPlaybookRules` pide un pozo de candidatos más ancho que el que devuelve,
porque el índice BM25 es único para todo el proceso: filtrando después de un
`k` justo, un usuario con pocas reglas se quedaría sin ninguna cuando las mejor
puntuadas son de otro.

> **Migración.** Las reglas anteriores a este campo se aprendieron cuando la
> instalación era de un solo usuario: `ensureHiveDb()` se las asigna al primer
> usuario de la base, no las deja globales. Las sembradas son la excepción —
> `seedAllData()` les fija `user_id: ""` en cada arranque.

---

## Memoria entre hilos

Al compactar un hilo, su resumen se indexa en HiveDB (`summary:<threadId>`,
filtros `type=summary`, `thread` y `tenant`). Con `memory.crossThreadRecall`
encendido, el compilador añade al prompt un bloque `CONVERSACIONES RELACIONADAS`
con los resúmenes más parecidos al objetivo de **otros hilos del mismo
inquilino** (el del hilo actual ya va en su propio resumen).

```typescript
// hive.config.ts
export default { memory: { crossThreadRecall: { enabled: true, k: 3 } } };
```

Apagado por defecto. Si varios usuarios comparten un inquilino, el recall cruza
sus conversaciones: actívalo solo cuando eso es lo que quieres. Borrar el hilo
(`deleteThread`) quita su resumen del índice.

---

## MCP Internals

### Config

```typescript
import type { MCPConfig, MCPServerConfig } from "@johpaz/hive-sdk";

const config: MCPConfig = {
  servers: {
    "my-server": {
      transport: "stdio",        // "stdio" | "sse" | "websocket"
      command: "npx",
      args: ["-y", "@server/pkg"],
      env: { KEY: "value" },
      enabled: true,
    },
  },
};
```

### Singleton

```typescript
import { setMCPManager, getMCPManager, hasMCPManager } from "@johpaz/hive-sdk";

setMCPManager(mcpManager);
const mcp = getMCPManager();     // MCPClientManager | undefined
const exists = hasMCPManager();   // boolean
```

### Hot Reload

```typescript
import { startMCPHotReload, stopMCPHotReload } from "@johpaz/hive-sdk";

// Watch de configuración MCP
startMCPHotReload();

// Detener watch
stopMCPHotReload();
```
