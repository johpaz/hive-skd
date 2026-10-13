# API-SERVICES — la superficie que maneja una interfaz

## Por qué existe

El SDK nació para que lo condujera un modelo. Casi todo el CRUD vivía **dentro
de las tools** —`cronCreateTool`, `memoryWriteTool`, `agentCreateTool`— con
argumentos con forma de LLM y respuestas escritas para un prompt. Montar una UI
encima obligaba a una de dos cosas, ambas malas:

- llamar `tool.execute({...})` y parsear prosa pensada para un prompt, o
- escribir consultas crudas contra HiveDB conociendo un esquema que no es
  contrato público.

`@johpaz/hive-sdk/services` es la respuesta: la implementación vive acá y **las
tools la envuelven**. Una sola implementación, dos consumidores — el modelo y tu
aplicación.

```typescript
import { agents, skills } from "@johpaz/hive-sdk/services";

const a = await agents.createAgent({ name: "Investigador", toolPatterns: ["web_*"] });
await agents.enableAgent(a.id);
```

## Dos decisiones de diseño

**Es agnóstico del framework: funciones, no rutas HTTP.** Una app móvil o de
escritorio que embeba el runtime no quiere un servidor. Quien haga una UI web
monta sus rutas encima en unas pocas líneas — es exactamente lo que hace hive,
cuya ruta de conversaciones es delgadísima porque toda la lógica está en el
módulo, no en el handler.

**Los servicios lanzan excepciones**, no devuelven `{ok:false}`. Quien construye
una interfaz quiere `try/catch`; inspeccionar un campo en cada llamada es ruido.
La traducción al formato que espera el modelo la hace el envoltorio de la tool.

## Dominios

| Módulo | Qué resuelve |
|---|---|
| `agents` | CRUD + `assignTools` / `assignSkills` / `assignMcpServers` |
| `skills` | CRUD + `importSkillFromDisk` |
| `tools` | Listar, encender/apagar, editar metadatos |
| `providers` | CRUD, API keys cifradas, cascada hacia modelos |
| `models` | CRUD, `renameModel` transaccional, protección de borrado |
| `mcp` | CRUD + `testMcpServer` |
| `cron` | CRUD sobre el scheduler, con respaldo directo a BD |
| `memory` | CRUD de la memoria de largo plazo |
| `ethics` | CRUD del código de ética |
| `endpoints` | Endpoints HTTP registrados como herramientas |
| `setup` | Seed selectivo: qué agentes quiere el usuario |

---

## Reglas que no son obvias

Estas son las que, si se pierden, dejan la colmena inconsistente sin avisar.

### Las referencias se validan al escribir

`createAgent` y `updateAgent` comprueban que cada tool, skill y servidor MCP
exista antes de guardar. Los patrones se expanden primero: un `zzz_*` que no
case con nada es un error, no una lista vacía silenciosa.

```typescript
await agents.createAgent({ name: "X", skills: ["no-existe"] });
// Error: skills inexistentes: no-existe
```

Sin esto, un id mal escrito no falla al guardar sino más tarde, cuando el agente
intenta usar una capacidad que no existe — lejos de donde está el error.

### Borrar un agente no borra sus tools ni sus skills

Son colecciones **globales compartidas**: `web_fetch` lo usan a la vez el
investigador web y el operador de navegador. Borrar las de un agente rompería al
otro. Lo mismo al desactivarlo.

### Desactivar un proveedor arrastra sus modelos

Un modelo activo de un proveedor apagado aparece en el selector y falla al
llamarse, porque no hay credencial ni endpoint que lo atienda.

### Renombrar un modelo re-apunta a sus agentes

Cambiar el nombre cambia el id, así que mover la fila y actualizar a cada agente
que la referenciaba ocurre en un solo `batch()`. A medias dejaría agentes
apuntando a la nada.

```typescript
await models.renameModel("openai/gpt-viejo", "gpt-nuevo"); // los agentes siguen apuntando bien
```

### Las API keys nunca salen

Se guardan cifradas y hacia afuera sólo hay `hasApiKey` y una versión
enmascarada. Una UI necesita mostrar "hay clave configurada" sin poder leerla.

### No existe `createTool`

