/**
 * Events — el bus de eventos del runtime y la narración de lo que hace un agente.
 *
 * Dos buses con propósitos distintos:
 *  - `eventBus`: eventos del proceso, tipados (`event-bus.ts`).
 *  - `agentBus`: mensajería entre workers de un enjambre, con respaldo
 *    persistente en HiveDB para que un worker lea lo que le dejaron mientras
 *    no estaba (`agent-bus.ts`).
 *
 * La narración traduce una tool call a una frase que se le puede mostrar a
 * alguien ("Buscando en la web...") en vez del nombre crudo de la tool.
 */

export * from "./event-bus";
export * from "./agent-bus";
export * from "./narration";
export * from "./tool-narration";
export * from "./channel-narration";
