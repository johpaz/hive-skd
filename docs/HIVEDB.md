# HiveDB en el SDK: qué guarda, cómo se usa y qué activar

HiveDB (`@johpaz/hive-db` 0.6.1 o posterior) es la base embebida de Hive: un
solo directorio, sin servidor. El SDK la abre solo (`ensureHiveDb()`); esta guía
explica qué hace por ti, qué puedes encender y cuándo conviene.

## 1. Qué hace por defecto (sin configurar nada)

| Función | Qué es |
|---|---|
| **Colecciones** | Estado mutable: agentes, conversaciones, resúmenes, notas, cron, providers, modelos. Se leen con `col<T>("nombre")`. |
| **Índice de capacidades (BM25)** | Cómo el agente descubre tools, skills, reglas del playbook y tools de MCP sin cargarlas todas en el prompt. |
| **Sync incremental** | Al arrancar, el SDK solo reindexa lo que cambió (hash por documento en `capability_sync`). Un arranque con el catálogo igual no toca el índice. |
| **Log causal** | Decisiones y tool calls para el reflector y el contexto causal. Apagado por defecto (`HIVE_CAUSAL_LOG=true` o `causalLog.enabled`). |
| **Multi-inquilino** | Una sola base para varios enjambres con `runInTenant`; el ámbito viaja como prefijo de colección y como filtro del índice. |

Dónde vive: `<HIVE_HOME>/data/hivedb` (por defecto `~/.hive/data/hivedb`).
`HIVE_DB_PATH` fija otra ruta; `":memory:"` abre una base efímera (tests).

Un solo proceso es dueño de la base: un segundo proceso que la abra falla con
`Database already open`.

## 2. Opciones que puedes activar

Se declaran en `hive.config.ts` (bajo `memory`) o por entorno. Todas vienen
**apagadas**.

### 2.1 Memoria entre conversaciones

```typescript
// hive.config.ts
export default {
  memory: { crossThreadRecall: { enabled: true, k: 3 } },
};
```

Cada vez que se compacta un hilo, su resumen se indexa. Con la opción encendida,
el prompt incluye un bloque `CONVERSACIONES RELACIONADAS` con los resúmenes más
parecidos al objetivo de **otros hilos del mismo inquilino**.

- **Actívala si** tus usuarios retoman temas entre conversaciones distintas.
- **No la actives si** varios usuarios comparten un inquilino: cruzaría sus
  conversaciones.
- Hoy busca por palabras (BM25): encuentra hilos que comparten vocabulario, no
  los que dicen lo mismo con otras palabras (ver 2.2).
- `deleteThread` quita el resumen del índice.

### 2.2 Búsqueda por significado (embedder local) — experimental

```typescript
export default { memory: { embedder: "local" } };
// o, por entorno:  HIVE_EMBEDDER=local
```

Abre la base con un modelo multilingüe local (`multilingual-e5-small`): el texto
no sale de la máquina.

**Lo que cuesta**

- Descarga única de ~470 MB al primer uso (`HIVEDB_OFFLINE=1` la impide; ver la
  guía de instalaciones sin red de HiveDB).
- ~735 MiB de RAM mientras el proceso corre; el modelo se comparte entre bases.
- ~46 ms por búsqueda de texto (se calcula el embedding de la consulta) y varios
  segundos extra al indexar un catálogo completo.
- **La base queda ligada al modelo, para siempre.** Abrirla después sin el
  embedder, o con otro, falla con `VECTOR_SPACE_MISMATCH`. Cambiarlo obliga a
  crear una base nueva y reindexar. Decídelo antes de tener datos que importen.

**Lo que aporta (medido con el catálogo de tools nativas)**

Poco. Con descripciones cortas y técnicas los vectores se parecen demasiado entre
sí, y BM25 ya acierta cuando la consulta comparte palabras con la tool. Donde
BM25 no devolvía nada ("mandar un correo al cliente"), el híbrido devolvió tools
sin relación. Además, en modo híbrido `score` pasa a ser RRF (≈0,016–0,033) y el
corte relativo de los selectores (`applyRelativeCutoff`) deja de filtrar.

**Dónde sí podría servir** (hipótesis, sin medir): textos largos en lenguaje
natural, como resúmenes de conversación (2.1), episodios de tareas pasadas y
hechos sueltos del usuario o del proyecto.

**Recomendación**

| Situación | Qué hacer |
|---|---|
| Solo tools, skills y playbook | Déjalo apagado. |
| Usas `crossThreadRecall` y ya hay conversaciones reales | Mide con consultas de tus propios hilos antes de decidir. |
| Aún no tienes datos | Déjalo apagado; activarlo después es más barato que reindexar. |

Si lo activas, no uses el corte relativo sobre `score`: calibra con
`vectorScore` y `textScore`.

## 3. Operación

- **Cierre limpio.** Llama a `closeHiveDb()` (y `flushTraces()` de
  `@johpaz/hive-sdk/agent` antes) en `SIGINT`/`SIGTERM`. Un cierre limpio deja
  guardados el grafo y el índice de texto y la siguiente apertura tarda
  milisegundos; tras un cierre brusco todo se reconstruye solo (es seguro, pero
  más lento). El template `hive-app` ya lo hace.
- **Copias de seguridad.** Con la base cerrada, copia el directorio entero. No
  hay instantánea consistente con la base abierta.
- **Migración desde 0.5.x.** Una base del formato anterior se migra sola al abrir
  y después **no abre con 0.5.x**. Copia el directorio antes de actualizar si
  necesitas poder volver atrás.
- **Log causal.** No borra eventos; decide una política de retención antes de
  activarlo en un servicio multiusuario.

## 4. Errores frecuentes

| Error | Causa | Qué hacer |
|---|---|---|
| `Database already open` | Otro proceso tiene la base | Un solo proceso propietario |
| `VECTOR_SPACE_MISMATCH` | La base se creó con otro modelo de embeddings | Usa la misma opción `embedder`, o base nueva |
| `EMBEDDER_UNAVAILABLE` | Modelo sin descargar y `HIVEDB_OFFLINE=1` | Descarga el modelo o quita la variable |

Más detalle del motor en la documentación de HiveDB (`docs/AGENT_GUIDE.md` y
`docs/USER_GUIDE.md` del repositorio `hive-db`).
