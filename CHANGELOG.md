# Changelog

## Sin publicar

### HiveDB 0.6.1

- `@johpaz/hive-db` sube a 0.6.1 (formato en disco nuevo: las bases viejas se migran solas y ya no abren con 0.5.x).
- El reindexado del catálogo de capacidades es incremental: hash por documento en la colección `capability_sync`.
- Memoria entre hilos (opt-in, `memory.crossThreadRecall`): los resúmenes de compactación se indexan y los de otros hilos del inquilino se inyectan por relevancia. Nuevo `agent/summary-memory.ts`.
- `memory.embedder: "local"` / `HIVE_EMBEDDER=local` abre la base con el embedder local. Experimental y apagado: aporta poco sobre BM25 y exige recalibrar los cortes relativos.
- El template `hive-app` cierra HiveDB y vacía las trazas en `SIGINT`/`SIGTERM`; `closeHiveDb` se exporta desde la raíz.

### El coordinador se entera de lo que el oráculo no pudo respaldar

- Cuando un especialista termina y el oráculo (Jev/Kev) no pudo respaldar su respuesta con la evidencia recogida (`oracleUnsatisfied`), **el coordinador lo recibe** en el resultado de la delegación: `verification: { status: "unsupported", corrections, note }`, con la nota «no la presentes como un hecho comprobado; dile al usuario qué está respaldado y qué no». Vale para `task_delegate` síncrono y para la delegación asíncrona (el resumen de cierre trae `verification` y la instrucción). Si el oráculo hizo corregir y la versión final quedó respaldada, llega `status: "corrected"` (sin pedir que se mencione). Si no tuvo nada que decir, el resultado es idéntico al de antes.
- `runAgentIsolatedDetailed` devuelve además `oracle: { corrections, unsatisfied }`. Nuevo `describeVerification` en `agent/oracle-checks`.
- **El worker delegado hereda el oráculo y la llave del turno que delega** (síncrono, solo en memoria; nunca viaja en un job persistido). Antes caía en la llave global del proceso y en el oráculo por defecto: con un inquilino, esa era la fuga entre inquilinos que `credentials` ya cerraba para el resto del loop.

### El oráculo valida: Jev o Kev, y se detecta cuándo se equivoca

- **`oracle`** (con `provider: "auto" | "openrouter" | "hiveagents"`) en `createAgent` y por llamada; `jev` sigue valiendo como alias. En `auto`: **Kev** si hay llave de HiveAgents LLM, si no **Jev** si hay OpenRouter, si no ninguno. Con inquilino solo cuentan sus propios secretos. *Cambio de comportamiento*: quien tenía OpenRouter y también una llave de HiveAgents pasa a Kev; `oracle: { provider: "openrouter" }` lo evita. Exportados `OracleOption`, `JevOption`, `JevVerify`, `JevShare`, `resolveOracle`, `resolveVerify`.
- **Verificación** (`oracle.verify`, activa por defecto): tras cada lote de tools el oráculo dice si el resultado responde al objetivo y, antes de entregar una respuesta que descansa en tools, si la evidencia la respalda. Si no, manda a corregir (máx. 2 por turno, una vez por firma). Con streaming, los tokens esperan al veredicto. `done.usage` trae `oracleCorrections` y `oracleUnsatisfied`; los eventos `jev_decision` suman los tipos `verify`, `answer` y `overruled`.
- **Autodetección de errores del oráculo**: aconsejar terminar sin que la respuesta se sostenga, pedir de nuevo un resultado omitido, o pedir una corrección que devuelve lo mismo cuentan como contradicción; tres seguidas dejan al oráculo de lado 5 minutos y el turno corre clásico (`getJevStatus` pasa a `fallback`).
- Nueva guía [`docs/ORACULO.md`](./docs/ORACULO.md): implementación con y sin oráculo (Jev/Kev), verificación, coordinador y especialistas, privacidad, mediciones y lista de comprobación.
- Código nuevo: `agent/oracle-checks.ts` (`TurnVerifier`), `verifyToolResults`, `verifyFinalAnswer`, `recordOracleOverruled`.

### Jev ya no poda lo que el modelo no ha leído

- **Corregido**: tras una ronda de varias tools (p. ej. tres búsquedas en paralelo), Jev podía marcar como "no necesarios" resultados de esa misma ronda, que el modelo todavía no había leído. El modelo recibía "[Previous tool result omitted]" en lugar de la evidencia, volvía a buscar y se enredaba: falsos "No tengo eso documentado" y turnos de hasta 450 s. Ahora solo se pueden omitir resultados de rondas anteriores.
- Medido contra el laboratorio (Qwen3.6, 12 preguntas, razonamiento apagado): con Kev la media bajó de 34,2 s a 18,4 s y los fallos de 3 a 1; con Jev por OpenRouter, 0 fallos (mediana 15,5 s; sin Jev, 12,9 s).
- `flushTraces` se importa de `@johpaz/hive-sdk/agent`, no de la raíz.

## 0.6.0

### El CLI y la app que genera funcionan

Hallado al instalar la 0.5.2 publicada en un proyecto vacío:

- **`hives` no se ejecutaba.** `packages/cli/bin/hives` tenía `#!/usr/bin/env node`
  y carga un `.ts`: Node no ejecuta TypeScript dentro de `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), ni con `bunx hives` ni con la
  instalación global. Ahora el shebang es `#!/usr/bin/env bun`.
- **La app de `create-app` no compilaba.** `src/main.ts` importaba
  `./agents/coordinator.ts` y `../hive.config.ts` con extensión (TS5097) y la app
  no traía `tsconfig.json`. Ahora los imports son sin extensión, el scaffold
  incluye un `tsconfig.json` (strict, `noUncheckedIndexedAccess`, sin
  `allowImportingTsExtensions`) y un script `typecheck`.
- `test/consumer-typecheck.test.ts` comprueba las dos cosas: el shebang y que una
  app recién generada compila.

### Arranque ligero

- **`createAgent({ seed: "minimal" })`**: no crea los especialistas del catálogo y deja activas solo las tools de arranque más las tuyas. Jev y el modelo ya no ven un catálogo que no es de la app. Por defecto sigue siendo `"full"`.
- **`createAgent({ browser: false })`**: no inicia el navegador; las tools `browser_*` responden que no está disponible.
- La privacidad de Jev (`share`, `endpoint`, `model`) ya existía desde 0.5.2; ahora está documentada en `docs/API-AGENTS.md`, que además corrige el ejemplo de `defineTool` (sin `parameters` el modelo no ve argumentos) y lista las opciones de `AgentConfig`.

### Calidad de código

- **Linter**: Biome (solo lint, sin formatear) con `bun run lint`; corre en CI antes del typecheck. Las pruebas de navegador (`BROWSER_TESTS=1`) no corren en CI, porque el entorno de GitHub no las soporta; se ejecutan en local.
- **`flushTraces()`**: espera las escrituras pendientes (trazas, uso) antes de cerrar la base de datos; antes una traza en vuelo podía perderse o fallar con "database closed".
- **Errores de BD en canales** (Discord, Slack, Telegram, WhatsApp): ya no se tragan en silencio; pasan por `bestEffort`, que los registra a nivel debug.
- **Corregido**: el comparador de abstracción del selector de tools solo ordenaba a un lado; el nivel del logger MCP no filtraba nada; `enableSandbox` de plugins prometía un aislamiento que no existe (ahora la documentación y el aviso lo dicen).
- **Corregido**: `browser_type` y `browser_script` ignoraban el parámetro `timeout`; ahora lo aplican (`withTimeout`).
- **Tipos**: `ToolExecutor.execute` y `ToolExecutionResult` usan `Record<string, unknown>` y `unknown` en vez de `any`, y `ToolResult.result` es `unknown`; quien lea el resultado debe comprobar su forma.
- Código muerto eliminado y `runAgent()` pasó de ~1.080 a ~810 líneas sin cambiar su comportamiento: salieron `recordTurnCompletion`, `requestTerminalSynthesis`, `restoreFromCheckpoint`, `applySearchKnowledgeResult` y `userMessageText`. Nueva prueba de reanudación desde checkpoint (`agent-loop-resume`), que pasa igual antes y después del cambio.

### Dependencias: menos paquetes y mayores al día

- **Se quitan 4 dependencias sin uso:** `groq-sdk` (el proveedor de Groq usa la
  base compatible con OpenAI, no el paquete), `@sapphire/snowflake`,
  `jsonwebtoken` y `@types/jsonwebtoken`. `async-mutex` pasa a
  `devDependencies`: solo lo usa `test/memory-perf.test.ts`.
