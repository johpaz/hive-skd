# Actualización a Bun 1.4.2 y TypeScript 7

Hive SDK requiere **Bun 1.4.2 o posterior** y usa **TypeScript 7.0.2** para
desarrollo y verificación. El SDK se publica como TypeScript, por lo que estas
versiones también importan al compilar una aplicación consumidora.

## Actualizar un checkout del SDK

```bash
bun --version                 # debe ser 1.4.2 o posterior
bun install --frozen-lockfile
bun run typecheck
bun test
bun audit
```

El `package.json` raíz fija TypeScript 7.0.2 para que CI y desarrollo resuelvan
el mismo compilador. `@hive/core` acepta versiones compatibles desde 7.0.2
mediante su peer `^7.0.2`, porque publica sus fuentes. `@types/bun` permanece en
1.4.1: es la versión publicada de tipos correspondiente disponible al cerrar
esta migración.

## Actualizar una aplicación consumidora

1. Instala Bun 1.4.2 o una versión posterior compatible.
2. Actualiza el compilador de la aplicación:

   ```bash
   bun add --dev typescript@7.0.2 @types/bun@^1.4.1
   ```

3. Regenera la instalación con `bun install` y ejecuta el typecheck propio.
4. No añadas `skipLibCheck` para ocultar errores nuevos del SDK. Hive ya lo usa
   internamente para declaraciones de terceros, pero su código fuente debe
   seguir compilando completo.

## Cambios de tipos relevantes

TypeScript 7 distingue el respaldo de memoria de los typed arrays. Un
`Uint8Array<ArrayBufferLike>` podría usar `SharedArrayBuffer` y ya no es válido
automáticamente como `BlobPart`; Hive conserva bytes respaldados por
`ArrayBuffer` al construir audio para APIs de transcripción.

Con `DOM` y los tipos de Bun activos simultáneamente también aparecen dos APIs
con definiciones superpuestas:

- `ReadableStreamDefaultReader` de Bun añade `readMany()`, aunque el transporte
  SSE sólo necesita `read()`. El transporte depende de ese contrato mínimo.
- El constructor DOM de `WebSocket` sólo conoce subprotocolos; Bun permite
  `Bun.WebSocketOptions`, incluidos headers. El transporte delimita esa
  extensión en un tipo de constructor local.

Estos adaptadores están en la frontera con el runtime. No deben reemplazarse por
`any`, `@ts-ignore` o `@ts-expect-error`: hacerlo convertiría una incompatibilidad
real de plataforma en un falso resultado verde.

## hive-db 0.6.1

Hive SDK requiere **`@johpaz/hive-db` 0.6.1 o posterior** (llega como
dependencia). La API es compatible con 0.5.x, pero el formato en disco cambió:
una base del formato anterior **se migra sola al abrir** y después **no abre con
0.5.x**. Si necesitas poder volver atrás, copia `<HIVE_HOME>/data/hivedb` antes
de actualizar.

Novedades del SDK sobre esa versión, todas sin cambios de código en tu app:

- El reindexado del catálogo al arrancar es incremental (hash por documento).
- Opcional: `memory.crossThreadRecall` (resúmenes de otros hilos en el prompt) y
  `memory.embedder: "local"` (experimental; ver [HIVEDB.md](./HIVEDB.md)).
- El template `hive-app` cierra HiveDB en `SIGINT`/`SIGTERM`. Una app ya
  generada puede copiar ese bloque de `src/main.ts`.

## hive-db 0.5.1 y log causal por tenant

Hive SDK requiere **`@johpaz/hive-db` 0.5.1 o posterior**. Llega como
dependencia del SDK, así que una aplicación consumidora no la declara. Lo que
sigue sólo importa con el log causal encendido (`HIVE_CAUSAL_LOG=true` o
`causalLog.enabled`):

- Con un tenant activo (`runInTenant`) el reflector y el contexto causal del
  compilador vuelven a funcionar. Antes se apagaban; ahora leen acotado a los
  agentes del turno o del lote de trazas.
- La clave de shard de cada evento es `causalAgentKey(agentId)`: sin tenant, el
  id del agente tal cual; con tenant, `t_…:agentId`. Los eventos que un host
  haya escrito con tenant antes de esta versión quedaron con el id crudo y las
  lecturas acotadas ya no los ven. Sin tenant no cambia nada.
- El `toolStats` del reflector cuenta el historial de los agentes del lote, no
  el de toda la base, con y sin tenant.
- `watchCausalEvents` con tenant sigue exigiendo `agentId`: se le pasa el id
  crudo y el SDK lo califica. Los eventos que entrega traen en `agentId` la
  clave del shard; `formatCausalEvent` la muestra sin el tenant.

## 0.5.1: claves aisladas por inquilino

Sólo cambia algo si corres turnos dentro de `runInTenant` (un host
multi-inquilino). Sin inquilino todo sigue igual.

- **La caché de secretos y el llavero del SO ya no se comparten.** Antes, en
  cuanto un inquilino leía o guardaba `provider:<id>:api_key`, los demás del
  mismo proceso recibían esa clave. Ahora la caché es por inquilino y el
  llavero no se toca dentro de un inquilino. No hay que cambiar código.
- **El entorno ya no es respaldo dentro de un inquilino.** Si un turno no
  trae `credentials` y el inquilino no tiene clave guardada, antes se usaba
  `<PROVIDER>_API_KEY` del proceso (la cuenta de la plataforma); ahora la
  llamada falla por falta de clave. Aplica al modelo principal, OCR, voz,
  `computer_use` y Jev. Qué hacer: pasar la clave en `credentials`, o
  guardarla con `storeProviderApiKey` dentro del `runInTenant` del cliente. Si
  quieres que un cliente use la cuenta de la plataforma, pásala tú en
  `credentials`, a propósito.
- Para tus propias tools: `envSecret("MI_API_KEY")` en lugar de
  `process.env.MI_API_KEY`.

## Compatibilidad y CI

Los workflows fijan Bun 1.4.2, instalan con `--frozen-lockfile`, ejecutan el
typecheck de TypeScript 7 y la suite. También generan una aplicación nueva y la
compilan enlazada contra el SDK del commit, no contra la última versión de npm.

Antes de elevar Bun o TypeScript otra vez, actualiza primero CI, reproduce el
typecheck localmente y documenta cualquier cambio de tipos observable para los
consumidores.
