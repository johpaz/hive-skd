# Benchmark de la línea de tiempo del historial

¿Cuánto de lo plantado **fuera de la ventana** (los últimos 15 mensajes) llega, literal, al system prompt que
compila `compileContext`? Compara el modo actual (recuperación fija de 3 mensajes × 500 caracteres) con
`HIVE_HISTORY_TIMELINE=true` (línea de tiempo de 80 caracteres por mensaje + recuperación que llena un
presupuesto). Sin modelo, sin red, determinista. Idea tomada de FlexA-Mem (arXiv 2610.33274).

```bash
bun run bench:history-timeline            # tarda ~6 min: cada consulta compila el contexto completo
bun run bench:history-timeline -- --seeds 1 --out resultados.json
```

Usa los escenarios y la puntuación de `bench/compaction` (27 datos plantados entre relleno con señuelos, 3
semillas). Tres tipos de consulta:

- **A · una pregunta por dato** (control). Comparte palabras con el dato, y ahí la búsqueda actual ya acierta.
- **B · una consulta vaga** («retoma lo que habíamos acordado antes»), sin palabras del dato.
- **C · una sola consulta que pide todo** («resume todo lo que acordamos» + las 9 preguntas): mide cuánto cabe.

## Resultados (salida cruda en `resultados.txt`)

| Ventana del modelo | Consulta | Actual | Timeline | Prompt medio (actual → timeline) |
|---:|---|---:|---:|---:|
| 8 000 | A | 100 % | 100 % | 7 162 → 8 679 |
| 8 000 | B | 0 % | 7 % | 7 100 → 8 799 |
| 8 000 | C | 33 % | 81 % | 7 409 → 9 515 |
| 32 000 | A | 100 % | 100 % | 7 162 → 11 178 |
| 32 000 | B | 0 % | 56 % | 7 100 → 11 284 |
| 32 000 | C | 33 % | 100 % | 7 409 → 12 477 |
| 128 000 | A | 100 % | 100 % | 7 162 → 14 535 |
| 128 000 | B | 0 % | 85 % | 7 100 → 14 640 |
| 128 000 | C | 33 % | 100 % | 7 409 → 15 834 |

## Qué dice

- Cuando la pregunta comparte palabras con el dato (A) no cambia nada: el modo actual ya acierta.
- Cuando no las comparte (B) o hay que recordar varias cosas a la vez (C), el modo actual se queda en 0 % y
  33 % porque solo recupera 3 mensajes, y la línea de tiempo recupera de 7 % a 100 % según el presupuesto.
- **Cuesta prompt:** entre 1 500 y 7 500 caracteres más (≈ 400–1 900 tokens), que crecen con la ventana porque
  los presupuestos son un 3 % (línea de tiempo) y un 4 % (recuperación) de ella. Con ventana de 8 000 la mejora
  es la menor (B: 7 %).

## Qué no dice

- Mide si el dato **está en el contexto**, no si el agente lo usa bien. Los 27 datos son sintéticos y cortos
  (caben en las 80 caracteres de una línea); con mensajes largos la línea de tiempo recortaría el dato y solo
  lo salvaría la recuperación.
- La consulta B es una sola frase y C es artificial; una conversación real queda entre A y C.
- El modo actual tiene la herramienta `conversation_read`, que el agente puede llamar para recuperar lo que no
  ve; este benchmark no la cuenta, así que subestima al modo actual en B y C.
- Una máquina, una ejecución, 3 semillas.

## Con modelo real (`e2e.ts`, Gemini 3.8 Flash)

> **Léelo con la sección final «Ablación y ruido».** Las diferencias de «respondió bien» de abajo son de 3–5 casos sobre 18, y la misma configuración varió 3 casos entre dos corridas idénticas: no son concluyentes.

```bash
bun bench/history-timeline/e2e.ts --hive-credentials --provider gemini --model gemini-3.8-flash --seeds 2
```

La clave se lee en memoria del almacén de secretos de hive (`~/.hive-dev`) y no se imprime. El modelo recibe lo
que compila el SDK (system prompt + ventana reciente) y la pregunta, **sin tools**; la respuesta se puntúa con
`hasAll`, sin juez. Ventana de 32 000, 2 semillas × 9 datos = **18 preguntas por celda**. Crudo en
`resultados-e2e.json`.

| Estilo de pregunta | Modo | Dato en el contexto | Respondió bien |
|---|---|---:|---:|
| Directa (la del escenario) | actual | 18/18 | 18/18 |
| Directa | timeline | 18/18 | 18/18 |
| Indirecta (otras palabras) | actual | 6/18 (33 %) | 6/18 (33 %) |
| Indirecta | timeline | 14/18 (78 %) | 12/18 (67 %) |

- Con preguntas directas no hay diferencia, como en el benchmark determinista.
- Con preguntas indirectas, el modelo acertó el doble con la línea de tiempo (12 frente a 6). Ninguna pregunta
  empeoró; mejoraron `token`, `file` (en las dos semillas), `basic401` y `formal` (en la primera).
- Que el dato esté en el contexto no basta: en 2 de las 14 preguntas con el dato presente, el modelo no lo usó.
- **Límites:** 18 preguntas por celda es poco (una diferencia de 1–2 casos no es concluyente; la de 6 casos sí
  apunta en una dirección, pero no es una estimación precisa). Un solo modelo, una sola ventana, datos
  sintéticos, preguntas indirectas escritas a mano por quien diseñó el benchmark. Sin tools: el modo actual
  puede recuperar lo que le falte llamando a `conversation_read`, y eso no se mide aquí.

### Ventana pequeña y con `conversation_read` (`--window`, `--tools`)