- **Mayores actualizados:** `openai` 6 → **7.27**, `@google/genai` 1 → **2.27**,
  `@anthropic-ai/sdk` 0.74 → **0.131** y `@slack/bolt` 4 → **5.1**. Compilan sin
  cambios de código y la suite pasa (869). Verificación real: `openai` contra el
  servidor del laboratorio (tool calls, streaming interno, cabeceras que
  Cloudflare no bloquea) y `@google/genai` contra Gemini (`gemini-3.8-flash`,
  tool call y tokens de razonamiento). **`@anthropic-ai/sdk` y `@slack/bolt` solo
  están verificados con tipos y pruebas, sin llamada real** (no hay claves).
- `openai` 7 declara Node ≥ 22; el SDK corre sobre Bun, que ignora `engines`.
- `bun audit`: 0 vulnerabilidades.

## 0.5.2

> ⚠ **Incluye un cambio incompatible** (`defineTool({ schema })` → `parameters`)
> en una versión de parche. Un rango `^0.5.1` la instala sola; quien use `schema`
> debe migrar (ver abajo).

### Cambio incompatible — las tools se declaran con JSON Schema

- **Sin zod: `defineTool({ parameters })` con JSON Schema. Cambio incompatible.**
  `defineTool` recibía un esquema de zod del host (`schema: z.object(...)`) que el
  SDK convertía con `z.toJSONSchema`. Con una copia propia (4.4.3) y la del host
  (4.6.5), TypeScript rechazaba el esquema (`ZodObject … is not assignable to
  ZodType`), y `hive` —que declara sus tools en JSON Schema— no lo necesitaba.
  Ahora los argumentos se declaran en **JSON Schema plano**, el formato que ve el
  modelo y que ya usaban las tools nativas:

  ```ts
  // antes
  defineTool({ name: "clima", description: "…", schema: z.object({ ciudad: z.string() }), execute })
  // ahora
  defineTool({
    name: "clima",
    description: "…",
    parameters: { type: "object", properties: { ciudad: { type: "string" } }, required: ["ciudad"] },
    execute,
  })
  ```

  `schema` ya no existe: `defineTool` lo rechaza con un mensaje que explica el
  cambio, en vez de ignorarlo y ofrecer la tool sin argumentos. `defineTool`
  también comprueba la definición al declararla (nombre, descripción, `execute`,
  `parameters.type === "object"`, `required ⊆ properties`).
  - **Validación de argumentos sin librerías** (`validateToolArgs`, exportada):
    `type`, `enum`, `required`, `properties` anidadas, `items`,
    `minimum/maximum`, `minLength/maxLength`, `pattern` y
    `additionalProperties: false`. `ToolExecutor` valida con ella, y ahora
    también las tools de `createAgent`: si la llamada no cumple, la tool no corre
    y el modelo recibe un error con lo que falta y **los parámetros que sí
    existen** (`falta "consulta". Parámetros de buscar: consulta. Recibí: query`),
    que es lo que necesita para corregir cuando inventa un nombre de argumento.
    Un tipo de esquema que no conoce lo deja pasar.
  - `config/loader.ts` usaba zod solo para derivar tipos (`z.infer`): no había
    ningún `.parse()`. Los esquemas pasan a `interface`; los tipos exportados
    (`Config`, `ProviderConfig`, `MCPServerConfig`, `AgentEntry`, `Binding`,
    `UserConfig`) son idénticos (se comprobó igualdad de tipos en ambos sentidos).
  - `zod` sale de `dependencies` y de `peerDependencies`. Sigue en `node_modules`
    porque `@modelcontextprotocol/sdk` lo trae, pero el SDK ya no lo importa y los
    hosts no tienen que instalarlo ni alinear versiones.

### Jev decide con conocimiento del agente, y el razonamiento depende de la tarea

Medido contra un servidor llama.cpp con Qwen3.6 35B: el contexto de un
especialista pesa ~550–1000 tokens y Jev ahorraba ~59, así que el tiempo de una
respuesta no estaba en el contexto sino en el razonamiento. La misma pregunta
corta costó 618 tokens / 9,9 s con razonamiento y 39 tokens / 0,6 s sin él.
`agent-loop` lo pedía siempre (`thinking: { enabled: true }`) y el proveedor
`hiveagents` solo enviaba el parámetro de apagado para Gemma 4 y AgentWorld.

- **`thinking: "on" | "off" | "auto"` por agente** (`AgentConfig`,
  `CreateAgentInput`, `AgentDoc`). `"on"` —el valor si falta— conserva el
  comportamiento de siempre. `"off"` nunca razona. `"auto"` lo decide Jev por
  turno con la pregunta `effort` (`direct` | `reason`); `direct` exige
  confianza ≥ 0,7 y cualquier otra respuesta razona, porque equivocarse al no
  razonar cuesta calidad y equivocarse al razonar solo cuesta tiempo. Sin Jev,
  `"auto"` equivale a `"on"`. `compileContext` devuelve el valor resuelto en
  `thinking`.
- **Jev también decide la longitud** (`length`: `brief` | `standard` |
  `detailed`) cuando el agente está en `"auto"`; se añade una línea al system
  prompt. Ambas decisiones viajan en `jev_decision` (`effort`, `length`).
- **Proveedor `hiveagents`:** con `thinking.enabled === false`, Qwen3.x recibe
  `chat_template_kwargs: { enable_thinking: false }` a nivel superior del cuerpo,
  en lugar del prefijo `/no_think` que Qwen3.6 no respeta de forma fiable.
- **Las herramientas declaradas no se podan.** Si el agente tiene allowlist,
  Jev no pregunta por esas tools: son el contrato del agente, no algo
  descubierto. Antes, para una pregunta conceptual, Jev podía quitarle a un
  especialista de búsqueda su única herramienta y el modelo respondía sin
  buscar. Lo descubierto con `search_knowledge` sigue siendo podable.
- **Jev sabe para quién decide.** `state.agent` (nombre, rol, descripción y un
  extracto de ≤400 caracteres de las instrucciones) y las preguntas de
  historial, tool, skill, nota y regla se redactan "para el agente de
  `state.agent`".
- **`jevRoute(objective, candidates, { jev, minConfidence })`**: elige un
  especialista con una pregunta cerrada (~0,3 s) en vez de un turno del modelo
  principal. Devuelve `null` sin decisión (sin clave, `jev: false`, un solo
  candidato, respuesta inválida o confianza < 0,7) para que el llamador use su
  propio enrutamiento.
- **Al vencer el tope de una llamada al modelo se aborta la petición.**
  `withTimeout` solo dejaba de esperar: el servidor seguía generando para nadie.
  Con un modelo local de un solo slot la cola quedaba ocupada y las llamadas
  siguientes también vencían (medido: tres timeouts seguidos de 180 s con 0
  tokens). El tope es configurable con `HIVE_LLM_CALL_TIMEOUT_MS` (detrás de un
  túnel de Cloudflare una petición sin streaming muere a ~100 s con un 524).
- **`jev: { apiKey, endpoint, model }`:** apunta Jev a un modelo de decisión
  propio (llama.cpp sirve `/v1/systemone`) en vez de OpenRouter; entiende la
  respuesta `{ choice, probabilities }` y no registra costo.
- **El SDK compila en el proyecto de quien lo usa.** Los imports internos
  llevaban extensión `.ts`: `tsc` daba `TS5097` en cada uno (707 errores) salvo
  que el host activara `allowImportingTsExtensions`, y `hive` —que los escribe
  sin extensión— no lo necesitaba. Ahora son sin extensión (1 247 imports en 239
  archivos; las rutas de archivo en runtime, como `new URL("./tool-worker.ts")`,
  no cambian). Además se corrigieron los 87 accesos de índice que
  `noUncheckedIndexedAccess` marcaba como posiblemente `undefined`.
  `test/consumer-typecheck.test.ts` compila un proyecto de consumo con la config
  del README y con la más estricta, sin esa opción.
- **Dependencias.** `bun update` + subir los pisos de rango: de 23
  vulnerabilidades transitivas (10 altas: axios vía `@slack/bolt`, `fast-uri`/
  `hono`/`ip-address` vía `@modelcontextprotocol/sdk`, `undici` vía `discord.js`)
  a **0**. `@modelcontextprotocol/sdk` 1.29 → **1.32**; `openai` → 6.49;
  `@google/genai` 1.52; `discord.js` 14.27; `docx`, `grammy`, `jszip`, `mammoth`,
  `ollama`, `pdfjs-dist`, `toon-format-parser` a su última dentro del rango. Los
  mayores (`openai` 7, `@google/genai` 2, `@anthropic-ai/sdk` 0.131,
  `@slack/bolt` 5, `groq-sdk` 1) quedan fuera de este cambio.
