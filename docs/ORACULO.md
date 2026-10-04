# Guía de implementación — con y sin oráculo (Jev / Kev)

El **oráculo** es un modelo pequeño que responde preguntas cerradas («¿este mensaje hace falta?», «¿qué
especialista conviene?», «¿esta respuesta está respaldada por la evidencia?») sin generar texto. El SDK lo usa
para decidir qué entra al prompt, qué hacer entre iteraciones, y para **revisar** la respuesta antes de entregarla.
El modelo de texto de cada agente sigue haciendo todo lo demás.

Hay dos oráculos, que hablan el mismo protocolo (System One):

| | **Jev** | **Kev** |
|---|---|---|
| Qué es | `typesafe/jev-1.13` en la API Decisions de OpenRouter | Kev-9B del laboratorio HiveAgents, `POST /v1/systemone` |
| Quién lo usa | Lo normal: cualquier app con una llave de OpenRouter | Quien tenga acceso al laboratorio |
| Costo | Muy bajo por decisión (~USD 0,00002) | Ninguno por decisión |
| Privacidad | El texto del turno sale hacia OpenRouter | No sale de tu infraestructura |
| Latencia típica | 0,2–0,5 s | 0,2–0,9 s (comparte GPU con el chat) |

**Es opcional.** Sin oráculo el SDK compila el contexto y corre el loop de la forma clásica, sin ninguna llamada
extra. Esta guía cubre los tres escenarios: sin oráculo, con Jev y con Kev.

---

## 1. Sin oráculo (por defecto)

No hay nada que configurar. Si no hay llave de HiveAgents ni de OpenRouter, o si pasas `oracle: false`:

```ts
import { createAgent } from "@johpaz/hive-sdk";

const agent = await createAgent({
  name: "asistente",
  provider: "anthropic",
  model: "claude-opus-5",
  systemPrompt: "Eres un asistente claro y directo.",
  oracle: false, // explícito; es lo mismo que no tener ninguna llave
});

for await (const event of agent.chat("Hola")) {
  if (event.type === "done") console.log(event.response, event.usage);
}
```

Qué cambia y qué no:

- El contexto lo selecciona el compilador clásico (últimos mensajes, tools mínimas, skills y reglas por búsqueda).
- No se poda ningún resultado de tool, no se decide el paralelismo con el oráculo y **no se verifica** la respuesta.
- `done.usage.oracleCorrections` es `0` y `oracleUnsatisfied` es `false`.
- Es el piso: cualquier fallo, cooldown o desconfianza del oráculo (secciones 4 y 7) deja el turno exactamente aquí.

Qué esperar de rendimiento: en las mediciones de este repo (Qwen3.6 35B local, 12 preguntas, razonamiento
apagado) el agente **sin oráculo** quedó en **11–13 s de mediana y 0 fallos de contenido**. No es una versión
«degradada»; es una configuración válida para producción.

---

## 2. Con Jev (OpenRouter)

### 2.1 Una sola app (una llave)

La forma más corta es pasar la llave en la opción, sin tocar la base:

```ts
const agent = await createAgent({
  name: "asistente",
  provider: "anthropic",
  model: "claude-opus-5",
  oracle: { provider: "openrouter", apiKey: process.env.OPENROUTER_API_KEY! },
});
```

La otra forma es por entorno: define `OPENROUTER_API_KEY` y habilita el provider `openrouter` en HiveDB (la
fila tiene que estar **habilitada y activa**; con la llave sola, sin la fila, no se enciende). Con eso basta un
`createAgent` sin `oracle`: el modo `auto` lo encuentra.

### 2.2 Muchas organizaciones en una misma base (multi-inquilino)

Cada llamada trae su llave. Con inquilino activo el SDK **nunca** usa `OPENROUTER_API_KEY` ni
`HIVEAGENTS_API_KEY` de la plataforma: solo los secretos del inquilino o lo que le pases.

