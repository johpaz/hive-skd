# {{APP_NAME}}

Aplicación de agentes construida sobre [`@johpaz/hive-sdk`](https://www.npmjs.com/package/@johpaz/hive-sdk).

## Arrancar

```bash
bun install
cp .env.example .env     # cargá al menos una API key
bun run dev
```

El gateway queda en `http://127.0.0.1:18790`. Probalo:

```bash
curl -X POST http://127.0.0.1:18790/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hola","threadId":"t1"}'
```

## Estructura

```
src/
  main.ts                 # arranque: base de datos, canales y gateway
  agents/coordinator.ts   # el agente principal
hive.config.ts            # gateway, canales y logging
```

`main.ts` llama a `ensureHiveDb()`, que abre HiveDB, crea los índices y siembra
el catálogo de providers y modelos. Es idempotente: correrlo en cada arranque es
justamente cómo se actualiza el catálogo.

## Cambiar de modelo

En `src/agents/coordinator.ts`. `provider` y `model` tienen que existir en el
catálogo sembrado, o `createAgent` lanza avisando cuál falta:

```typescript
export const coordinatorAgent = await createAgent({
  name: "coordinator",
  provider: "anthropic",
  model: "claude-opus-5",
  systemPrompt: "...",
});
```

Hay 18 providers y 106 modelos disponibles. La API key sale de la variable
`<PROVIDER>_API_KEY` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MODELSCOPE_API_KEY`…).

## Agregar una tool

```typescript
import { createAgent, defineTool } from "@johpaz/hive-sdk";

const clima = defineTool({
  name: "get_weather",
  description: "Consulta el clima de una ciudad. Sinónimos: tiempo, temperatura",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "la ciudad" } },
    required: ["city"],
  },
  execute: async ({ city }) => `Soleado en ${city}`,
});

export const coordinatorAgent = await createAgent({
  name: "coordinator",
  provider: "anthropic",
  model: "claude-opus-5",
  tools: [clima],
});
```

Dos cosas que conviene saber sobre cómo el agente usa las tools:

- El **`description` es lo que la hace encontrable**. El agente arranca con un
  loadout mínimo y descubre el resto buscando por capacidad, así que poner
  sinónimos en la descripción es lo que hace que aparezca cuando corresponde.
- **`parameters` (JSON Schema) son los argumentos que ve el modelo** y con los
  que se valida la llamada. Sin `parameters`, la tool se le ofrece sin argumentos.

## Comandos

```bash
bun run dev      # desarrollo
bun run start    # producción
hives add-tool <nombre>     # scaffold de una tool
hives add-skill <nombre>    # scaffold de una skill
hives trace                 # últimas ejecuciones del agente
```

## Datos

HiveDB vive en `<HIVE_HOME>/data` (por defecto `./.hive/data`). Para una base
efímera —tests— usá `HIVE_DB_PATH=":memory:"`.

## Docker

```bash
docker compose up -d
```

## Documentación

[github.com/johpaz/hive-sdk](https://github.com/johpaz/hive-sdk#readme)