- **Pruebas de MCP reales.** La suite no tenía ninguna: `test/mcp-client.test.ts`
  conecta `MCPClientManager` por stdio y por Streamable HTTP a servidores hechos
  con el propio `@modelcontextprotocol/sdk` (`test/fixtures/mcp-echo-server.ts`),
  lista la tool, la llama, lee un recurso y comprueba el estado de error.
- **Privacidad configurable:** `jev: { apiKey, share: { instructions, history,
  toolResults } }` (todo `true` por defecto) decide qué sale hacia el modelo de
  decisión. Con Jev activo viaja el objetivo del turno (el mensaje del usuario;
  sin él Jev no decide nada), el extracto de las instrucciones del agente
  (≤400 caracteres), fragmentos de mensajes anteriores, y fragmentos de
  resultados y argumentos de tools. Apagar una pieza solo quita las decisiones que
  la necesitan, nunca corrección: `instructions:false` omite el extracto (Jev
  juzga una tool solo por su nombre); `history:false` no envía ni pregunta por
  mensajes anteriores y los conserva todos; `toolResults:false` desactiva la poda
  entre iteraciones y la decisión de paralelismo. Si no queda nada que preguntar,
  no sale ninguna petición. `resolveShare` se exporta para los hosts.

## 0.5.1

### Seguridad — claves aisladas por inquilino

- **Secretos filtrados entre inquilinos por la caché en memoria.** El
  almacén de secretos cacheaba cada valor descifrado en un `Map` del proceso
  indexado sólo por nombre (`provider:openai:api_key`), y el llavero del SO
  también es de toda la máquina. La colección `secrets` sí está particionada,
  pero la caché la tapaba: después de que un inquilino leyera o guardara su
  clave, `loadProviderApiKey` le devolvía esa misma clave a cualquier otro
  inquilino del proceso, y `resolveProviderConfig` la usaba para cobrarle a
  la cuenta equivocada cuando la llamada no traía `credentials`. Ahora la
  caché se indexa por inquilino y, con un inquilino activo, el llavero del SO
  no se lee, no se escribe ni se borra. Sin inquilino (escritorio) todo sigue
  igual.
- **La clave del entorno ya no se usa en nombre de un inquilino.** Con un
  inquilino activo y sin `credentials` ni clave guardada, `resolveProviderConfig`
  caía en `<PROVEEDOR>_API_KEY` del proceso, que es la cuenta de la plataforma;
  lo mismo OCR (`vision-service`), voz (STT/TTS), `computer_use` y Jev. Ahora
  todos pasan por `envSecret(nombre)`, que dentro de un inquilino devuelve
  `undefined`. Los adaptadores de Anthropic, Gemini y Gemini Live pasan siempre
  una cadena al SDK del proveedor, porque con `undefined` esos SDK leían la
  variable de entorno por su cuenta. **Cambio de comportamiento:** un host
  multi-inquilino que dependía de ese respaldo tiene que pasar la clave en
  `credentials` o guardarla en los secretos del inquilino; sin eso la llamada
  falla por falta de clave en vez de cobrarse a la plataforma. Sin inquilino
  (escritorio) el entorno sigue siendo el último respaldo.
- Nuevo `envSecret(nombre)` en `@johpaz/hive-sdk/storage`: la variable de
  entorno sólo fuera de un inquilino. Úsalo en tus propias tools en lugar de
  `process.env.X_API_KEY`.
- Quitado `loadDurableProviderApiKey` (interno, agregado en 0.5.0 y nunca
  exportado por un barrel): `loadProviderApiKey` ya es seguro por inquilino.

## 0.5.0

### Jev — plano de decisión (OpenRouter Decisions)

Portado de hive 1.1.0. Jev decide por turno qué historial, herramientas,
skills, notas y reglas del playbook entran al contexto; entre iteraciones poda
resultados viejos de herramientas y sugiere la siguiente acción; decide si un
lote de herramientas corre en paralelo, y conoce el mapa del enjambre
(especialistas y estado de cada MCP) para recomendar a quién delegar.
**Sin clave de OpenRouter, Jev no existe y todo corre igual que antes.**

- **Clave inyectable por llamada**: `jev?: { apiKey, mcpSettingsPath? } | false`
  en `AgentLoopOptions`, `compileContext`, `IsolatedAgentOptions`,
  `runRoleSwarm` y `runSwarm`, igual que `credentials`. `false` lo apaga;
  sin la opción decide la fila `openrouter` del inquilino actual. Con un
  inquilino activo **nunca** se usa `OPENROUTER_API_KEY` ni la caché de
  secretos del proceso: la clave de la plataforma no se usa en nombre de un
  cliente.
- **Estado por inquilino**: fallos, cooldown y totales se llevan por
  `currentTenant()`; una clave inválida de un cliente no pone en fallback a
  los demás.
- **Evento para el host**: cada decisión llega por `onStep` como
  `StepEvent` `jev_decision` (`jev`: agente, tipo, resumen, tokens ahorrados,
  latencia, costo, especialista recomendado, MCP apagados). También se emite
  `canvas:jev_decision` / `canvas:jev_status` para hosts tipo hive.
- **Uso y costo**: `recordJevDecision` y los campos `jev*` de
  `UsageRollupDoc`; `getUsageStats()` devuelve `jev` con el total y el
  desglose por agente. El ahorro se estima (caracteres/4) y se cotiza con el
  modelo del agente asesorado.
- **Catálogo**: modelo `openrouter/typesafe/jev-1.13` con `modelType:
  "decision"`, excluido de `get_available_models` (y de `getDefaultLLM`, que
  sólo toma modelos `llm`).
- Herramienta nueva `conversation_read`: recupera mensajes o notas que Jev
  dejó fuera del contexto, siempre dentro del hilo actual.
- `executeToolBatch` acepta `parallelToolCalls` por lote.
- `NarrationEventDoc.kind` suma `"decision"`: un host puede anotar las
  decisiones de Jev en `narrationEvents` para sus vistas de actividad.
  `shouldDeliverToChannel` nunca lo entrega a un canal.
- `loadDurableProviderApiKey(id)`: lee la clave sólo de la colección
  `secrets` (particionada por inquilino), sin pasar por la caché de proceso ni
  el llavero del SO.

**Privacidad.** Con Jev activo se envían a la API de decisiones de OpenRouter
(`https://openrouter.ai/api/alpha/decisions`), con la clave del workspace:
el objetivo del turno (hasta 3 500 caracteres), extractos de hasta 450
caracteres de mensajes previos del hilo, nombre y descripción de herramientas
y skills candidatas, notas del scratchpad y reglas del playbook (hasta 350
caracteres cada una), extractos de resultados de herramientas (hasta 650
caracteres), argumentos de llamadas en lote (hasta 700) y el mapa del enjambre
(ids, nombres y descripciones de especialistas, nombres y estado de los MCP).
No se envían ids de MCP con prefijo de inquilino, credenciales ni adjuntos
binarios. Un host que no quiera enviar nada pasa `jev: false`.

### Plataforma y seguridad

- Runtime mínimo actualizado a **Bun 1.4.2** en `engines`, CI, publicación y
  aplicaciones generadas.
- Compilador actualizado a **TypeScript 7.0.2**. Se adaptaron las fronteras de
  streams SSE, opciones WebSocket de Bun y memoria de audio a los tipos nuevos,
  sin desactivar el chequeo.
- Corregidas las alertas altas de PDF.js y SheetJS; los lectores Office ahora
  limitan tamaño, páginas, hojas, filas y tiempo de procesamiento, y PDF.js
  desactiva scripting y evaluación dinámica.
- Eliminada la cadena vulnerable `pptxgenjs > image-size`. Hive conserva sólo
  el artefacto ESM oficial necesario para PPTX de texto, con licencia,
  procedencia, hash y una prueba funcional del OOXML generado.
- Añadidas las guías `docs/UPGRADING.md` y
  `docs/SECURITY-GUARDRAILS.md` para operación y auditoría.
- **Requiere `@johpaz/hive-db` ^0.5.1** (antes ^0.4.0). Trae las lecturas del
  log causal acotadas por agente (`agents` en `causalThread`, `toolStats` y
  `buildAgentContext`), de las que depende el aislamiento entre inquilinos del
  log causal descrito en *Corregido*.

### WhatsApp por la API oficial de Meta