Una tool es **código con un `execute`**, y desde una interfaz no hay dónde
ponerlo. Las vías reales para sumar capacidades son tres:

1. `registerAppTool()` — código propio, para quien construye sobre el SDK.
2. Un **servidor MCP** (`mcp.createMcpServer`) — un proceso externo expone sus
   tools por el protocolo.
3. Un **endpoint HTTP declarativo**, donde el ejecutor es genérico y lo que el
   usuario aporta son datos, no código.

`services/tools.ts` sólo cubre lo que una UI necesita a diario: ver el catálogo,
encender y apagar, y corregir un nombre o una descripción.

---

## Skills: disco y base de datos

Conviven dos orígenes y no compiten:

- **Disco** — carpetas con `SKILL.md` (frontmatter YAML + cuerpo markdown), que
  `SkillLoader` lee del bundle, `~/.hive/skills`, `extraDirs` y el workspace. Es
  la vía de `hives add-skill`, versionable con git.
- **Base de datos** — lo que el runtime consulta y lo que una UI edita.

`importSkillFromDisk()` es el puente:

```bash
hives add-skill mi-skill        # genera el andamiaje
```
```typescript
await skills.importSkillFromDisk("./skills/mi-skill");   // lo materializa como fila editable
```

Es idempotente por id: editás el archivo, reimportás, y actualiza en vez de
duplicar. Reutiliza el mismo `parseFrontmatter` que `SkillLoader` — con dos
parsers distintos, un día aceptarían formatos distintos.

A diferencia de una tool, una skill **es instruccional**: metadatos más un cuerpo
markdown que se le inyecta al agente, sin `execute`. Por eso sí puede crearla un
usuario desde una interfaz sin abrir la puerta a ejecutar código arbitrario.

Cada alta, edición o borrado re-sincroniza el índice BM25: una skill que no está
indexada es una skill que el modelo no encuentra.

---

## Cron: híbrido a propósito

Si hay un `CronScheduler` corriendo, se delega en él — es quien sabe calcular la
próxima ejecución y rearmar los timers. Si no, se opera directo sobre la
colección, para que un proceso que sólo administra tareas (una UI, un script) no
necesite levantar el scheduler entero. Una tarea creada sin scheduler queda
persistida y la recoge el próximo arranque.

`triggerCronJob()` es la excepción: **exige** scheduler, porque sin él no hay
nada que la ejecute y devolver `true` sería mentir.

---

## MCP: probar antes de guardar

`testMcpServer()` intenta la conexión y responde si funcionó. Requiere un
`MCPClientManager` activo: sin él no hay quién hable el protocolo.

```typescript
const r = await mcp.testMcpServer("mi-servidor");
if (!r.ok) mostrarError(r.error);
```

---

## Endpoints HTTP como herramientas

Es lo más cerca de "crear una tool desde la UI" sin abrir la puerta a ejecutar
código arbitrario: el usuario aporta **datos** —URL, método, cabeceras, qué
parámetros acepta— y el ejecutor es genérico.

```typescript
await endpoints.createEndpoint({
  name: "Clima",
  description: "Consulta el clima de una ciudad",   // esto es lo que lee el modelo
  method: "GET",
  url: "https://api.example.com/clima",
  query: { ciudad: "{{ciudad}}" },
  secretHeaders: { Authorization: "Bearer sk-..." },
  paramSchema: {
    type: "object",
    properties: { ciudad: { type: "string", description: "Nombre de la ciudad" } },
    required: ["ciudad"],
  },
});
```

Queda disponible como `endpoint_clima`. Al registrarse hace tres cosas: guarda
la definición, **cifra las credenciales aparte**, y escribe su fila en `tools`
más el reíndice — sin ese último paso el modelo nunca sabría que existe, porque
el loadout inicial es mínimo por diseño.

**La credencial no vuelve a salir.** `getEndpoint` y `listEndpoints` devuelven
`secretHeaderNames` (qué cabeceras hay configuradas) pero nunca sus valores, y
tampoco aparecen en el resultado de una ejecución. Es lo que hace que un
endpoint sea más seguro que darle al modelo una `api_request` con la clave
escrita en el prompt.

`testEndpoint(id, params)` lo llama sin pasar por el modelo, para probarlo antes
de dejárselo a un agente. Tras un reinicio, `registerEndpointTools()` rearma las
tools en memoria desde la base.