```ts
import { runInTenant } from "@johpaz/hive-sdk/storage";

await runInTenant(tenantId, async () => {
  for await (const event of agent.chat(message, {
    oracle: { provider: "openrouter", apiKey: await keyOfTenant(tenantId) },
  })) { /* … */ }
});
```

El estado de fallos, el cooldown y la desconfianza (secciones 4 y 7) se llevan **por inquilino**: la llave inválida
de uno no deja a los demás en la ruta clásica.

---

## 3. Con Kev (laboratorio HiveAgents)

### 3.1 Configuración

Kev se enciende en cuanto hay una **llave de HiveAgents**, sin más opciones:

- fuera de inquilino: `HIVEAGENTS_API_KEY` en el entorno;
- en cualquier caso: la llave guardada del provider `hiveagents` (secret store del inquilino);
- o explícita: `oracle: { provider: "hiveagents", apiKey }`.

Por defecto habla con `https://llm.hiveagents.io/v1/systemone` y envía `model: "kev"`. La URL base sale de la fila
del provider `hiveagents` (`base_url`) o de `HIVEAGENTS_BASE_URL`. Para un servidor propio (llama.cpp sirve
`/v1/systemone`):

```ts
oracle: { provider: "hiveagents", apiKey: "cualquier-cadena", endpoint: "http://localhost:8080/v1/systemone", model: "kev" }
```

Con un servidor propio el texto del turno no sale de tu máquina. `apiKey` sigue siendo obligatoria (cualquier cadena
no vacía si el servidor no la comprueba).

### 3.2 Particularidades de Kev

- Cada pregunta necesita `instructions` (el SDK ya las envía).
- Contexto máximo de 8.192 tokens y 2 slots: los extractos que se le mandan son cortos (650 caracteres por
  resultado, 9 resultados como máximo).
- Comparte GPU con el chat: con el chat ocupado sus decisiones tardan más (medido: ~0,7 s frente a ~0,17 s con la
  GPU libre). Si la decisión tarda más de 3 s se descarta y el turno sigue clásico.

---

## 4. Qué provider se usa: `auto`

Sin la opción `oracle`, o con `provider: "auto"`, gana el primero configurado:

| Hay llave de HiveAgents | Hay llave de OpenRouter | Se usa |
|---|---|---|
| sí | sí o no | **Kev** |
| no | sí (provider habilitado) | **Jev** |
| no | no | ninguno (ruta clásica) |

`provider: "openrouter"` o `"hiveagents"` fuerza uno y **no cae en el otro** (si falta su llave, no hay oráculo).
`oracle: false` lo apaga.

> Si ya tenías OpenRouter y además tienes una llave de HiveAgents, `auto` pasa a usar Kev. Para seguir con Jev:
> `oracle: { provider: "openrouter" }`.

`jev` sigue funcionando como nombre anterior de `oracle` (con la misma forma). Si pasas las dos, gana `oracle`.

---

## 5. Qué hace el oráculo

Tres decisiones que no cambian la corrección (si fallan, el turno sigue por la ruta clásica) y una revisión:

| Momento | Qué decide |
|---|---|
| Al compilar el contexto | Qué mensajes previos, tools descubiertas, skills, notas y reglas entran; qué especialista conviene (solo el coordinador); y cuánto razonar si el agente usa `thinking: "auto"`. Los últimos 4 mensajes siempre quedan. |
| Entre iteraciones | Qué resultados **de rondas anteriores** se omiten y qué hacer a continuación (continuar, delegar, descubrir o cerrar). Un resultado de la ronda que acaba de correr nunca se omite: el modelo todavía no lo ha leído. |
| Antes de ejecutar tools | Si un lote de lecturas independientes corre en paralelo. |
| **Revisión de la respuesta** | Antes de entregar una respuesta que descansa en tools, comprueba que la evidencia la respalda. Si no, pide reescribirla (sección 6). |

Las tools que **declaras** en `createAgent({ tools })` no se podan: son un contrato, el oráculo solo recorta lo que
se descubre.

---

## 6. Verificación