- **Canal nuevo `whatsapp_cloud`**: WhatsApp Business por la Cloud API, que es
  lo que puede usar una empresa. Incluye `WhatsAppCloudClient` (texto con
  partido automático en 4096 caracteres, plantillas, audio, marcar leído con
  "escribiendo…" y descarga de medios), las funciones de webhook
  (`verifyWhatsAppSignature`, `verifyWhatsAppChallenge`, `parseWhatsAppWebhook`)
  y el canal `WhatsAppCloudChannel`. Sin dependencias nuevas: sólo `fetch`.
- El gateway enruta `GET|POST /webhooks/whatsapp-cloud/:accountId` cuando se le
  pasa `channelManager`. Meta exige HTTPS público, así que hace falta un proxy
  inverso o un túnel por delante.
- La versión del Graph se resuelve en un solo lugar (`META_GRAPH_API_VERSION`,
  por defecto **v26.0**). Cada versión caduca a los ~2 años y Meta redirige en
  silencio a la más vieja que siga viva; tenerla centralizada es lo que evita
  enterarse tarde.
- Fuera de la ventana de 24 h el canal manda la plantilla de
  `windowFallbackTemplate`, y si no hay ninguna configurada lanza un error que
  lo dice (131047). La narración de progreso no se envía por defecto
  (`sendProgress: false`): desde el 1/10/2026 Meta cobra cada mensaje de
  servicio dentro de la ventana.
- El parser recorre todas las `entry` y `changes` del webhook, y el canal
  descarta los reintentos de Meta por id de mensaje.
- **Baileys se carga recién al conectar el canal `whatsapp`.** Antes se
  importaba al cargar el índice del SDK, así que cualquier consumidor —aunque
  no usara canales— se traía Baileys entero y su parche de
  `process.stderr.write` en cada proceso. Quien usa el canal por código QR no
  ve ningún cambio.

### Catálogo compartido entre inquilinos

- **El catálogo se instala una sola vez.** `tools`, `skills` y `ethics` dejan de
  copiarse en la partición de cada inquilino: su contenido vive en la colección
  sin prefijo —la misma que ve una instalación local— y cada inquilino guarda
  únicamente lo que activó, en `catalogActivations`. Un enjambre nuevo arranca
  con **cero escrituras** de catálogo, y encender una tool guarda una fila de
  elección en lugar de una copia de la fila entera.
- **Providers y modelos ya no se resiembran dentro de un inquilino.** En un host
  multi-inquilino el catálogo que vale es el del host, así que `seedAllData()`
  saltea el estático cuando hay tenant activo. Antes borraba y recreaba los 139
  modelos de `SEED_DATA` en la partición de cada enjambre, en cada arranque, para
  que un instante después los pisara el host.
- Lo que un inquilino **crea** sigue siendo suyo y privado: las tools de un
  endpoint de API, o una skill o un código de ética propios, se escriben en su
  partición como siempre. Editar el contenido de una fila del catálogo también
  deja una copia privada, y borrarla la oculta sólo para él.
- API nueva en `@johpaz/hive-sdk/storage`: `setCatalogActivation`,
  `clearCatalogActivation`, `listCatalogActivations`, `sharedCatalogCol`,
  `CATALOG_COLLECTIONS` y el tipo `DocStore`, que es lo que ahora devuelve
  `col()` — la clase `Collection` de hive-db lo satisface tal cual, así que no
  cambia nada para quien la recibe.
- **Sin inquilino en scope no cambia nada**: una instalación local sigue viendo
  una sola partición, con el catálogo y su `active` en la misma fila.
- **El índice de capacidades también se comparte, y eso destapa dos fallas que
  ya existían.** Todo documento declara ahora su ámbito —el inquilino que lo
  escribió, o `_` si es del catálogo— y `searchCapabilities()` consulta los dos
  cuando hay inquilino activo:
  - Antes el catálogo se indexaba **sin** filtro de inquilino y la búsqueda
    desde un enjambre filtraba **por** su inquilino, así que dentro de un
    enjambre no se encontraba NADA del catálogo: ni una tool ni una skill. El
    agente sólo descubría sus tools de MCP y las de sus endpoints.
  - Y un reindexado del catálogo —el que corre en cada arranque del gateway—
    borraba por `type` a secas, llevándose por delante lo que cada inquilino
    tenía indexado. Ahora el borrado va acotado a su ámbito.
  - Encima de la búsqueda manda la elección: una capacidad que el inquilino
    apagó no se le ofrece, aunque esté en el catálogo y puntúe primero.
  Cubierto por `packages/core/src/agent/capability-search.test.ts` y
  `packages/core/src/storage/catalog.test.ts`.

### Corregido

- **Con un tenant activo, el log causal se apagaba en lugar de acotarse.**
  `causalThread`, `toolStats` y `buildAgentContext` recorrían todos los shards
  de la base, así que con un tenant en scope `causalReadsEnabled()` las apagaba:
  en un host multi-inquilino el reflector G9 y el contexto causal del
  compilador no corrían nunca. Ahora las tres lecturas van siempre acotadas a
  los agentes que corresponden —el agente del turno, o los del lote de trazas— y
  el apagado desaparece. Además el shard de cada evento pasa a ser
  `causalAgentKey(agentId)`: con tenant lleva el tenant delante (`t_…:agente`,
  la misma forma que los ids del índice BM25), así que dos inquilinos con un
  agente del mismo id ya no comparten shard. Una lista de agentes vacía se salta
  la lectura en vez de pasarse al motor, que la trataría como "todos los
  shards". Cubierto por `test/causal-tenant-scope.test.ts`.

- **`browser_scrape` extraía con una tool que no ve lo que el navegador
  renderizó.** La skill existe para sitios dinámicos, y su paso de extracción
  usaba `web_fetch`, que vuelve a pedir la URL al servidor y recibe el HTML sin
  JavaScript ejecutado: en un SPA, una cáscara vacía. Pasa a usar
  `browser_extract`, que lee el DOM ya renderizado, con un `browser_wait` previo.
  (Uno de sus ejemplos citaba además `browser_fetch`, que no existe.)

- **`browser_automate` no esperaba a los elementos.** Sus pasos iban de navegar a
  hacer clic sin `browser_wait` en el medio, que es la falla más común de la
  automatización web y falla en silencio. Se agregó el paso y el orden de
  escalada: selector → `browser_script` → `computer_use_task`.

- **La tabla de campos de `cron_manager` omitía la mitad de lo que acepta la
  tool**: `max_runs`, `payload`, `agent_id` y `tool_name`. También documentaba
  expresiones de 5 campos cuando el motor acepta 6, y no aclaraba que la zona
  horaria sale del perfil del usuario y no se pasa en la llamada.

- **Los contadores del scheduler perdían actualizaciones.** `run_count` y
  `error_count` se calculaban desde una lectura hecha antes del bucle de
  reintento de `updateJob`, así que al reintentar por conflicto de versión se
  reescribía el valor viejo. Con dos corridas solapadas del mismo job —normal en
  uno que tarda más que su intervalo y no declara `protect`, y garantizado en la
  puesta al día por misfire, que llama a `execute()` en paralelo con el job ya
  activado— ambas leían `error_count: 4` y ambas escribían 5. La consecuencia no
  era el número: es que el umbral de auto-pausa (5 errores seguidos) no se
  alcanzaba nunca y un job que fallaba siempre se quedaba reintentando para
  siempre. `updateJob` ahora acepta un parche en forma de función, que se evalúa
  contra la lectura fresca de cada intento. Es el mismo error que ya se corrigió
  en `touchThread`. Cubierto por `packages/core/src/scheduler/scheduler.test.ts`.

### Agregado

- **El seed inicial de especialistas es una elección.** `ensureHiveDb()` y
  `seedAllData()` aceptan `specialists: "all" | "none" | string[]`. Con `"none"`
  la colmena arranca sin ningún especialista y con sólo las `MINIMAL_TOOLS`
  activas —la competencia del coordinador—, y son los enjambres los que traen
  consigo a los suyos. `"all"` sigue siendo el default, así que nada cambia para
  quien no lo pida.

  La elección alcanza también a las **capacidades**, no sólo a los agentes: una
  fila de tool o skill que nace en un arranque `"none"` nace inactiva. Antes
  `active` defaulteaba a `true` para toda fila nueva, así que un arranque sin
  especialistas dejaba igual las 62 tools encendidas — el usuario terminaba
  apagando a mano lo que nunca pidió.

  **Nunca borra.** La elección gobierna qué se crea, no qué se conserva: una
  base que ya tiene sus ocho agentes no pierde ninguno por arrancar con
  `"none"`, y se siguen reconciliando en cada arranque.

  `createSwarm` acepta ahora miembros del catálogo que todavía no tienen fila:
  con el seed en `"none"` un enjambre es el **pedido de instalación**, no una
  referencia a algo que ya debería existir. Un id que no es del catálogo y no
  existe sigue siendo un error.

