# Jev en hive-sdk y hive-cloud — plan

## Contexto

Jev (plano de decisión sobre la API Decisions de OpenRouter) ya funciona en `hive` 1.1.0: elige historial, herramientas, skills, notas y reglas por turno, poda resultados viejos entre iteraciones, decide paralelismo y conoce el mapa del enjambre (especialistas + estado de cada MCP). Sin clave de OpenRouter, Hive funciona exactamente igual que antes.

Pregunta: ¿Jev va en `hive-sdk` o directamente en `hive-cloud`?

**Recomendación: el motor en el SDK; la configuración por inquilino en hive-cloud.**

- hive-cloud **no tiene loop ni compilador propios**: todo turno pasa por `runAgent` del SDK desde `packages/gateway/src/lib/sdk-bridge.ts` (`runAgentBridged`, `runManagedCrmAgentBridged`). Jev se engancha justo en `compileContext` y en el loop; implementarlo en hive-cloud obligaría a bifurcar esas piezas.
- El SDK ya tiene todo lo que Jev usa (`searchCapabilities`, `MINIMAL_TOOLS`, `listCatalogAgents`, `mcpToolFullName`, `catalogModelKey`, proveedor OpenRouter con tarifas, `recordUsage`, `publishNarration`), y el SDK se mantiene alineado 1:1 con el núcleo de hive (`bun run drift`).
- hive-cloud ya pasa credenciales por llamada (`credentials: {apiKey, baseUrl}`) con la cascada workspace → organización → catálogo (`providerCredentialCascade` en `lib/resource-scope.ts`). Jev reutiliza ese mismo camino para su clave.
- Misma regla que en hive: **si el workspace no tiene OpenRouter configurado y habilitado, Jev no existe** y todo corre igual que hoy.

## Parte A — hive-sdk (`@johpaz/hive-sdk` 0.4.9 → 0.5.0)

Directorio base: `hive-sdk/packages/core/src/`. Portar desde `hive/packages/core/src/` usando imports con extensión `.ts` (convención del SDK).

1. **Portar los archivos de Jev**: `agent/jev-decisions.ts` y `agent/jev-planner.ts` (con los ajustes de hive 1.1.0: cola obligatoria de 4 mensajes, emparejar respuesta con su turno de usuario, `MIN_PRUNABLE_CHARS`, `describeSwarmCapabilities`, `renderSpecialistLine`, `agentMcpOff`). Exportarlos desde `agent/index.ts` y agregarlos a `test/exports-contract.test.ts`.
2. **Clave inyectable (el cambio clave para multi-inquilino)**. En hive, `getJevKey()` lee la colección `providers` + `loadProviderApiKey` + `OPENROUTER_API_KEY`. En el SDK:
   - Nueva opción `jev?: { apiKey: string } | false` en `AgentLoopOptions` y en `compileContext` (y en `IsolatedAgentOptions`, para que los workers delegados la hereden).
   - `{ apiKey }` → usa esa clave. `false` → Jev apagado. `undefined` → comportamiento de hive (colección `providers` del inquilino actual vía `col()`), **sin** fallback a `process.env.OPENROUTER_API_KEY` cuando hay inquilino activo (`currentTenant()` de `storage/tenant.ts`), para que la clave de la plataforma nunca se use en nombre de un cliente.
   - La clave viaja por el loop igual que `credentials` (agent-loop.ts, líneas donde hoy se reenvía `credentials`), hasta `planJevContext`, `planJevIteration` y `jevWantsParallel`.
3. **Estado por inquilino**. `jev-decisions.ts` guarda `failures`, `cooldownUntil`, `lastError` y `totals` a nivel de módulo. En el SDK eso mezclaría clientes: pasar a un `Map` indexado por `currentTenant() ?? "default"` (una clave inválida de un cliente no debe poner en cooldown a los demás).
4. **Integración en compilador y loop**: los mismos puntos que en hive (`context-compiler.ts`: `skipJev`, `describeSwarmCapabilities`, `planJevContext`, roster compacto, sección de MCP apagado, `jevDecision` en el resultado; `agent-loop.ts`: `planJevIteration`, `jevWantsParallel`, `emitJevDecision`). Los IDs de MCP del SDK llevan prefijo de inquilino (`<tenant>:<id>`, ver `syncSwarmCapabilitiesToSDK`); `describeSwarmCapabilities` debe mostrar el `name`, nunca el id.
5. **Eventos hacia el host**. El canvas del SDK tiene suscriptores globales y hive-cloud no lo usa. Emitir cada decisión además como `StepEvent` por `onStep` (nuevo tipo `jev_decision` con agente, tipo, resumen, tokens ahorrados, latencia, costo, especialista recomendado y MCP apagados). Mantener `canvas:jev_decision` para hosts tipo hive.
6. **Uso y costo**: portar `recordJevDecision` y los campos `jev*` de `UsageRollupDoc` (`storage/usage.ts`, `storage/collections.ts`). Quedan con prefijo de inquilino por `runInTenant`.
7. **Catálogo**: sembrar el modelo `typesafe/jev-1.13` con `modelType: "decision"` y excluir ese tipo en `getDefaultLLM` y `get_available_models` (igual que hive).
8. **Documentación y versión**: entrada en `CHANGELOG.md` (sección `## Sin publicar` → `## 0.5.0`) con la nota de privacidad (qué datos van a OpenRouter). Publicar 0.5.0.

