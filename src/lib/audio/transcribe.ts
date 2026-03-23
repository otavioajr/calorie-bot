import { downloadWhatsAppMedia, MediaTooLargeError } from '@/lib/whatsapp/media'

const MAX_AUDIO_SIZE = 480_000 // ~30s OGG/Opus

export interface TranscriptionResult {
  text: string
  latencyMs: number
}

export class AudioTooLargeError extends Error {
  constructor() {
    super('Audio exceeds 30 second limit')
    this.name = 'AudioTooLargeError'
  }
}

export async function downloadAudioMedia(mediaId: string): Promise<Buffer> {
  try {
    return await downloadWhatsAppMedia(mediaId, MAX_AUDIO_SIZE)
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      throw new AudioTooLargeError()
    }
    throw err
  }
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')

  const startTime = Date.now()

  const formData = new FormData()
  formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/ogg' }), 'audio.ogg')
  formData.append('model', 'gpt-4o-mini-transcribe')
  formData.append('language', 'pt')

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  })

  const latencyMs = Date.now() - startTime

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Whisper API error: ${response.status} — ${errorBody}`)
  }

  const data = (await response.json()) as { text: string }
  return { text: data.text ?? '', latencyMs }
}