- **Crear un enjambre ahora siembra sus especialistas.** El seed selectivo
  (`applySeedPlan`) dejaba elegir qué personas del catálogo instalar, pero
  `createSwarm` no lo miraba: guardaba el enjambre **sin una queja** con
  miembros apagados y sus tools inactivas. La validación de "el agente existe"
  pasaba igual, porque el seed crea las 8 filas siempre y sólo cambia `enabled`
  — el enjambre quedaba definido y sin poder trabajar.

  `createSwarm` y `updateSwarm` aceptan `activateMembers`, **`false` por
  defecto**: crear un enjambre no debería cambiar en silencio qué capacidades
  tiene la instalación entera, así que sin él el enjambre se crea igual y el
  faltante vuelve en `pendingActivation` para que la UI lo muestre y el usuario
  decida. Con `true` se activa la unión con lo que ya estaba, de modo que
  encender los especialistas de un enjambre nunca apaga los de otro.

  Se agregó `planActivationFor(agentIds)`, que devuelve el faltante **sin
  encender nada** —para el "esto se va a activar" antes de confirmar— y
  `enableCatalogAgents(ids)` en plural, porque activarlos de a uno reescribía el
  catálogo entero una vez por agente. Cubierto por `test/swarm-seed.test.ts`.

- **Skills para las capacidades que no tenían ninguna.** `image_editor`
  (`image_metadata`, `image_transform`, `artifact_inspect`) y `artifact_reader`
  (`artifact_read`, `artifact_inspect`). Las tools existían pero ninguna skill
  las enseñaba, así que el modelo sólo podía dar con ellas de casualidad vía
  `search_knowledge` — y en el caso de los artefactos eso deja inerte todo el
  mecanismo de `artifact_ref`, que existe justamente para que los archivos
  grandes no entren en la ventana de contexto.


- **`sessionStart` y `sessionEnd` ya se disparan.** Eran registrables desde que
  se implementaron los hooks, pero nada los invocaba. Van enganchados a las
  cuatro transiciones del ciclo de vida del hilo (crear, reabrir, archivar,
  borrar), todas en `agent/thread-store.ts`. `sessionStart` cuelga del `put` que
  crea la fila y no de `createSession`, que es idempotente y se llama en cada
  turno: enganchado ahí habría contado mensajes en vez de conversaciones.
  `closeSession`/`reopenSession` pasan a delegar en los nuevos `archiveThread`
  y `unarchiveThread` para que las cuatro transiciones vivan en un solo archivo.
  Cubierto por `test/hooks.test.ts`.

### Quitado

- **Cero dependencias para el cron: fuera `croner` y `cron-parser`.** El motor
  ahora es propio (`scheduler/cron/`) y usa sólo `setTimeout` e `Intl` del
  runtime. `cron-parser` además ni siquiera se importaba: estaba declarada en
  los dos `package.json` y se la bajaba todo el que instalara el SDK.

  `Bun.cron()` **no** sirve como reemplazo —reevaluado contra Bun 1.4.2—:
  acepta sólo 5 campos, rechaza una fecha ISO como patrón (que es como se
  agendan los jobs `one_shot`), no acepta una zona distinta por job, y su handle
  no expone la próxima corrida, de donde sale `next_run_at` y con lo que se
  detectan las corridas perdidas al arrancar. Tampoco tiene equivalente de
  `protect`, `maxRuns`, `interval`, `startAt`/`stopAt` ni `domAndDow`, todos
  campos persistidos de `CronJobDoc`.

  El motor propio conserva la superficie entera, así que `CronScheduler` no
  cambió de comportamiento, e implementa además los dos casos de horario de
  verano que se rompen callados: la hora que **no existe** al adelantar el
  reloj (se saltea ese día en vez de correr a una hora inventada) y la que
  **ocurre dos veces** al atrasarlo (corre en la primera, una sola vez). El
  motor se exporta suelto desde `./scheduler` —`Cron`, `parseCronExpression`,
  `isValidCronExpression`, `nextOccurrence`— para validar o previsualizar sin
  montar un scheduler. Documentado en `docs/API-CRON.md`. Cubierto por
  `packages/core/src/scheduler/cron/cron-engine.test.ts` (28 tests).

- **`CronerOptions` (tipo público).** Estaba declarado dos veces —en
  `scheduler/types.ts` y en `swarm/types.ts`— y no tipaba nada en ninguna parte:
  un tipo muerto con el nombre de una librería que ya no se usa. Su forma es la
  de `CronOptions`, que ahora exporta el motor desde `./scheduler`.

- **Menciones a Croner en lo que lee el modelo.** Las descripciones de
  `cron.create` (`start_at`, `stop_at`, `dom_and_dow`) y la skill `cron_manager`
  citaban opciones "de Croner". Eso entra en el prompt: nombrarle al modelo una
  librería que el código ya no usa lo manda a buscar documentación que no
  aplica. Quedan sólo las referencias históricas que explican por qué el motor
  es propio.

### Seguridad

- **El playbook ACE no distinguía de quién era lo aprendido.** `PlaybookDoc` y
  `ReflectionDoc` no tenían `user_id`, así que la cadena entera —trazas →
  reflexión → regla → inyección en el system prompt— era global: lo que el
  agente aprendía interactuando con una persona se le aplicaba a todas las demás
  del mismo proceso. Es el mismo supuesto de "un solo usuario" que ya se había
  cerrado en `memory`. Ahora el reflector agrupa las trazas por usuario
  (derivado del `thread_id`), el curador propaga el dueño a la regla y deduplica
  dentro del usuario, y las tres puertas de lectura filtran a global + propio:
  `selectPlaybookRules(texto, userId)`, `EthicsGuard.getRules(rol, userId)` y la
  tool `search_knowledge`. Las reglas sembradas siguen siendo globales a
  propósito (`user_id: ""`): son conocimiento del producto, no de nadie.
  `ensureHiveDb()` migra las filas anteriores asignándolas al primer usuario de
  la base — dejarlas sin dueño las volvería globales, que es justo lo que se
  viene a cerrar. Cubierto por `test/playbook-isolation.test.ts`.

- **La lista blanca de tools no se aplicaba al descubrimiento dinámico.**
  `compileContext` sólo recortaba `allTools` cuando el agente era de catálogo
  (`source === "catalog"`). Un agente creado por el usuario veía su loadout
  inicial restringido, pero `search_knowledge` busca contra el índice completo y
  el agent loop inyecta lo que encuentre resolviéndolo contra `allTools`: la
  tool excluida terminaba siendo llamable igual. Ahora la restricción depende de
  que el agente declare una lista, no de su origen. Cubierto por
  `test/tool-allowlist-discovery.test.ts`.

- **Aislamiento de credenciales entre inquilinos.** `AgentLoopOptions` no tenía
  forma de recibir la key del proveedor, así que la única fuente era el secret
  store de HiveDB o `process.env[PROVIDER_API_KEY]`, ambos globales al proceso.
  Un host multi-tenant que corriera dos workspaces en el mismo proceso les daba
  la misma credencial. Se agregó `credentials` en `AgentLoopOptions`,
  `IsolatedAgentOptions` y `resolveProviderConfig`; la credencial de la llamada
  gana y corta ahí, sin consultar las fuentes globales ni mutar `process.env`.
  Retrocompatible: sin `credentials` el comportamiento es el de siempre.
  Cubierto por `test/tenant-isolation.test.ts`.


- **`sanitizeDiagnostic` dejaba el token en claro detrás del esquema de auth.**
  La regex consumía sólo la palabra `Bearer`, así que un diagnóstico con
  `authorization: Bearer <token>` quedaba como `authorization: [REDACTED] <token>`
  y la credencial viajaba al prompt del coordinador. Afecta a **0.1.5 y
  anteriores**: el archivo viaja en el tarball publicado.

### Cambiado

- **El `toolStats` del reflector se acota a los agentes del lote**, también sin
  tenant. Antes sumaba el historial de la tool de todos los agentes de la base;
  ahora el de los agentes cuyas trazas se están analizando. Es la misma
  semántica con y sin tenant, y no recorre el log entero.

- **Los tests que manejan un navegador real son opt-in (`BROWSER_TESTS=1`).**
  Su guarda era `isWebViewSupported()`, que sólo comprueba que exista un binario
  de Chromium — no que arranque. En un runner de CI (contenedor, a menudo root)
  el binario está y Chromium muere igual sin `--no-sandbox`, así que ~90 tests
  de integración fallaban por el entorno. Como los tests son condición para
  publicar, eso bloqueaba el release. Los describe unitarios de esos mismos
  archivos —`resolveBackendKind`, detección de motor, `normalizeCookies`,
  `sessionPersistenceEnabled`— siguen corriendo siempre: son los que cubren el
  contrato del backend.