```ts
oracle: {
  provider: "auto",
  verify: {
    answer: true,        // por defecto: revisa la respuesta antes de entregarla
    tools: false,        // por defecto: NO revisa el resultado de cada lote de tools
    maxCorrections: 2,   // veces por turno que puede mandar a corregir (0 = solo observar)
  },
}
```

**`verify.answer`.** Cuando el turno usó tools y el modelo contesta sin pedir más, el oráculo responde si la
respuesta está respaldada por la evidencia recogida (`cumple` / `no_cumple`). Con `no_cumple` (confianza ≥ 0,8) y
correcciones disponibles, la respuesta **no se entrega**: se le pide al modelo reescribirla usando solo los
resultados, y el turno continúa. Casos que detecta: «No tengo eso documentado» cuando algún resultado sí lo
documenta, o contradecir lo que dicen los resultados.

- Los resultados **vacíos** (`items[0]`, `[]`, solo una `nota`) no cuentan como evidencia: «no hay información»
  sobre algo que no existe es una respuesta correcta y no se cuestiona.
- Con streaming (`stream: true`), los tokens de esa llamada **esperan al veredicto** (una decisión, ~0,3–0,9 s) para
  que una respuesta rechazada no llegue al usuario. Si no hay evidencia o no quedan correcciones, el streaming es el
  de siempre.
- Cada firma de tool+argumentos y cada respuesta se corrigen una sola vez.

**`verify.tools`** (apagado por defecto). Tras cada lote pregunta si los resultados responden al objetivo y manda al
agente a buscar de nuevo si no. Se midió que **hacía daño**: ante una pregunta sin respuesta documentada, mandaba a
buscar otra vez lo que no existe (3 a 10 veces más lento para la misma respuesta). Enciéndelo solo si tus tools
devuelven resultados fuera de tema y no vacíos.

**Qué ve el host.** `done.usage` trae `oracleCorrections` (cuántas veces mandó a corregir) y `oracleUnsatisfied`
(siguió sin dar por buena la respuesta y no quedaba nada que intentar). Cada decisión llega también por `onStep`
como `{ type: "jev_decision", jev }` con `kind` en `context`, `iteration`, `parallel`, `verify`, `answer` u
`overruled`.

---

## 7. Cuando el oráculo se equivoca o no está

El oráculo **nunca bloquea un turno**: un timeout (3 s), un error HTTP, una respuesta inválida o una excepción
devuelven «sin decisión» y el turno sigue clásico. Tres fallos seguidos, o una llave rechazada (401/403), lo ponen
en cooldown de 60 s.

Además, el runtime detecta **contradicciones** medibles, sin heurísticas de texto:

- aconsejó terminar (`finish`) y la respuesta no tenía respaldo;
- omitió un resultado y el modelo lo pidió de nuevo (la misma tool con los mismos argumentos);
- exigió una corrección y la repetición devolvió la misma evidencia.

Tres seguidas dejan al oráculo **de lado 5 minutos**: el turno corre por la ruta clásica y `getJevStatus()` pasa a
`fallback` con el motivo. Un veredicto `cumple` que nada contradijo reinicia la cuenta.

```ts
import { getJevStatus, resetJevStatus } from "@johpaz/hive-sdk/agent";

const status = await getJevStatus(); // { state: "off" | "ready" | "fallback", lastError, lastSuccessAt, totals }
resetJevStatus();                    // después de cambiar la llave, por ejemplo
```

---

## 8. Coordinador y especialistas

El coordinador es quien habla con el usuario, con o sin oráculo. Hay dos formas de usar especialistas.

### 8.1 Coordinador que delega (`task_delegate`)

El worker delegado de forma síncrona **hereda el oráculo y la llave** del turno que delega (solo en memoria; nunca
viajan en un job persistido). Si el oráculo no pudo respaldar la entrega del especialista, el resultado de la
delegación trae:

