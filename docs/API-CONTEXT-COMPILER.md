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

Sigue «You don't need long context» (arXiv 2611.05306, https://arxiv.org/abs/2611.05306): compactar con frecuencia y pasar un estado explícito. El resumen es un **traspaso de seis campos** (`objective`, `facts`, `changes`, `verification`, `dead_ends`, `plan`) en `agent/handoff.ts`; se guarda en `SummaryDoc.structured` y su texto renderizado queda en `summary`. Cada compactación incorpora el traspaso previo y lee solo lo posterior. Los mensajes compactados se indexan en HiveDB (`agent/message-memory.ts`) y `conversation_read` los recupera por significado. Umbral: `agent.context.compactionThreshold` (proporción ≤ 1 o tokens > 1; por defecto 0,8).

**Modo de una acción por contexto** (experimental, apagado): `HIVE_SINGLE_ACTION=true` (`agent.context.singleActionMode`). En un worker, tras cada acción se destila el estado y la conversación se reinicia con solo la tarea y ese estado (`agent/single-action.ts`). Cuesta una llamada más por acción; si falla, el historial no se recorta. Sin evaluación de extremo a extremo todavía.

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

Con un HiveDB que traiga `embedQuery`, el compilador pasa además `episodicSimilarity` a `buildAgentContext` (los resúmenes se indexan con `kind=episode` y la búsqueda se acota al inquilino con `filters`) y añade `EPISODIOS PREVIOS SIMILARES`. Con un HiveDB anterior no se activa: ignoraría el filtro de inquilino.

Apagado por defecto. Si varios usuarios comparten un inquilino, el recall cruza
sus conversaciones: actívalo solo cuando eso es lo que quieres. Borrar el hilo
(`deleteThread`) quita su resumen del índice.

## Línea de tiempo del historial

Lo que queda **fuera de la ventana** (los últimos 15 mensajes) llega al modelo por tres vías: el resumen de compactación, una
recuperación por búsqueda de 3 mensajes × 500 caracteres y la herramienta `conversation_read`. Con
`HIVE_HISTORY_TIMELINE=true` se añaden dos piezas, ambas **sin llamar a un modelo**:

| Pieza | Qué inyecta | Presupuesto |
|---|---|---|
| Línea de tiempo | Bloque `# LÍNEA DE TIEMPO DE LA CONVERSACIÓN`: una línea `#id [rol] primeros 80 caracteres` por mensaje fuera de ventana (en los del asistente, además `→ tools: nombres`). Si no caben todas, conserva la primera y la última y reparte el resto con paso fijo. | 3 % de la ventana del modelo (entre 300 y 2 000 tokens) |
| Recuperación adaptativa | Reemplaza el 3 × 500 fijo: pide 20 candidatos a la búsqueda híbrida y los empaqueta de mayor a menor relevancia hasta llenar el presupuesto (hasta 1 200 caracteres por mensaje); el que no cabe se **salta**, no corta a los siguientes. | 4 % de la ventana (entre 300 y 3 000 tokens) |

**Qué no hace.** Nunca copia el contenido de mensajes `tool` ni los argumentos de las tools a la línea de tiempo (pueden llevar
credenciales). No toca la compactación por LLM, que sigue igual. Con el flag apagado el prompt es idéntico al de antes.

**Configuración.**

| Variable | Efecto | Por defecto |
|---|---|---|
| `HIVE_HISTORY_TIMELINE` | Enciende la función (`memory.historyTimeline.enabled`) | apagada |
| `HIVE_HISTORY_TIMELINE_MIN_WINDOW` | Ventana mínima (tokens) para que actúe; por debajo se ignora el flag y queda una línea en el log. `0` quita la compuerta | `16000` (provisional, sin respaldo firme) |
| `HIVE_HISTORY_TIMELINE_PARTS` | `both`, `timeline` o `recall`: activa solo una pieza. Es para medir por separado qué aporta cada una | `both` |