Mismas 18 preguntas por celda; solo se muestran las **indirectas** (las directas dan 18/18 en todas las
celdas). Con `--tools` el modelo puede llamar a la `conversation_read` real (hasta 4 rondas). Crudo en
`resultados-e2e-8k*.json` y `resultados-e2e-32k-tools.json`.

| Ventana | Tools | Actual: respondió bien | Timeline: respondió bien | Dato en contexto (actual → timeline) |
|---:|---|---:|---:|---:|
| 8 000 | no | 6/18 (33 %) | 6/18 (33 %) | 6 → 7 |
| 8 000 | sí | 10/18 (56 %) | 7/18 (39 %) | 6 → 7 |
| 16 000 | sí | 8/18 (44 %) | 12/18 (67 %) | 6 → 12 |
| 32 000 | no | 6/18 (33 %) | 12/18 (67 %) | 6 → 14 |
| 32 000 | sí | 10/18 (56 %) | 15/18 (83 %) | 6 → 14 |

- **El efecto depende de la ventana.** A 32 000 la línea de tiempo mejora con y sin tool (de 6 a 12, y de 10 a
  15 aciertos). A 8 000 no mejora, y con tool queda por debajo (7 frente a 10): ahí el presupuesto es de unos
  300 tokens y la línea de tiempo apenas cabe.
- **La tool ayuda al modo actual** (de 6 a 10 con cualquier ventana), así que parte de lo que la línea de tiempo
  aportaba sin tool ya lo cubre `conversation_read`. Aun así, a 32 000 el modo nuevo gana encima (15 frente a 10).
- Por pregunta, a 32 000 con tool el modo nuevo ganó en 6 casos y perdió en 1; a 8 000 con tool ganó en 1 y
  perdió en 4. Con 18 preguntas por celda, esas diferencias de 3 o 4 casos son una señal, no una medida firme.
- **Límites:** un solo modelo, 2 semillas, datos sintéticos y preguntas indirectas escritas por quien diseñó el
  benchmark. No se probó con ventanas entre 8 000 y 32 000 ni mayores de 32 000.

**Ventana de 16 000 (con `conversation_read`, añadida después):** actual 8/18 (44 %) frente a timeline 12/18
(67 %); por pregunta, el modo nuevo ganó en 5 casos y perdió en 1. Es un solo punto entre 8 000 (no mejora) y
32 000 (mejora), así que el umbral de la compuerta podría bajar a 16 000, pero sigue siendo provisional.

## Ablación y ruido

`HIVE_HISTORY_TIMELINE_PARTS` (`timeline`, `recall`, `both`) activa una sola pieza; `run.ts` y `e2e.ts --modes
actual,solo-recuperacion,solo-linea,ambas` las comparan. Crudo en `resultados-ablacion.txt` y
`resultados-e2e-16k-ablacion.json`.

**Sin modelo (exacto).** Porcentaje de los 27 datos plantados que llega al prompt:

| Consulta | Ventana | Actual | Solo recuperación | Solo línea | Ambas |
|---|---:|---:|---:|---:|---:|
| A · con palabras del dato | cualquiera | 100 % | 100 % | 100 % | 100 % |
| B · vaga | 8 000 | 0 % | 0 % | 7 % | 7 % |
| B · vaga | 32 000 | 0 % | 0 % | 56 % | 56 % |
| B · vaga | 128 000 | 0 % | 0 % | 85 % | 85 % |
| C · pide todo a la vez | 8 000 | 33 % | 81 % | 33 % | 81 % |
| C · pide todo a la vez | 32 000 | 33 % | 100 % | 74 % | 100 % |
| C · pide todo a la vez | 128 000 | 33 % | 100 % | 85 % | 100 % |

- Las piezas se complementan. La **línea de tiempo** es la única que ayuda con una consulta vaga (B): la
  recuperación por búsqueda no tiene palabras que buscar. La **recuperación adaptativa** explica casi toda la
  mejora de C: el modo actual recupera siempre 3 mensajes, un control que no escala con el presupuesto, así que
  la ganancia de C se debe sobre todo a usar el presupuesto, no a la línea de tiempo.
- Esto corrige la lectura de las secciones anteriores, que atribuían la mejora a «la función» en conjunto.

**Con modelo (16 000, `conversation_read`, preguntas indirectas, 18 por celda):**

| Modo | Dato en el contexto | Respondió bien |
|---|---:|---:|
| Actual | 6/18 | 11/18 |
| Solo recuperación | 6/18 | 10/18 |
| Solo línea | 12/18 | 12/18 |
| Ambas | 12/18 | 14/18 |

- «Dato en el contexto» es determinista y coincide con lo de arriba: en preguntas indirectas, solo la línea de
  tiempo sube de 6 a 12.
- **«Respondió bien» es ruido a esta escala.** La configuración «Actual» a 16 000 dio **8/18** en la corrida
  anterior y **11/18** en esta, con el mismo código y temperatura 0 (el modelo no es determinista aunque se pida).
  Una diferencia de 3 casos es el mismo tamaño que el ruido, así que las tablas anteriores de este README
  (8 000: 10→7; 16 000: 8→12; 32 000: 10→15) **no demuestran** ni daño a 8 000 ni mejora a 16 000/32 000.
- Para concluir sobre la calidad de las respuestas haría falta repetir cada celda varias veces y con muchas más
  preguntas (y una prueba pareada, como hace el paper con McNemar). No está hecho.
- **Consecuencia:** la compuerta de 16 000 tokens es una suposición, no un resultado; el único efecto medido con
  certeza es qué datos entran al contexto.