- **Se quitó un `mock.module` que se filtraba entre archivos de test.** El test
  de aislamiento multi-tenant sustituía el módulo `storage/crypto` para no
  escribir en el keychain del SO. `mock.module` es global al proceso, no al
  archivo: mientras estuviera activo, cualquier otro test que importara ese
  módulo recibía el doble, y `loadProviderApiKey` devolvía la key del mock. Que
  mordiera dependía del orden de ejecución — pasaba en local y fallaba en CI.
  Ahora el test usa un id de proveedor propio (`test-tenant-isolation`) y limpia
  sus secretos, sin tocar el módulo ni la credencial de nadie.

- **El caché de disponibilidad del keychain se envenenaba para todo el proceso.**
  `_keychainOk` recuerda si `Bun.secrets` respondió, para no reintentar en cada
  lectura en un servidor sin libsecret. El problema es que ese resultado valía
  para siempre: una vez marcado como no disponible, sustituir `Bun.secrets` por
  otro backend —o por un doble de test— no servía de nada, porque la lectura
  cortaba antes de tocarlo. Ahora se detecta que el objeto cambió de identidad y
  el sondeo se invalida solo. Era la causa de que el test de compatibilidad con
  keychain fallara en CI headless (y sólo ahí).

- **`resetKeychainProbe()`** en `storage/crypto.ts`. Si el keychain del SO no
  responde, el resultado se cachea a nivel de módulo para no reintentar en cada
  lectura — correcto en producción, pero significa que el primer sondeo vale
  para todo el proceso. Un test que sustituya `Bun.secrets` por un doble queda
  cortocircuitado si algo ya sondeó y falló antes, que es lo que pasa en CI
  headless.


- **Automatización web: un solo backend, `Bun.WebView`.** Se retiró
  `AgentBrowserBackend`, que hablaba con el CLI de agent-browser por
  subproceso. El motivo no es de estilo: medido en Bun 1.4 el WebView **sí**
  corre headless (Bun lanza Chromium con `--headless`), que era la única razón
  por la que agent-browser seguía siendo el default. Lo que quedaba era su
  costo — ~40 ms de `Bun.spawn` por operación contra ~0,3 ms, y ~88 MB con su
  propia copia de Chrome.

  Lo importante para quien consume el paquete: el backend viejo ejecutaba
  **`bun add agent-browser@latest` en el entorno del consumidor**, al primer uso
  de una browser tool. Una versión flotante bajada de npm en runtime, en
  producción. Eso ya no existe.

  Requisitos ahora: un Chromium instalado (o `BUN_CHROME_PATH`) y **Bun ≥ 1.4.2**,
  declarado en `engines`. La clave de config `tools.browser.backend` sobrevive:
  `"agent-browser"` se acepta, avisa una vez y usa el WebView, así que las
  configuraciones viejas no se rompen.

- **Sesión de navegador persistente** (`tools/web/browser-session.ts`). El
  perfil de Chrome que abre Bun es efímero —su ruta lleva un hash que cambia
  entre procesos— así que las cookies se guardan y restauran a mano. Sin esto
  cada reinicio empezaba sin logins. Se controla con `tools.browser.persistSession`
  (activo por defecto).

- **Nueva tool `computer_use_task`**: operar el navegador mirando la pantalla
  —clic por coordenadas, escribir, navegar— cuando no hay un selector CSS
  estable (canvas, UIs generadas, visores embebidos).

- CI actualizado a **Bun 1.4.2**, alineado con `hive`.

### Quitado

- **`AgentRunner`** (`agent/providers/index.ts`). Era una capa de compatibilidad
  con la firma de LangGraph anterior a que el runtime pasara a `agent-loop.ts`, y
  **nunca llegó a instanciarse**: los cuatro puntos de entrada reales —el
  gateway, `createAgent`, el worker y los ejecutores del harness— llaman
  `runAgent()` directo. 158 líneas de código muerto. El subpath
  `@johpaz/hive-sdk/agent/providers` sigue existiendo con sus tipos (`Provider`,
  `ModelResponse`), que sí son parte del contrato público.

### Añadido

- **Streaming por token en la API pública.** `chat(mensaje, { stream: true })`
  emite eventos `token` con los deltas del proveedor a medida que llegan. El
  mecanismo ya existía —los proveedores llamaban `onToken` por cada delta— pero
  **ningún punto de entrada lo pasaba**, así que nunca llegaba a nadie: la
  respuesta aparecía de golpe al terminar el turno.

- **`@johpaz/hive-sdk/services/images`** — imágenes como servicio para el usuario
  final, no para el agente: entra y sale por bytes, se persiste por id. Incluye
  galería (`listImages`), presets y control de retención.

- **`@johpaz/hive-sdk/services` — la superficie que maneja una interfaz.** El SDK
  estaba construido para que lo condujera el modelo: casi todo el CRUD vivía
  dentro de las tools (`cronCreateTool`, `memoryWriteTool`, `agentCreateTool`),
  con argumentos con forma de LLM y respuestas escritas para un prompt. Montar
  una UI encima obligaba a llamar `tool.execute({...})` y parsear prosa, o a
  escribir consultas crudas contra HiveDB conociendo un esquema privado.

  Ahora la implementación vive en `services/` y las tools la envuelven — una
  implementación, dos consumidores. Diez dominios: `agents`, `swarms`, `skills`,
  `tools`, `providers`, `models`, `mcp`, `cron`, `memory`, `ethics`. Es
  deliberadamente agnóstico del framework (funciones, no rutas HTTP): una app
  móvil o de escritorio que embeba el runtime no quiere un servidor.

  Añade tres cosas que hive no hace: **valida que las referencias existan** al
  asignar tools/skills/MCP a un agente (hive las guarda sin comprobar, y el
  error aparece cuando el agente intenta usarlas); **`testMcpServer()`**, que
  allí es "guardá y esperá a que el hot-reload conecte"; y el **rename de modelo
  transaccional**, que re-apunta a cada agente en el mismo `batch()`.

- **`SwarmDoc` — los enjambres se pueden guardar.** Hasta acá un enjambre existía
  sólo mientras corría: `runRoleSwarm()` recibe los agentes en la llamada y no
  persiste nada, así que quien armara uno desde una interfaz lo perdía al cerrar
  la ventana. Era el bloqueador real para poner una UI encima del SDK, y explica
  por qué hive-cloud creó sus propias tablas en Postgres.

  La validación ocurre **al guardar, no al correr**: un enjambre jerárquico sin
  orquestador, o con un agente que ya no existe, es un error de configuración —
  descubrirlo semanas después, cuando alguien lo ejecuta, es descubrirlo tarde.

- **El harness trae ejecutores listos** (`initHarnessExecutors()`). La cola
  durable sabía encolar, reintentar y recuperar tras un crash, pero no ejecutar:
  registrar los ejecutores quedaba en manos de quien usara el SDK, y eso son
  ~420 líneas de cableado —epoch, proof packets, criterios de aceptación,
  fan-in de delegaciones— antes de correr un solo enjambre durable. Ahora vienen
  `worker_task` (worker delegado en contexto aislado, con verificación de sus
  criterios) y `goal_run` (varios turnos contra un objetivo hasta verificarlo o
  agotar el presupuesto).

  `chat_turn` no está a propósito: qué es un canal y cómo se transmite un token
  lo define la aplicación. Se registra desde fuera con `registerExecutor()`.
  Registrar sigue siendo opt-in — `initHarnessExecutors()` no se llama sola.

- **`getRegisteredExecutorTypes()`** — el registro era privado, así que no había
  forma de comprobar si un tipo quedó cableado. Un job encolado sin ejecutor no
  falla al encolarse sino al tomarse, lejos de donde está el error.

- **Superficie pública completa**: 33 subpaths (antes 28). `events/` y
  `resilience/` no tenían barril, `canvas/` no exportaba su emitter, `artifacts/`
  no existía como módulo, y `./events` apuntaba a un solo archivo — el
  **agent-bus**, que es la mensajería entre workers de un enjambre, era
  inalcanzable desde fuera. También se exponen `./tool-runtime`, `./channels`,
  `./voice`, y `initializeBrowserService`/`activateBrowserTools`, sin los cuales
  las browser tools estaban en el catálogo pero nadie podía arrancarlas.

