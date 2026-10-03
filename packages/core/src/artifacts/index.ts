/**
 * Artifacts — los archivos que produce un agente, fuera de la ventana de contexto.
 *
 * Cuando una tool devuelve algo grande —una imagen, un PDF, la salida enorme de
 * un servidor MCP— serializarlo entero al prompt es lo peor que se puede hacer:
 * se come el contexto y no aporta. En su lugar se guarda como artefacto y al
 * modelo le llega una referencia (`artifact_ref`) que puede abrir con la tool
 * `artifact_read` si de verdad necesita el contenido.
 *
 * `createArtifact` guarda; `inspectArtifact` da metadatos sin abrirlo;
 * `readArtifactText` lo lee para consumo del propio proceso; `readArtifactBytes`
 * devuelve los bytes crudos, que es lo que usa un canal para mandar la imagen.
 */

export * from "./store";
