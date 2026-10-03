/**
 * Canvas — el estado visual de un enjambre corriendo.
 *
 * `canvas-manager.ts` guarda y sirve el snapshot; `emitter.ts` es por donde el
 * runtime publica los cambios (un nodo que empieza a pensar, una delegación que
 * arranca o termina). Quien construya una UI sobre el SDK consume ambos.
 */

export * from "./canvas-manager";
export * from "./emitter";
