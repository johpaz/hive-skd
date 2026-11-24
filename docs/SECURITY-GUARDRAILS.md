# Guardrails de seguridad y compatibilidad

Este documento enumera controles implementados y verificables. No sustituye la
actualización de dependencias ni convierte un límite cooperativo en aislamiento
de proceso.

## Dependencias y cadena de suministro

- `bun.lock` fija el grafo reproducible y CI instala con
  `bun install --frozen-lockfile`.
- `bun audit` es el control de aceptación para advisories conocidos. No existen
  exclusiones generales ni overrides usados sólo para silenciar el auditor.
- PDF.js está en 6.3.289 o posterior dentro de esa línea segura.
- SheetJS CE se instala desde la distribución oficial 0.20.3; el paquete npm
  abandonado en 0.18.5 no forma parte del grafo.
- Baileys está fijado exactamente en `7.0.0-rc14` para evitar retroceder a una
  release candidate vulnerable. Además se **carga bajo demanda**: entra en el
  proceso sólo si alguien conecta el canal `whatsapp` por código QR. Un
  consumidor que no lo use —hive-cloud, por ejemplo, que usa el canal oficial—
  no carga su grafo ni su parche de `process.stderr.write`.
- PptxGenJS 4.0.1 se conserva como artefacto ESM vendorizado, con licencia,
  procedencia y SHA-256. No se instala su dependencia muerta `image-size`.

Toda actualización del artefacto PPTX debe verificar su origen y hash, ejecutar
la prueba OOXML y volver a ejecutar el audit.

## Webhooks de WhatsApp (Cloud API)

El canal `whatsapp_cloud` recibe por una URL pública, así que todo lo que llega
es no confiable hasta comprobar dos cosas:

- **La firma.** `verifySignature` recalcula el HMAC-SHA256 del cuerpo **crudo**
  con el secreto de la app de Meta y lo compara con `X-Hub-Signature-256`
  usando `timingSafeEqual`. Sin cabecera, sin secreto o con una firma que no
  coincide, el webhook responde 401 y no se procesa nada. El cuerpo se lee como
  texto antes de parsearlo: firmar el JSON reserializado daría distinto.
- **El token de verificación.** El `hub.verify_token` del alta se compara
  también con `timingSafeEqual`; si no coincide, 403.

El canal además sólo atiende eventos de su propio `phone_number_id` —una misma
cuenta de WhatsApp Business puede tener varios números apuntando a la misma
URL— y descarta por id los reintentos de Meta.

## Archivos PDF

Antes de leer un PDF, `office_leer_pdf` exige un archivo regular y limita el
tamaño a **25 MiB**. El parser se configura con:

```typescript
enableScripting: false
isEvalSupported: false
```

Cada solicitud puede extraer como máximo **200 páginas**. Los rangos deben usar
enteros válidos y el lector comprueba un deadline de **30 segundos** entre
páginas. `loadingTask.destroy()` se ejecuta siempre al terminar.

El deadline es cooperativo: no puede interrumpir una operación interna de
PDF.js que bloquee antes de devolver el control. El límite de bytes, el límite
de páginas y la versión corregida de la dependencia son los controles primarios.

## Archivos XLSX

`office_leer_xlsx` exige un archivo regular y rechaza entradas mayores a
**15 MiB** antes de cargarlas. El workbook acepta como máximo **50 hojas** y se
leen como máximo **10.000 filas por hoja**; `sheetRows` limita además el trabajo
del parser. Hay un deadline cooperativo de **30 segundos** comprobado entre
hojas.

SheetJS se carga bajo demanda. Si la distribución oficial no está instalada, la
herramienta devuelve un error operativo explícito en vez de propagar un
`Cannot find module` ambiguo.

## Escritura PPTX

`office_escribir_pptx` expone sólo portada, texto, viñetas y notas. No acepta
rutas, buffers ni datos de imágenes. El artefacto vendorizado importa `jszip`,
pero no `image-size`; su hash y procedimiento de actualización están en
`packages/core/src/vendor/pptxgenjs/README.md`.

Agregar `addImage`, fondos con imágenes o cualquier entrada binaria invalida
este guardrail y requiere una revisión de seguridad antes de publicarse.

## Runtime, tipos y transportes

- Bun **>=1.4.4** está declarado en `engines`; CI usa exactamente 1.4.4.
- TypeScript **7.0.2** está fijado para hacer reproducible el typecheck.
- SSE acepta sólo el contrato de stream que consume (`read`) y no depende de la
  extensión Bun `readMany`.
- WebSocket delimita `Bun.WebSocketOptions` sin desactivar el chequeo de tipos;
  conserva reintentos limitados y distingue cierres intencionales.
- Audio usa `Uint8Array<ArrayBuffer>` antes de construir `Blob`, evitando
  compartir memoria respaldada por `SharedArrayBuffer` con la petición.

## Verificación antes de publicar

```bash
bun --version
bun install --frozen-lockfile
bun run typecheck
bun test
bun audit
git diff --check
```

El resultado aceptable es Bun 1.4.4 o posterior, typecheck y pruebas sin fallos,
audit sin vulnerabilidades y un diff sin errores de whitespace.