```json
{ "ok": true, "result": "…", "verification": { "status": "unsupported", "corrections": 2, "note": "La verificación no pudo confirmar… No la presentes como un hecho comprobado…" } }
```

- `unsupported`: el coordinador debe darle la respuesta al usuario con honestidad (qué parte está respaldada y cuál
  no). La nota ya se lo pide.
- `corrected`: el oráculo hizo corregir y la versión final quedó respaldada. No hace falta mencionarlo.
- Sin `verification`: no hubo nada que decir. Es idéntico al comportamiento sin oráculo.

En la delegación **asíncrona**, el resumen con el que el coordinador cierra el turno trae `verification` por
entrega y la instrucción equivalente.

Añádelo al prompt del coordinador (ejemplo del proyecto tuprofedeia):

```text
El resultado de task_delegate puede traer verification. Si su status es "unsupported", la verificación no pudo
respaldar esa respuesta con la evidencia: entrega la respuesta del especialista y añade al final una frase
honesta (qué no se pudo comprobar), sin afirmarla como un hecho. Si no trae verification o dice "corrected",
no añadas nada.
```

### 8.2 Especialista directo, sin coordinador

Cuando cada endpoint ya sabe a qué especialista ir (más rápido: se evita la llamada de delegación), el aviso lo
lees tú en el evento `done`:

```ts
let text = "";
for await (const event of specialist.chat(question, { threadId })) {
  if (event.type === "done") {
    text = event.response;
    if (event.usage?.oracleUnsatisfied) {
      text += "\n\n_Nota: no pude comprobar esta respuesta contra el material publicado. Tómala con cautela._";
    }
  }
}
```

Con streaming, añade esa nota como último fragmento tras el último token.

---

## 9. Qué pasa si no hay oráculo y quieres igual revisar

La revisión necesita oráculo. Sin él:

- el coordinador y los especialistas funcionan igual que siempre;
- `oracleUnsatisfied` nunca se activa, así que tu app no mostrará avisos de «no comprobada»;
- si necesitas esa garantía sin oráculo, hazla en una tool determinista (como las `acceptance` con `checkTool`
  de `task_delegate`) o en tu capa de aplicación.

---

## 10. Privacidad: qué viaja al oráculo

El objetivo del turno (el mensaje del usuario) **siempre** viaja: sin él no hay decisión. Todo lo demás se puede
recortar con `share`:

```ts
oracle: {
  provider: "openrouter",
  apiKey,
  share: {
    instructions: false, // no se envía el extracto del system prompt (Jev juzga las tools solo por su nombre)
    history: false,      // no se envían mensajes previos (el historial no se poda)
    toolResults: false,  // no se envían resultados ni argumentos de tools (no se poda ni se verifica)
  },
}
```

Apagar una parte cuesta decisiones, nunca corrección. **Con `toolResults: false` no hay revisión de la respuesta**
(no hay evidencia que enseñarle). Con Jev, los extractos van a OpenRouter con la llave de la llamada; nunca
credenciales ni adjuntos. Con Kev en tu infraestructura no salen de ella.

---

## 11. Un respaldo de modelo (patrón del proyecto tuprofedeia)

Esto no es del SDK, pero es el patrón que usa `Api/src/hive`: si el LLM local se cae, atender con otro modelo.

- El SDK guarda proveedor y modelo **en la fila del agente**, así que el mismo agente no sirve con dos modelos:
  crea copias con otro id (`especialista_sitio__respaldo`) con los mismos prompts, tools y skills.
- Cambia de modelo solo si el principal no responde (`/api/status` caído) o falla **antes de emitir un token**.
- Los agentes de respaldo van con `oracle: false` (si el laboratorio está caído, Kev también) y con la llave en
  `credentials`: el SDK prefiere la llave del secret store/llavero sobre el entorno, y una llave vieja guardada ahí
  le ganaría a la de tu `.env`.
- Tras un fallo, salta el principal 60 s para que la siguiente visita no espere otro timeout.

---

## 12. Variables de entorno

