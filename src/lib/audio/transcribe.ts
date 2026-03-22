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

export async function downloadWhatsAppMedia(mediaId: string): Promise<Buffer> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN
  if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')
  // Step 1: GET media metadata → { url }
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!metaRes.ok) throw new Error(`WhatsApp Media API error: ${metaRes.status}`)
  const { url } = (await metaRes.json()) as { url: string }

  // Step 2: GET binary from URL
  const binaryRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!binaryRes.ok) throw new Error(`WhatsApp media download error: ${binaryRes.status}`)

  const arrayBuffer = await binaryRes.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  if (buffer.length > MAX_AUDIO_SIZE) throw new AudioTooLargeError()

  return buffer
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')

  const startTime = Date.now()

  const formData = new FormData()
  formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/ogg' }), 'audio.ogg')
  formData.append('model', 'whisper-1')
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
