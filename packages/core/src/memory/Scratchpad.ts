/**
 * Scratchpad — notas persistentes por conversación.
 *
 * Es una fachada sobre las funciones de `agent/conversation-store.ts`, que son
 * las que realmente usa el context compiler. Antes esta clase tenía su propia
 * implementación contra la colección `scratchpad` y, como usaba el mismo id
 * (`<threadId>:<key>`), escribía las mismas filas con un documento incompleto:
 * sin `source`, sin `createdAt` y sin `seq`. Una nota guardada por acá quedaba
 * sin el desempate por recencia que aplica `getScratchpad`, así que aparecía en
 * un orden arbitrario dentro del prompt.
 */

import {
  saveScratchpadNote,
  getScratchpad,
  deleteScratchpadNote,
} from "../agent/conversation-store";

export class Scratchpad {
  async write(threadId: string, key: string, value: string, source?: string): Promise<void> {
    await saveScratchpadNote(threadId, key, value, source);
  }

  async read(threadId: string, key: string): Promise<string | undefined> {
    const notes = await getScratchpad(threadId);
    return notes.find((n) => n.key === key)?.value;
  }

  /** Notas del thread, más recientes primero. */
  async list(threadId: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const note of await getScratchpad(threadId)) {
      result[note.key] = note.value;
    }
    return result;
  }

  async delete(threadId: string, key: string): Promise<void> {
    await deleteScratchpadNote(threadId, key);
  }

  async clear(threadId: string): Promise<void> {
    for (const note of await getScratchpad(threadId)) {
      await deleteScratchpadNote(threadId, note.key);
    }
  }
}