- **`@johpaz/hive-sdk/sessions`** — la conversación de un usuario como una sola
  cosa. Hasta acá "sesión" estaba repartida entre `thread-store` (identidad),
  `conversation-store` (mensajes), `run-store` (ejecución) y un `Map` en memoria
  que moría con el proceso; no existía la consulta "qué sesiones tiene este
  usuario". `Session` es una vista compuesta sobre las colecciones que ya
  existían — no agrega una tercera persistencia — y `Session.id` ES el
  `threadId`. Incluye `createSession`, `listSessions`, `appendMessage`,
  `resumeSession`, `closeSession`/`reopenSession` y `deleteSession`.

- **`@johpaz/hive-sdk/models`** — el seed de modelos con nombre propio. El
  catálogo (18 proveedores, 110 modelos), las claves de modelo y el cálculo de
  costo seguían viviendo bajo `storage/`; esto les da un punto de entrada sin
  mover la implementación.

- **Enjambre por roles** (`runRoleSwarm` en `@johpaz/hive-sdk/swarm`) —
  orquestador/trabajadores con estrategias `sequential`, `parallel` y
  `hierarchical`. Es la tercera forma de armar un enjambre, junto a la
  delegación por catálogo y al DAG de tareas, y la única que expresa un enjambre
  como *configuración persistida* en vez de un grafo conocido de antemano. No
  persiste nada: `onMessage` es el punto de enganche del consumidor.

- **`bun run drift`** (`scripts/check-drift.ts`) — compara los módulos del
  cerebro contra `hive` y reporta qué falta y qué difiere, indicando de qué lado
  está el avance. El SDK es la fuente de verdad pero nada lo garantizaba
  estructuralmente: la última vez la divergencia llegó a compartir sólo 87 de
  224 nombres de archivo.

- **`test/exports-contract.test.ts`** — importa de verdad cada subpath declarado
  en `exports`. Los deep-imports se han roto entre versiones sin aviso, y el
  consumidor se defendía pineando la versión exacta.

### Corregido

- **Las notificaciones no llegaban a ningún lado.** `notifyChannel` era un stub
  que sólo hacía `console.log`, y está en el camino real: la tool `notify`, los
  reportes de progreso, el aviso de que una tarea programada terminó, el de un
  turno interrumpido por un crash. Un agente sobre el SDK **no podía hablarle al
  usuario por ningún canal**, mientras `channels/manager.ts` tenía adaptadores
  funcionales de Slack, Discord, Telegram y WhatsApp sin nada que los conectara.
  Ahora la app registra el suyo con `setChannelManager()`; sin registro se
  conserva el comportamiento anterior, pero avisando.

- **Las imágenes se reenviaban al modelo en cada turno.** `content_multimodal`
  guardaba el base64 completo y `toAPIMessages` lo restauraba una y otra vez:
  cinco fotos en una conversación eran cinco fotos viajando en cada turno
  siguiente. Ahora se guardan como artefacto y en el historial queda una
  referencia; las de los últimos mensajes se vuelven a poner en línea, porque un
  modelo de visión no ve una foto desde un id. Mismo criterio que
  `clearOldToolResults`.

- **`token_count` no contaba las imágenes**, así que la compactación creía que un
  hilo lleno de fotos ocupaba lo que ocupa su texto y no se disparaba hasta que
  el proveedor rechazaba el turno. Ahora se estiman por área, como cobran los
  proveedores.

- **`agent.context.compactionThreshold` no lo leía nadie.** Estaba en el esquema
  de configuración y ajustarlo no hacía nada. Una opción que no hace nada es
  peor que no tenerla, porque el usuario cree que cambió algo.

- **`search_knowledge` filtraba en el lugar equivocado.** Mostraba tools fuera de
  la lista blanca del agente. La ejecución sí estaba protegida, pero además de
  contarle qué existe fuera de su alcance, ofrecerle algo que no puede ejecutar
  es hacerle perder un turno.

- **El seed selectivo no habría sobrevivido a un reinicio.** `reseedToolsAndSkills()`
  escribía `active: true` para todas las tools y skills en cada arranque, así que
  la elección del usuario sobre qué capacidades quiere en su colmena duraba hasta
  el próximo reinicio: apagaba lo que no usaba y volvía todo. Ahora el reseed
  preserva `active` —la descripción y la categoría siguen viniendo del código,
  que es su fuente de verdad—, igual que ya hacía con los modelos.

- **La memoria era global al proceso.** El id de `MemoryDoc` era sólo el título y
  no había `user_id`: dos usuarios no podían tener una memoria con el mismo
  nombre —la segunda pisaba la primera— y cualquiera veía la del otro. Coherente
  con hive, que es mono-usuario; inservible para un runtime donde cada quien arma
  su colmena. El id pasa a ser `${userId}:${title}` y toda lectura filtra por
  dueño. Las filas anteriores se migran al arrancar.

- **Los ids no manejaban acentos.** "Efímero" quedaba como `ef_mero` y "Diseño"
  como `dise_o`, porque la í y la ñ no son `[a-z0-9]`. Para un producto en
  español eso no es cosmético. `slugify()` normaliza los diacríticos antes de
  filtrar, y se aplica también a skills y servidores MCP.

- **Documentación que describía un backend retirado.** `API-TOOLS-SKILLS-CHANNELS.md`
  seguía explicando cómo `agent-browser` se instalaba solo en `~/.hive/` al
  primer uso — un backend que ya no existe. Reescrita para `Bun.WebView`, con la
  nota de por qué se retiró. También se corrigieron los conteos (58→60 tools,
  106→110 modelos) y los pies de página congelados en `v0.0.17`.


- **Un job que moría por expiración de lease no disparaba su terminal hook.** La
  ruta normal de fallo sí lo hacía; la de recuperación tras un crash, no. El
  aviso al usuario y el fan-in de delegaciones se perdían en silencio justo
  cuando más importaban.

- **Los artefactos de imagen no llegaban al consumidor.** El agent loop ya los
  emitía (`chunk.artifacts.images`, vía mcp-result-normalizer), pero el wrapper
  `AgentRunner` no los propagaba, así que una imagen producida por una tool MCP
  se perdía antes de salir del SDK.

- **NVIDIA no emitía razonamiento.** NIM lo mantiene apagado por defecto y el
  interruptor no es `reasoning_effort` sino `chat_template_kwargs`, con una
  clave distinta por familia de modelo. Se añade el reintento sin esos extras
  cuando el proveedor responde 400/422: perder el razonamiento es mejor que
  perder el turno.

- **Un turno con más de una tool call podía morir por un hueco de empaquetado.**
  `resolveWorkerEntry()` lanzaba si no encontraba el worker; ahora devuelve null
  y degrada a hilo principal.

- **`touchThread` perdía mensajes en el contador.** El incremento se calculaba
  fuera del reintento de `updateDoc`, así que ante un conflicto de versión el
  reintento volvía a escribir el valor viejo. Como `addMessage` la llama sin
  esperarla, dos mensajes seguidos del mismo hilo bastaban para que el conteo se
  quedara corto de forma permanente. Ahora el valor se recalcula dentro del
  bucle.

- **El paquete publicaba su propia suite de tests.** Sin campo `files`, el
  tarball llevaba 329 archivos y 2.3 MB, incluidos `test/`, `docs/`, `scripts/`
  y los `*.test.ts` que conviven con el código. Ahora son 260 archivos y 448 kB.

- **`prepublish` no verificaba nada** (era un `echo`), y además es el hook
  deprecado. Se reemplazó por `prepublishOnly` con typecheck + tests.

- **Sintaxis TypeScript que ningún runtime salvo Bun puede procesar.** Las 5
  *parameter properties* (`constructor(private x)`) rompían incluso el
  type-stripping nativo de Node, y como las clases se re-exportan desde el barrel
  raíz tumbaban cualquier import del paquete. Se reescribieron a mano, sin
  cambiar la API, y se normalizaron 355 imports relativos a extensión `.ts`
  explícita. El paquete sigue requiriendo Bun por el uso de `Bun.*` en 18
  archivos del core — ahora documentado en el README.


- Se fijaron las 8 dependencias que estaban en `latest` (`zod`, `discord.js`,
  `grammy`, `@slack/bolt`, `@whiskeysockets/baileys`, `@modelcontextprotocol/sdk`,
  `qrcode-terminal`, `@sapphire/snowflake`). Como `bun.lock` no se publica, cada
  instalación resolvía `latest` de nuevo: el SDK ya estaba corriendo
  `@slack/bolt` **5.0.0** mientras hive, con el mismo código de canales, corría
  **4.7.x**. Ahora quedan alineados.

### Añadido