| Variable | Qué hace |
|---|---|
| `OPENROUTER_API_KEY` | Llave de Jev (fuera de inquilino; además la fila `openrouter` debe estar habilitada y activa) |
| `HIVEAGENTS_API_KEY` | Llave del laboratorio: enciende Kev en `auto` (fuera de inquilino) |
| `HIVEAGENTS_BASE_URL` | URL base del laboratorio (por defecto `https://llm.hiveagents.io`) |

En el proyecto tuprofedeia (`Api/src/hive/agents.ts`): `HIVE_ORACLE=auto|hiveagents|openrouter|off` y
`HIVE_VERIFY=off|answer|tools|all` (por defecto `answer`).

---

## 13. Cómo medir en tu proyecto

1. Define un banco de preguntas con respuesta conocida: unas **documentadas**, otras que **no** lo están, y
   algunas que no usan tools.
2. Corre cada configuración (sin oráculo / Jev / Kev, con y sin `verify`) con el **mismo modelo** y razonamiento
   fijo, y cuenta: mediana, turno más largo, fallos de contenido y `oracleCorrections`.
3. Repite las preguntas que fallan varias veces: un modelo local varía de corrida a corrida y un solo fallo no
   distingue al oráculo del azar.
4. No cambies el código mientras corre la matriz: cada proceso lo lee al arrancar.

Resultados medidos en este repo (Qwen3.6 35B en el laboratorio, razonamiento apagado, 12 preguntas, una corrida
por configuración; úsalos como referencia de orden de magnitud, no como cifras exactas):

| Configuración | Mediana | Media | Fallos |
|---|---|---|---|
| Sin oráculo | 11,0 s | 10,3 s | 0 |
| Jev, verifica la respuesta | 9,0 s | 10,3 s | 0 |
| Kev, verifica la respuesta | 14,8 s | 13,3 s | 0 |
| Jev, verifica también las tools | 14,3 s | 29,5 s | 0 (7 correcciones, turno de 134 s) |

Gemini 3.8 Flash dio ~7 s de mediana y 0 fallos en todas las configuraciones. Conclusión práctica: el oráculo
**no acelera** un agente con una sola tool por especialista y contexto chico; su valor es la **revisión de la
respuesta** y que el runtime ya no destruye evidencia (la poda de resultados no leídos fue la causa de los falsos
«No tengo eso documentado» y de turnos de hasta 450 s).

---

## 14. Migración desde `jev`

| Antes | Ahora |
|---|---|
| `jev: { apiKey }` | `oracle: { provider: "openrouter", apiKey }` (el alias `jev` sigue valiendo) |
| `jev: { apiKey, endpoint, model: "kev" }` | `oracle: { provider: "hiveagents", apiKey, endpoint, model: "kev" }` |
| `jev: false` | `oracle: false` |
| sin opción | `auto`: Kev si hay llave de HiveAgents, si no Jev |
| `getJevKey(option)` | `resolveOracle(option)` devuelve `{ kind, apiKey, endpoint, model } \| null` |

Hay que tener en cuenta dos cambios de comportamiento: la verificación de la respuesta está **activa por defecto**
cuando hay oráculo (`verify.answer`), y `auto` prefiere Kev sobre Jev cuando hay llave de HiveAgents.

---

## 15. Lista de comprobación antes de producción

- [ ] Sé qué oráculo se usa (`resolveOracle()` o `getJevStatus()`), y qué pasa si no hay ninguno.
- [ ] La llave de cada inquilino llega por `oracle`/`credentials`, no por el entorno de la plataforma.
- [ ] Mi app lee `usage.oracleUnsatisfied` (especialista directo) o mi coordinador tiene la instrucción de
      `verification` en su prompt.
- [ ] Con streaming probé que una respuesta rechazada no llega al usuario.
- [ ] Probé el agente **sin** llaves (ruta clásica) y con el oráculo apagado a mitad de un turno.
- [ ] Medí con mi modelo y mis preguntas (sección 13) antes de dejar `verify.tools` encendido.