---

## Seed selectivo: elegir los agentes

Históricamente el seed era todo o nada: las 8 personas del catálogo en cada
arranque, con las 62 tools activas. Para un producto donde cada quien arma su
colmena eso es demasiado — y contradictorio, porque el usuario termina apagando
a mano lo que nunca pidió.

### La colmena arranca vacía si querés

```typescript
await ensureHiveDb({ specialists: "none" });      // ningún especialista
await ensureHiveDb({ specialists: ["web_researcher"] });  // sólo ése
await ensureHiveDb();                              // los 8 (default, sin cambios)
```

Con `"none"`, una instalación limpia queda así:

| | |
|---|---|
| Especialistas | 0 |
| Tools activas | las 8 `MINIMAL_TOOLS` |
| Skills activas | 0 |
| Filas de tools/skills | **todas**, apagadas |

Las mínimas quedan prendidas porque son la competencia del coordinador —delegar,
buscar, avisar— y sin ellas no hay colmena a la que agregarle especialistas. Y
las filas existen todas aunque estén apagadas: activarlas después no requiere
volver a sembrar nada desde el código.

**La elección gobierna qué se crea, nunca qué se conserva.** Arrancar con
`"none"` en una base que ya tiene sus ocho agentes **no borra ninguno**: se
siguen reconciliando en cada arranque como siempre. Cambiar de modo es seguro.

```typescript
setup.listCatalogPersonas();                       // qué ofrecer en la UI
const plan = setup.planSeedFor(["web_researcher"]); // qué se instalaría, sin tocar nada
await setup.applySeedPlan(["web_researcher"]);      // aplicarlo
```

**Se siembra la unión, no "lo de cada agente".** Es el error obvio y no
funciona, porque las tools se comparten: `web_fetch` lo declaran el investigador
web y el operador de navegador; `fs_*`, el operador de archivos y el ingeniero.
A eso se suman las `MINIMAL_TOOLS` —delegar, buscar, avisar— que el coordinador
necesita siempre, haya los agentes que haya. Y los globs se expanden: `fs_*` no
es una tool, son varias.

**Desactivar no borra.** Las filas de `tools` y `skills` son globales y
compartidas; borrar las de un agente rompería a otro. Se marca el agente y se
recalcula la unión:

```typescript
await setup.disableCatalogAgent("web_researcher");
// browser_operator sigue activo, así que web_fetch sigue activa
```

**Y sobrevive al reinicio.** El reseed del arranque reescribe las filas de tools
y skills desde el código —descripción y categoría son la fuente de verdad— pero
**preserva `active`**, que es la elección del usuario. Sin eso, el seed
selectivo duraría hasta el próximo reinicio.

### Activar especialistas antes de usarlos

Los especialistas que vas a delegar definen qué tools y skills hacen falta.

```typescript
// Ver qué se encendería, sin encender nada
const gap = await setup.planActivationFor(["web_researcher", "software_engineer"]);
// → { agents: ["software_engineer"], tools: ["cli_exec", …], skills: […], nonCatalog: [] }
```

`planActivationFor` devuelve el **faltante**, no el conjunto entero: una tool
que ya está activa porque la usa otro agente no aparece, porque prometerle a la
UI un cambio que no va a ocurrir es peor que no decir nada. Los agentes que no
son del catálogo salen aparte en `nonCatalog` —traen sus propias tools— y no
hacen fallar el plan. Es un plan, no una acción: la UI puede preguntar antes de
confirmar con `applySeedPlan`.

---

## Skills declaradas en código

`createAgent({ skills })` ahora **sí** hace algo. Estaba tipado y se descartaba
en silencio: declarar una skill no tenía ningún efecto. Ahora se materializa
como fila y se indexa, igual que ya ocurría con `tools`. Es idempotente —
declarar la misma skill dos veces la actualiza.

---

## Imágenes

`@johpaz/hive-sdk/images` usa `Bun.Image` — sharp integrado en el runtime, sin
dependencias nativas ni bindings que compilar. El SDK ya exige Bun ≥ 1.4.2, así
que no agrega ningún requisito.

Cubre dos cosas que conviene no confundir:

