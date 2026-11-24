/**
 * Sintetizador de voz local (Kitten TTS) inyectable.
 *
 * El runtime de Kitten (un worker Python empaquetado por plataforma) vive en el
 * gateway de Hive, no en este SDK. Quien lo tenga lo registra aquí al arrancar
 * y `VoiceService` lo usa para los modelos locales; sin registro, pedir voz
 * local falla con un mensaje claro en vez de buscar un servidor que no existe.
 */
export type LocalTTSSynthesizer = (text: string, voice?: string) => Promise<Response>

let synthesizer: LocalTTSSynthesizer | undefined

export function registerLocalTTS(fn: LocalTTSSynthesizer | undefined): void {
  synthesizer = fn
}

export function hasLocalTTS(): boolean {
  return !!synthesizer
}

export async function synthesizeLocalTTS(text: string, voice?: string): Promise<Response> {
  if (!synthesizer) {
    throw new Error("La voz local (Kitten) no está disponible en este entorno: registra un sintetizador con registerLocalTTS().")
  }
  return synthesizer(text, voice)
}