## Parte B — hive-cloud (`hivecloud-backend`)

> **Implementada** (2026-09-24), con `@johpaz/hive-sdk` 0.5.1. El punto 6 dejó de estar fuera de alcance: el uso y el ahorro de Jev por workspace, la oficina 3D con oráculo y rayos, y las pruebas se hicieron según [`2026-09-24-jev-hivecloud-implementation-design.md`](../hive-cloud/hivecloud-backend/docs/plans/2026-09-24-jev-hivecloud-implementation-design.md).

1. **Resolver la clave de Jev** en `packages/gateway/src/lib/sdk-bridge.ts` (`_fetchFromPostgres`): buscar el proveedor `openrouter` con la misma `providerCredentialCascade` (workspace → organización). Si existe, está `enabled` y tiene clave: `jev: { apiKey }`; si no: `jev: false`. Pasarlo en `runAgentBridged` y `runManagedCrmAgentBridged`.
2. **Actualizar la dependencia** `@johpaz/hive-sdk` a 0.5.0 en root, `gateway`, `db` y `crm`.
3. **Mostrar la actividad**: en `lib/agent-narration.ts` / `lib/run-trace.ts`, mapear el `StepEvent` `jev_decision` a una línea breve para el widget y la traza del chat de pruebas. En la oficina 3D (`hiveCloudUi/src/features/office3d/`), el endpoint de actividad del swarm (`routes/swarms.ts` ~L780) ya lee `narrationEvents`; agregar las decisiones al mismo arreglo `activity`.
4. **Aviso de MCP apagado**: el mensaje del coordinador debe decir la ruta de hive-cloud (**Capacidades del enjambre**, `SwarmCapabilitiesPage.tsx`), no la de hive. Hacerlo configurable en el SDK (texto del destino en la opción `jev`) o con una constante por host.
5. **Privacidad**: actualizar `hiveCloudUi/src/pages/legal/PrivacidadPage.tsx` para declarar que, con OpenRouter configurado en el workspace, extractos del contexto se envían a su API de decisiones.
6. **Fuera de alcance (anotado)**: hive-cloud hoy no muestra uso de tokens por inquilino (`UsageStatsPanel` apunta a una ruta que no existe). El SDK dejará las decisiones registradas en `usageRollups`; exponerlas en un panel es un trabajo aparte.

## Archivos críticos

- SDK: `packages/core/src/agent/{jev-decisions,jev-planner,context-compiler,agent-loop,llm-client,index}.ts`, `storage/{usage,collections,seed}.ts`, `canvas/emitter.ts`, `test/exports-contract.test.ts`, `CHANGELOG.md`.
- Cloud: `packages/gateway/src/lib/{sdk-bridge,resource-scope,agent-narration,run-trace}.ts`, `routes/swarms.ts`, `hiveCloudUi/src/pages/legal/PrivacidadPage.tsx`, `package.json` (x4).

## Verificación

- **SDK**: `bun run drift` antes y después; portar `tests/jev-decisions.test.ts` de hive (endpoint, fallback, mapa del enjambre, MCP apagado, persistencia en rollups) y agregar: (a) con `jev: false` no hay ninguna llamada a OpenRouter; (b) sin `jev` y sin fila `openrouter` en el inquilino no hay llamada aunque exista `OPENROUTER_API_KEY` en el entorno; (c) dos inquilinos con claves distintas: el cooldown de uno no afecta al otro. `bun test` y typecheck completos.
- **Cloud**: prueba del bridge con un workspace **sin** OpenRouter (el turno corre igual, cero llamadas a decisions) y otro **con** OpenRouter (llega `jev_decision` por `onStep`, la actividad del swarm lo muestra). Suite del gateway en verde.
- **Manual**: en un workspace de prueba, ejecutar un swarm con y sin la clave de OpenRouter y comparar tokens de entrada del modelo principal en `usageRecords` del inquilino.