**1. Tools activables** (`image_metadata`, `image_transform`), como cualquier
otra del catálogo. Trabajan sobre **artefactos**, no sobre base64 suelto:
entra un `artifact_id` y sale otro. Devolverle una imagen en base64 al modelo es
exactamente lo que llena la ventana de contexto.

```typescript
// El modelo maneja referencias; sólo mira la imagen si de verdad la necesita.
{ ok: true, artifact_id: "art_...", width: 64, height: 64, format: "webp" }
```

**2. Normalización de lo que entra.** Una foto de teléfono son varios megabytes
y unos cuantos miles de tokens. `multimodalService.processImage()` la achica
antes de mandarla al modelo:

```
3024x4032 JPEG, 217 KB  →  768x1024 WebP, 4 KB   (98% menos)
```

Y el ahorro se multiplica: esa imagen no viaja una sola vez, queda en el
historial y se reenvía en cada turno siguiente.

Es best-effort. Si el runtime no puede procesarla o la imagen está corrupta, se
manda tal cual — perderla sería peor que mandarla grande. Una URL no se toca:
no ocupa contexto, porque la descarga la hace el proveedor.

```typescript
import { normalizeForModel, transformImage, measureImage } from "@johpaz/hive-sdk/images";
```

> Detalle de `Bun.Image`: las transformaciones son **diferidas**. `metadata()`
> sobre una cadena sin materializar devuelve las dimensiones del origen, no las
> del resultado — hay que pedir los bytes y releerlos. `measureImage()` y
> `transformImage()` ya lo hacen.

---

## Referencia

Todo desde `@johpaz/hive-sdk/services`, disponible suelto o por dominio
(`import { agents } from "..."` → `agents.createAgent`).

### `agents`
`createAgent` · `getAgent` · `listAgents` · `updateAgent` · `deleteAgent`
`assignTools` · `assignSkills` · `assignMcpServers` · `enableAgent` · `disableAgent`
`slugify` — el id se deriva del nombre normalizando acentos: "Diseño" → `diseno`, no `dise_o`.

### `skills`
`createSkill` · `getSkill` · `listSkills` · `updateSkill` · `deleteSkill` · `toggleSkill`
`importSkillFromDisk` — el puente entre `hives add-skill` y la base.

### `tools`
`listTools` · `getTool` · `toggleTool` · `updateToolMetadata`
No hay `createTool`: una tool es código. Ver arriba las tres vías reales.

### `endpoints`
`createEndpoint` · `getEndpoint` · `listEndpoints` · `updateEndpoint` · `deleteEndpoint`
`toggleEndpoint` · `testEndpoint` · `registerEndpointTools` · `buildEndpointTool` · `toolNameFor`

### `providers` y `models`
`listProviders` · `getProvider` · `createProvider` · `updateProvider` · `toggleProvider` · `deleteProvider`
`listModels` · `getModel` · `createModel` · `toggleModel` · `deleteModel` · `renameModel` · `agentsUsingModel`

### `mcp`
`listMcpServers` · `getMcpServer` · `createMcpServer` · `updateMcpServer`
`testMcpServer` · `toggleMcpServer` · `deleteMcpServer`

### `cron`
`createCronJob` · `getCronJob` · `listCronJobs` · `updateCronJob` · `deleteCronJob`
`pauseCronJob` · `resumeCronJob` · `triggerCronJob` · `getCronHistory` · `hasScheduler`

### `memory`
`writeMemory` · `readMemory` · `listMemories` · `searchMemories` · `deleteMemory`
Aisladas por usuario: el `userId` es opcional y se resuelve del contexto.

### `ethics`
`listEthics` · `getEthics` · `createEthics` · `updateEthics` · `toggleEthics` · `deleteEthics`

### `images`
`uploadImage` · `transformStoredImage` · `getImageBytes` · `listImages`
`setImageRetention` · `deleteImage` · `applyPreset` · `IMAGE_PRESETS`

### `setup`
`listCatalogPersonas` · `planSeedFor` · `applySeedPlan` · `planActivationFor`
`enableCatalogAgent` · `enableCatalogAgents` · `disableCatalogAgent`
`listEnabledCatalogAgents` · `CATALOG_AGENT_IDS`

*Documentación Hive SDK — ver `version` en package.json*