- **Backend de navegador intercambiable.** Las tools hablan con la interfaz
  `BrowserBackend`; además del `agent-browser` de siempre (default, sin cambios)
  hay un `WebViewBackend` sobre `Bun.WebView`, in-process, sin instalación de
  ~75 MB ni descarga de Chrome. Se elige con `tools.browser.backend`
  (`"agent-browser" | "webview" | "auto"`) o `HIVE_BROWSER_BACKEND`.
- Cobertura de `acceptance-checks` (27 tests), del backend de navegador (27) y
  del selector con tools registradas en runtime (6).
- Workflow de CI: typecheck, tests, verificación de aislamiento de la base, y un
  job que genera un scaffold con `create-app` y lo typechequea contra el SDK de
  ese commit.

## 0.4.9

### Corregido

- **La compactación de historial dejaba de ser excepcional y corría casi en cada
  turno.** `agent.context.compactionThreshold` es una proporción de la ventana
  del modelo —su valor por defecto es `0.8`, o sea el 80 %— pero se leía como un
  número de tokens: el umbral efectivo quedaba en 0.8 tokens. Cualquier hilo con
  más de cinco mensajes se resumía en cada turno, lo que cuesta una llamada extra
  al modelo por mensaje y reemplaza el historial por un resumen desde el primer
  intercambio. Ahora un valor menor o igual a 1 se aplica sobre la ventana del
  modelo y uno mayor se sigue leyendo como tokens, para quien fijó un número
  absoluto. El umbral se calcula además con la ventana del modelo que corre el
  turno, no con la del coordinador.
- **El resumen se pedía con una credencial global.** `compactThread` resolvía el
  modelo con `getDefaultLLM()` y llamaba a `resolveProviderConfig` sin
  credenciales, así que la llave salía del secret store, del llavero del sistema
  o del entorno del proceso. En una instalación de un solo usuario da igual; en
  una multi-inquilino significa resumir la conversación de un cliente con la
  llave de la plataforma o de otro cliente. `maybeCompact` y `compactThread`
  aceptan ahora el modelo y las credenciales del turno (`CompactionLLM`), y el
  agent loop les pasa los suyos. Sin ese dato se comportan como antes.

## 0.1.5

Sincronización del SDK con el runtime de agentes de `hive`. **Trae rupturas de
API** (permitidas en 0.x, pero léelas antes de actualizar): el SDK y hive habían
divergido hasta compartir sólo 87 de 224 nombres de archivo, y quien instalaba
`@johpaz/hive-sdk` recibía un runtime más viejo y con bugs que en hive ya estaban
arreglados.

### Corregido

- **Las caídas del provider ya no se guardan como respuestas del agente.**
  `callLLM` devolvía `{ content: "[LLM Error] …", stop_reason: "error" }` y nadie
  chequeaba `stop_reason`: el texto del error se persistía con `addMessage` y —
  peor — la compactación lo guardaba como **el resumen permanente** que reemplaza
  N mensajes de historial. `LLMResponse` ahora tiene un campo `error` tipado y hay
  guardas en el loop, en la síntesis terminal y en la compactación.
- **HTTP 404/410 se distinguen del resto.** Un modelo retirado por el proveedor
  produce un mensaje accionable con `error.modelUnavailable`, en vez de un error
  opaco y reintentos que no pueden funcionar.
- **Las claves de modelo ya no colisionan.** Dos providers que sirven el mismo
  modelo (`z-ai/glm-5.2` bajo NVIDIA y bajo OpenRouter) se pisaban la fila. Los
  cuatro revendedores (`nvidia`, `openrouter`, `opencode-go`, `modelscope`,
  `groq`) prefijan sus ids; el prefijo no llega al cable.
- **Los precios salen de la base.** `MODEL_PRICING` era un mapa hardcodeado de
  ~62 entradas en paralelo al catálogo, y mantener dos listas fallaba en silencio.
  Ahora el precio vive en la fila del modelo (`input_per_1m` / `output_per_1m`) y
  un modelo sin tarifa avisa una vez en vez de reportar $0 como si fuera gratis.
- **`createAgent` honra su configuración.** `provider`, `model`, `maxIterations`,
  `skills` y `workspace` se aceptaban y se descartaban: el agente corría con lo
  que hubiera en la base. Ahora se persisten en la fila del agente.
- **Las tools de la app son usables.** `defineTool` registraba la declaración pero
  no el ejecutor, así que una llamada moría con "no matching executor found". Y
  aunque lo tuviera, el índice de capacidad no se llenaba nunca por la vía del
  SDK, así que el agente quedaba limitado al loadout mínimo para siempre.
- **El selector ya no descarta tools que el índice sí encontró.** `selectTools`
  resolvía los resultados contra `CORE_TOOL_CATALOG` mientras el índice se
  construía con ése **más** la colección `tools`: una tool registrada en runtime
  podía puntuar primera en BM25 y aun así nunca ofrecerse al modelo.
- **`Scratchpad` escribe el documento completo.** Compartía colección e id con
  `conversation-store` pero guardaba un doc sin `source`, `createdAt` ni `seq`,
  así que sus notas se ordenaban mal dentro del prompt.
- **La suite de tests dejó de escribir en la base real del usuario.** Un preload
  fija `HIVE_DB_PATH=":memory:"` antes de que cargue cualquier módulo.
- **`tool_choice` de Mistral.** Estaba en `"any"`, que según docs.mistral.ai
  *fuerza* una llamada a tool en cada turno; ahora es `"auto"`.

### Ruptura

| Antes | Ahora |
|---|---|
| `initializeDatabase()`, `dbService`, `getDb()` | `ensureHiveDb()`, `col()` |
| `seedHiveDB()` | `seedAllData()` (lo llama `ensureHiveDb`) |
| `getAverageTokenCost()`, `getProviderPricing()`, `estimateCostForTokens()` | `calculateCost()` |
| `new EthicsGuard(db)`, métodos sync | `new EthicsGuard()`, métodos async |
| `new CronScheduler(db, handler)` | `new CronScheduler(handler)` |
| `new Scratchpad(db)` | `new Scratchpad()` |
| subpath `./ace` | `curator`, `reflector`, `tracer` desde `./agent` |
| subpath `./agent/selectors` | selectores desde `./agent` |
| `AgentConfig.provider: "openai" \| "anthropic" \| "gemini" \| "ollama"` | los 16 providers del catálogo |
| `api_request` con `auth`, `body` objeto, `timeoutMs` | headers, `body` string, `timeout_ms` |
| evento de canvas `canvas:render` | `canvas:node_add` / `node_update` / `edge_*` |

Módulos eliminados: `auth/` (sin un solo import), `agent/ContextGuard.ts` y
`agent/Hooks.ts` (muertos), `storage/SQLiteStorage.ts`, `storage/schema.ts`,
`storage/hiveSeed.ts`, `scheduler/dag/` (copia byte-idéntica de `swarm/`),
`swarm/WorkerPool.ts` (copia rezagada de `scheduler/integration.ts`),
`swarm/AgentBus.ts` y `swarm/EventBus.ts` (duplicaban `events/`), y las tools
`canvas/`, `codebridge/`, `meeting/`, `projects/`, `voice/`.

`harness/` pasó de tener implementación propia a ser un barrel sobre la
implementación única. El subpath `@johpaz/hive-sdk/harness` exporta lo mismo.

### Agregado

- 16 providers LLM con `OpenAICompatBase`, incluidos `nvidia`, `z-ai`,
  `modelscope`, `opencode-go`, `minimax`, `hiveagents`.
- Catálogo sembrado de 18 providers y 106 modelos con precio, actualizable
  editando `SEED_DATA.models`: las filas de catálogo se borran y se recrean en
  cada arranque, preservando qué modelo tenía activo el usuario.
- `registerAppTool()` / `clearAppTools()` como punto de extensión del registry.
- `catalogModelKey()`, `wireModelId()`, `isResellerProvider()`.
- `callLLM` y los tipos de `llm-client` en la superficie pública: antes sólo se
  exportaba el wrapper `AgentRunner`.
- `bun run skills:bundle` regenera el catálogo de skills desde los `SKILL.md`
  (el generador apuntaba a una ruta que no existe en este repo).
- Subpaths `./scheduler`, `./workers` y `./events`.
- De 18 a 44 archivos de test (77 → 314 casos), incluyendo agent loop, context
  compiler, compactación, seed, precios y claves de modelo, que no tenían ninguno.

### Corregido en el CLI

`init`, `run`, `test` y `trace` importaban `@hive/core`, un nombre de workspace
que no está publicado en npm: los cuatro comandos estaban rotos para cualquier
usuario. `hives test` además hacía glob sobre `packages/core/src/**`, rutas del
repo del SDK y no del proyecto donde se ejecuta.
