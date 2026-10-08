<p align="center">
  <img src="docs/assets/logoblack.png" alt="Hive SDK" width="180" />
</p>

# @johpaz/hive-sdk

> **Hive Agent Harness SDK** — construí, desplegá y escalá aplicaciones de agentes de IA, con soporte multi-canal, Bun Workers y orquestación en swarm.

[![npm](https://img.shields.io/npm/v/@johpaz/hive-sdk)](https://www.npmjs.com/package/@johpaz/hive-sdk)

```bash
bun add @johpaz/hive-sdk
```

## ¿Qué es Hive SDK?

**Hive SDK es un Agent Harness**: un marco de trabajo completo para construir, desplegar y escalar aplicaciones de agentes de IA. A diferencia de un simple wrapper de LLM, un *harness* provee todo lo necesario para que un agente opere en producción:

- **Agentes**: ciclo ReAct nativo con checkpoint durable, 16 providers LLM y descubrimiento de tools/skills por búsqueda BM25.
- **Catálogo**: 18 providers y 110 modelos sembrados, cada uno con su precio por millón de tokens — una sola fuente de verdad para el costo.
- **Tools**: 60 tools incluidas — filesystem, web search, browser automation (`Bun.WebView`), APIs (`api_request`), a2ui, office, cron, delegación. Las de office validan la entrada antes de parsear (PDF 25 MiB, XLSX 15 MiB, 200 páginas, 50 hojas, 10 000 filas por hoja, 30 s de tope) y devuelven un error de tool en vez de truncar en silencio — importa cuando el archivo lo sube un tercero. Ver [SECURITY-GUARDRAILS.md](./docs/SECURITY-GUARDRAILS.md).
- **Skills**: 23 workflows bundled, más los tuyos con `defineSkill` y `SkillLoader`.
- **Canales**: Telegram, Discord, WhatsApp, Slack y WebChat con `ChannelManager`.
- **Swarm**: orquestación multi-agente con `DAGScheduler`, `TaskGraph` y `WorkerPool`.
- **Runtime**: ejecución paralela de tools vía Bun Workers.
- **Gateway**: servidor HTTP/WebSocket para exponer agentes como API.
- **Memoria y estado**: HiveDB (colecciones + índice BM25), scratchpad, context compiler con compactación.
- **Oráculo (opcional), Jev o Kev**: plano de decisión sobre la API Decisions de OpenRouter (Jev) o el modelo del laboratorio HiveAgents (Kev); además de decidir, revisa la respuesta antes de entregarla. Ver [ORACULO.md](./docs/ORACULO.md). Jev: Por turno elige qué historial, tools, skills, notas y reglas entran al contexto, poda resultados viejos entre iteraciones y decide si un lote de tools corre en paralelo. Sin clave de OpenRouter no existe y todo corre igual. Ver [API-AGENTS.md](./docs/API-AGENTS.md#jev-plano-de-decisión).
- **Multi-inquilino**: varios enjambres en una sola HiveDB con `runInTenant`; credenciales y clave de Jev por llamada (`credentials`, `jev`), sin que la clave de un inquilino ni la de la plataforma se usen en nombre de otro.
- **Servicios**: CRUD tipado de agentes, enjambres, skills, modelos, MCP y cron para montarle **la interfaz que quieras** — móvil, web o escritorio. Ver [API-SERVICES.md](./docs/API-SERVICES.md).
- **Sesiones**: un hilo por canal y por contacto, con historial, resumen y reanudación tras un corte.
- **Imágenes**: redimensionar y convertir con `Bun.Image`, sin dependencias nativas. Las imágenes entrantes se normalizan antes de llegar al modelo — una foto de cámara pasa de 217 KB a 4 KB.
- **Harness**: cola durable con leases y recuperación tras crash, y ejecutores listos (`initHarnessExecutors`).

Con Hive SDK no montas un agente desde cero: **enganchas tu lógica de negocio en un harness ya armado**.

Y si además querés ponerle interfaz, no tenés que hablarle a la base de datos ni
imitar el formato que espera el modelo: `@johpaz/hive-sdk/services` expone el
mismo CRUD que usan las tools, en funciones tipadas.

## Instalación

> **Requiere Bun 1.4.2 o posterior y TypeScript 7.0.2.** El paquete se publica como TypeScript y usa APIs de Bun
> (`Bun.secrets`, `Bun.spawn`, Workers) en 18 archivos del core, así que no
> corre sobre Node aunque se le apliquen los flags de type-stripping. Si tu
> backend es Node, hoy la vía es un proceso Bun aparte; el build a JS que
> levantaría esa restricción todavía no existe.

### Compilar el SDK desde tu proyecto

Como el paquete se publica **en TypeScript**, tu `tsc` no lee declaraciones ya
validadas: recompila el código del SDK con **tu** configuración. Eso significa que
`skipLibCheck` no ayuda —sólo salta archivos `.d.ts`, y acá son `.ts` de verdad— y
que una config más estricta que la del SDK puede sacar errores en código que no
escribiste.

El SDK se mantiene compilable en los dos entornos de tipos que importan:

| entorno | `lib` | `types` | `strict` | errores |
|---|---|---|---|---|
| el del SDK | `ESNext, DOM, DOM.Iterable` | — | `false` | 0 |
| servidor (Bun) | `ES2022` | `["bun"]` | `true` | 0 |

Los dos entornos compilan con **0 errores sin** `allowImportingTsExtensions`
(los imports internos son sin extensión, como en `hive`) y también bajo
`noUncheckedIndexedAccess`. `test/consumer-typecheck.test.ts` lo comprueba en cada
corrida creando un proyecto de consumo con ambas configuraciones.

El SDK no importa ninguna librería de esquemas: las tools declaran sus argumentos
en **JSON Schema plano** (`parameters`), el mismo formato que ve el modelo y que
usa `hive`. No hay nada que instalar ni versiones que alinear con tu proyecto.

Para lograrlo, el core no usa alias que sólo existen en la lib DOM
(`RequestInfo`, `HeadersInit`, `BlobPart`): las uniones van escritas. Si tu
proyecto es un backend, no necesitás agregar `DOM` a tu `lib` para consumirlo
—y no conviene, porque `BufferSource` y `BlobPart` de DOM chocan con
`Uint8Array` y `Buffer` de Node en tu propio código.

Los `*.test.ts` no se publican, así que nada de la suite entra en tu typecheck.

Para actualizar un proyecto existente, consulta [UPGRADING.md](./docs/UPGRADING.md).
Los límites de entrada y controles de runtime están inventariados en
[SECURITY-GUARDRAILS.md](./docs/SECURITY-GUARDRAILS.md).

```bash
# Instalar globalmente para el CLI
bun install -g @johpaz/hive-sdk

# O en un proyecto
bun add @johpaz/hive-sdk
```

## CLI Commands

```bash
hives init <name>         # Inicializar proyecto agente
hives create-app <name>   # Crear aplicación harness completa
hives add-tool <name>     # Añadir tool
hives add-skill <name>    # Añadir skill
hives add-worker <name>   # Añadir Bun Worker
hives run                 # Ejecutar agente
hives test                # Test tools/skills
hives trace               # Ver logs de ejecución
```

## Inicio Rápido

### 1. Crear una app harness completa

```bash
hives create-app my-hive
cd my-hive
bun install
cp .env.example .env
bun run dev
```

### 2. Crear un agente simple

```typescript
import { createAgent, defineTool } from "@johpaz/hive-sdk";

const tool = defineTool({
  name: "saludar",
  description: "Saluda a alguien por su nombre",
  parameters: {
    type: "object",
    properties: { nombre: { type: "string", description: "a quién saludar" } },
    required: ["nombre"],
  },
  execute: async (args: { nombre: string }) => `¡Hola ${args.nombre}!`,
});

const agent = await createAgent({
  name: "asistente",
  provider: "openai",       // cualquiera de los 16 del catálogo
  model: "gpt-5.6-luna",    // tiene que existir en el catálogo sembrado
  tools: [tool],
});

const respuesta = await agent.run("Saluda a Juan");
console.log(respuesta);
```

`createAgent` abre HiveDB, siembra el catálogo de providers y modelos, persiste
la configuración en la fila del agente y deja tus tools indexadas para que el
modelo pueda descubrirlas. `parameters` (JSON Schema) es lo que ve el LLM —sin él,
la tool se ofrece sin argumentos— y también lo que se usa para validar la llamada:
si el modelo escribe `query` donde la tool espera `nombre`, recibe un error con los
parámetros que sí existen y puede corregirlo, en lugar de que la tool corra con un
argumento ausente.

### 3. Crear un worker especializado

```typescript
import { createWorker } from "@johpaz/hive-sdk";

const researcher = createWorker({
  name: "researcher",
  systemPrompt: "You are a research specialist. Provide concise, factual summaries.",
});

const result = await researcher.run("Research quantum computing advances");
console.log(result);
researcher.terminate();
```

### 4. Ejecutar workers en paralelo

```typescript
import { WorkerPool } from "@johpaz/hive-sdk";

const pool = new WorkerPool({ maxWorkers: 4 });

const tasks = [
  { id: "t1", message: "Summarize article A" },
  { id: "t2", message: "Summarize article B" },
  { id: "t3", message: "Summarize article C" },
];

const results = await pool.executeBatch(tasks);
console.log(results);
pool.shutdown();
```

### 5. Gateway HTTP/WebSocket

```typescript
import { startGateway } from "@johpaz/hive-sdk";

const server = await startGateway({
  host: "127.0.0.1",
  port: 18790,
  agentId: "coordinator",
});

console.log(`Gateway at http://127.0.0.1:18790`);
```

## Variables de Entorno

```bash
HIVE_HOME=~/.hive             # Directorio de datos (HiveDB vive en <HIVE_HOME>/data)
HIVE_DB_PATH=                 # Ruta explícita de la base; ":memory:" para efímera (más en docs/HIVEDB.md)
HIVE_HOST=127.0.0.1           # Gateway host
HIVE_PORT=18790               # Gateway port (inválido → avisa y usa el default)
LOG_LEVEL=info                # debug | info | warn | error
```

Desde Bun 1.4 `Bun.serve` lanza `RangeError` con un puerto fuera de `[0, 65535]`
o con `NaN` —lo que devuelve `parseInt("no-es-un-numero")`— en vez de recortarlo,
así que un `HIVE_PORT` mal escrito tumbaba el arranque con una excepción sin
capturar. El SDK lo resuelve con `resolvePort`: avisa y sigue con el default.

La API key de cada provider se guarda cifrada en la base. Como alternativa, el
SDK cae a `<PROVIDER>_API_KEY` del entorno, en mayúsculas y con el id del
provider tal cual. **Sólo sin inquilino** (app de escritorio, un proceso por
instalación): dentro de `runInTenant` el entorno es de la plataforma, no del
cliente, y no se usa nunca — la clave llega en `credentials` o desde los
secretos del inquilino. Ver [UPGRADING.md](./docs/UPGRADING.md#051-claves-aisladas-por-inquilino).

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...            # provider "gemini"
MODELSCOPE_API_KEY=ms-...
NVIDIA_API_KEY=nvapi-...
OPENROUTER_API_KEY=sk-or-...  # también activa Jev (con el provider openrouter habilitado)
```

## Tests

```bash
# Toda la suite
bun test

# Repartida entre procesos, uno por núcleo
bun test --parallel

# Timeout extendido
bun test --timeout 60000
```

`--parallel` (Bun 1.4) reparte los archivos entre procesos e implica
`--isolate`, un global nuevo por archivo. Medido en este repo: **48 s → 18 s**,
con resultados idénticos. Es lo que corre CI; en local `bun test` a secas sigue
siendo secuencial, que da una salida más legible cuando estás sobre un archivo.

La suite usa una base efímera (`HIVE_DB_PATH=":memory:"`, fijado en
`test/preload.ts`) para no escribir en la del usuario. El `preload` sigue
corriendo por archivo bajo `--isolate`.

## Publicar

```bash
# 1. Actualizar archivos, sin tocar git — revisá el diff
bun run version:set 0.1.6

# 2. Cuando estés conforme: typecheck + tests + commit + tag + push
bun run version:set 0.1.6 --push

# Preview que no se instala por defecto
bun run version:set 0.2.0-rc.1 --push --npm-tag=next
```

`--push` corre `typecheck` y `bun test` antes de tocar git, y pide confirmación
explícita. El tag `vX.Y.Z` es lo que dispara `.github/workflows/publish.yml`, que
publica **sólo el paquete raíz** (`packages/*` son workspaces internos). El
dist-tag viaja en el mensaje del tag, así que `--npm-tag=next` publica bajo `next`
y no mueve `latest`.

El script aborta si la versión ya existe en npm — republicar da 403 — y si el tag
local ya existe.

```bash
npm view @johpaz/hive-sdk dist-tags   # verificar después del release
```

## Documentación

| Documento | Descripción |
|-----------|-------------|
| [API-AGENTS.md](docs/API-AGENTS.md) | createAgent, AgentLoop, Tool/Skill Selector, los 16 LLM Providers, multi-inquilino y Jev |
| [ORACULO.md](docs/ORACULO.md) | Implementación con y sin oráculo (Jev / Kev): configuración, verificación de respuestas, coordinador y especialistas, mediciones |
| [API-CONTEXT-COMPILER.md](docs/API-CONTEXT-COMPILER.md) | Context Compiler, historial, Scratchpad, EthicsGuard, ACE |
| [API-TOOLS-SKILLS-CHANNELS.md](docs/API-TOOLS-SKILLS-CHANNELS.md) | Tools, Skills, MCP, Gateway, Channels, Tool Runtime, Storage |
| [API-DAG-SCHEDULER.md](docs/API-DAG-SCHEDULER.md) | DAGScheduler, TaskGraph, TaskNode, estrategias, presets |
| [API-WORKERS-EVENTS.md](docs/API-WORKERS-EVENTS.md) | Bun Workers, createWorker, WorkerPool, AgentBus, EventBus, Canvas |
| [HIVE-HARNESS.md](docs/HIVE-HARNESS.md) | Ejecución durable: cola de jobs, checkpoints, leases, proof packets |
| [TEMPLATE-HIVE-APP.md](docs/TEMPLATE-HIVE-APP.md) | Template `hive-app` — estructura, opciones, personalización |
| [CHANGELOG.md](CHANGELOG.md) | Cambios por versión |

---

*Hive SDK v0.7.2 — MIT*