**Respaldo.** La idea sale de *FlexA-Mem: Budget-Adaptive Agentic Memory for LLM Agents* (Xu et al., arXiv
[2610.33274](https://arxiv.org/abs/2610.33274), octubre de 2026): guardar cada unidad de historia una sola vez y **renderizar en cada llamada** una
línea de tiempo compacta más el detalle que quepa en el presupuesto restante, con una regla fija y sin llamar a un modelo al renderizar. Según los autores,
con presupuesto de 4 000 tokens supera al segundo mejor método en 11,5 puntos en AppWorld (40,3 frente a 28,8), y en LongMemEval su recuperación por
trozos (78,0) iguala a un recuperador por palabras clave sin memoria escrita (78,4); en sus ablaciones, quitar la línea de tiempo cuesta 15,5 puntos en
AppWorld y quitar la recuperación cuesta 28,2 en LongMemEval. Esas cifras son suyas: **no las hemos reproducido**.

Lo que tomamos y lo que no:

| FlexA-Mem | Aquí |
|---|---|
| Almacén inmutable, una escritura por unidad | Ya existía: cada mensaje se guarda una vez y se indexa en HiveDB |
| Registro de 80 palabras por unidad, escrito por un LLM | **No**: la línea es el recorte de los primeros 80 caracteres del mensaje |
| Fusión de registros viejos con un LLM | **No**: muestreo fijo (primero, último y paso constante) |
| Trozos de 150 tokens ordenados por BM25, con degradación de resolución | **No**: mensajes completos (recortados a 1 200 caracteres desde el principio) de la búsqueda híbrida |
| Presupuesto = lo que queda tras el prompt y la ventana reciente (30 % o 50 % a la línea de tiempo) | **Distinto**: porcentaje fijo de la ventana del modelo, porque el prompt aún no está armado cuando se calcula |
| Unidades de pasos de agente con grafo | **No**: aquí solo conversación. El log causal es por ejecución y sus `ToolCall` no guardan argumentos ni resultado |

**Evidencia propia** (metodología, límites y datos crudos en [`bench/history-timeline/README.md`](../bench/history-timeline/README.md)). Las pruebas con modelo están en `bench/history-timeline/e2e.ts`, que lee la clave del almacén de secretos de hive en memoria y no la imprime.

1. **Sin modelo, exacta** (27 datos plantados fuera de la ventana, 3 semillas; porcentaje que llega al prompt). Se miden las piezas por separado con `HIVE_HISTORY_TIMELINE_PARTS`:

| Consulta | Ventana | Actual | Solo recuperación | Solo línea | Ambas |
|---|---:|---:|---:|---:|---:|
| Con palabras del dato | cualquiera | 100 % | 100 % | 100 % | 100 % |
| Vaga (sin palabras del dato) | 8 000 | 0 % | 0 % | 7 % | 7 % |
| Vaga | 32 000 | 0 % | 0 % | 56 % | 56 % |
| Vaga | 128 000 | 0 % | 0 % | 85 % | 85 % |
| Pide todo a la vez | 8 000 | 33 % | 81 % | 33 % | 81 % |
| Pide todo a la vez | 32 000 | 33 % | 100 % | 74 % | 100 % |
| Pide todo a la vez | 128 000 | 33 % | 100 % | 85 % | 100 % |

   Las dos piezas se complementan: la **línea de tiempo** es la única que ayuda con una consulta vaga, y la **recuperación adaptativa** explica casi toda la mejora cuando se pide todo a la vez (el modo actual recupera siempre 3 mensajes, así que ese control no escala con el presupuesto). Con una consulta que comparte palabras con el dato no hay diferencia, como en el paper. Costo: de ~300 a ~7 500 caracteres más de prompt, según la pieza y la ventana.

2. **Con modelo** (Gemini 3.8 Flash, `conversation_read` disponible, ventana de 16 000, preguntas con otras palabras, 18 por celda, 2 semillas):

| Modo | Dato en el contexto | Respondió bien (corrida 2) |
|---|---:|---:|
| Actual | 6/18 | 11/18 |
| Solo recuperación | 6/18 | 10/18 |
| Solo línea | 12/18 | 12/18 |
| Ambas | 12/18 | 14/18 |

   «Dato en el contexto» es determinista y repite el resultado exacto de arriba. **«Respondió bien» no es concluyente:** la misma configuración «Actual» dio 8/18 en una corrida anterior y 11/18 en esta (mismo código, temperatura 0), así que el ruido entre corridas es de unos 3 casos, del tamaño de las diferencias que se miden. Que la función haga contestar mejor al agente **no está demostrado**; lo que sí se ve es que pone más datos en el contexto cuando la pregunta no repite las palabras del dato.

El umbral de 16 000 y la compuerta son por tanto una suposición razonable, no un resultado: los datos no muestran daño a 8 000 que no sea ruido. La función sigue apagada por defecto.

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
