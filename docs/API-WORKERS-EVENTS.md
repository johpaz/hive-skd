# API Reference — Workers y Eventos

## Índice

1. [Bun Workers](#bun-workers)
2. [createWorker](#createworker)
3. [WorkerPool](#workerpool)
4. [AgentBus](#agentbus)
5. [EventBus](#eventbus)
6. [Canvas Events](#canvas-events)

---

## Bun Workers

Hive SDK soporta **workers individuales con Bun Workers**. Cada worker corre en un thread aislado (`Bun.Worker` con `{ smol: true }`), con su propio system prompt y configuración.

### Casos de uso

- **Workers especializados**: Un worker para research, otro para coding, otro para review
- **Paralelismo**: Ejecutar múltiples tareas simultáneamente sin bloquear el hilo principal
- **Aislamiento**: Cada worker tiene su propio contexto y no interfere con otros

---

## createWorker

Crea un worker individual con Bun Workers.

### Firma

```typescript
import { createWorker } from "@johpaz/hive-sdk";

const worker = createWorker(config: WorkerConfig): WorkerInstance
```

### WorkerConfig

```typescript
interface WorkerConfig {
  name: string;                    // Identificador del worker
  agentId?: string;                // ID del agente en DB (default: name)
  systemPrompt?: string;           // System prompt personalizado
  model?: string;                  // Modelo LLM
  provider?: string;               // Provider LLM
}
```

### WorkerInstance

```typescript
interface WorkerInstance {
  readonly name: string;
  readonly id: string;

  // Ejecutar y esperar resultado
  run(message: string, opts?: {
    threadId?: string;
    channel?: string;
  }): Promise<string>;

  // Streaming de resultados
  runStream(message: string, opts?: {
    threadId?: string;
    channel?: string;
  }): AsyncGenerator<WorkerChunk>;

  // Terminar el worker
  terminate(): void;
}
```

### Ejemplo básico

```typescript
import { createWorker } from "@johpaz/hive-sdk";

const researcher = createWorker({
  name: "researcher",
  systemPrompt: `
    You are a research specialist.
    Provide concise, factual summaries with citations.
    Always verify facts before presenting them.
  `,
});

const result = await researcher.run("Latest advances in quantum computing 2025");
console.log(result);

researcher.terminate();
```

### Streaming

```typescript
const stream = researcher.runStream("Explain quantum entanglement");

for await (const chunk of stream) {
  if (chunk.type === "chunk") {
    console.log("Chunk:", chunk.chunk);
  } else if (chunk.type === "result") {
    console.log("Final:", chunk.content);
  } else if (chunk.type === "error") {
    console.error("Error:", chunk.error);
  }
}
```

---

## WorkerPool

Gestiona un pool de Bun Workers para ejecución paralela.

### Firma

```typescript
import { WorkerPool } from "@johpaz/hive-sdk";

const pool = new WorkerPool(config?: WorkerPoolConfig);
```

### WorkerPoolConfig

```typescript
interface WorkerPoolConfig {
  maxWorkers?: number;        // Default: 4
  taskTimeoutMs?: number;     // Default: 120000
  workerConfig?: WorkerConfig;
}
```

### Métodos

```typescript
// Ejecutar una tarea
pool.execute(task: PoolTask): Promise<PoolTaskResult>

// Ejecutar múltiples tareas en paralelo
pool.executeBatch(tasks: PoolTask[]): Promise<PoolTaskResult[]>

// Ejecutar con límite de concurrencia
pool.executeWithConcurrency(tasks: PoolTask[], concurrency: number): Promise<PoolTaskResult[]>

// Estadísticas
pool.stats  // { total, busy, idle }

// Cerrar todos los workers
pool.shutdown(): void
```

### Ejemplo: Batch processing

```typescript
import { WorkerPool } from "@johpaz/hive-sdk";

const pool = new WorkerPool({
  maxWorkers: 4,
  workerConfig: {
    name: "analyzer",
    systemPrompt: "You analyze text and extract key insights.",
  },
});

const articles = [
  { id: "a1", message: "Summarize article about AI..." },
  { id: "a2", message: "Summarize article about climate..." },
  { id: "a3", message: "Summarize article about space..." },
];

const results = await pool.executeBatch(articles);

for (const result of results) {
  console.log(`${result.taskId}: ${result.result} (${result.durationMs}ms)`);
}

pool.shutdown();
```

### Ejemplo: Concurrency limit

```typescript
// Procesar 100 tareas pero solo 5 a la vez
const tasks = Array.from({ length: 100 }, (_, i) => ({
  id: `task-${i}`,
  message: `Process item ${i}`,
}));

const results = await pool.executeWithConcurrency(tasks, 5);
```

---

## CLI: hives add-worker

Genera un Bun Worker en tu proyecto:

```bash
cd my-project
hives add-worker researcher
```

Crea `src/workers/researcher.worker.ts`:

```typescript
import { createWorker } from "@johpaz/hive-sdk";

export const researcherWorker = createWorker({
  name: "researcher",
  systemPrompt: `You are the ResearcherWorker specialist...`,
});
```

---

## AgentBus

Sistema de eventos singleton para comunicación entre agentes.

```typescript
import { agentBus, getUnreadMessagesForWorker } from "@johpaz/hive-sdk";

// Publicar evento
agentBus.publish("worker:task_started", { taskId: "task-1" }, "worker-1");

// Suscribirse
const unsub = agentBus.subscribe("worker:task_completed", (data) => {
  console.log("Task completed:", data);
});

// Unsubscribe
unsub();
```

### Métodos Helper

```typescript
import {
  getUnreadMessagesForWorker,
  getProjectMessageHistory,
} from "@johpaz/hive-sdk";

const messages = getUnreadMessagesForWorker("worker-1");
const history = getProjectMessageHistory("project-1");
```

---

## EventBus

EventBus global singleton (eventos del sistema).

```typescript
import { eventBus } from "@johpaz/hive-sdk";

// Escuchar eventos
eventBus.on("agent:start", (data) => {
  console.log("Agent started:", data);
});

// Emitir eventos
eventBus.emit("agent:complete", { agentId: "a1", result: "ok" });
```

---

## Canvas Events

Eventos de actualización visual del canvas.

```typescript
import { emitCanvas, subscribeCanvas, unsubscribeCanvas } from "@johpaz/hive-sdk";

// Suscribirse a eventos canvas
const handler = (data: any) => console.log("Canvas:", data);
subscribeCanvas(handler);

// Emitir evento
emitCanvas("canvas:node_update", {
  nodeId: "agent-1",
  changes: { status: "thinking" },
});

// Desuscribirse
unsubscribeCanvas(handler);
```

### CanvasManager

```typescript
import { CanvasManager } from "@johpaz/hive-sdk";

const canvas = new CanvasManager();
```

---

## Canvas

El estado visual de una delegación en curso, para quien quiera pintarlo.

| | |
|---|---|
| `getCanvasSnapshot()` | El estado completo, para arrancar una vista. |
| `subscribeCanvas(fn)` / `unsubscribeCanvas(fn)` | Cambios en vivo. |
| `emitCanvas(evento, datos)` | Publicar un cambio. |
| `emitDelegationStarted` / `emitDelegationFinished` | Una delegación empieza y termina — es lo que dibuja las aristas entre agentes. |
| `emitWorkEvent` | Un hito de trabajo dentro de un nodo. |

*Documentación Hive SDK — ver `version` en package.json*
