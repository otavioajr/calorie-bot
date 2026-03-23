import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadAudioMedia, AudioTooLargeError, transcribeAudio } from '@/lib/audio/transcribe'

describe('downloadAudioMedia', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-access-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls GET /v21.0/{mediaId} with WHATSAPP_ACCESS_TOKEN, then fetches the returned URL', async () => {
    const mediaId = 'media-id-123'
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc'
    const audioArrayBuffer = new ArrayBuffer(100)

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: mediaUrl }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => audioArrayBuffer,
      })

    vi.stubGlobal('fetch', mockFetch)

    await downloadAudioMedia(mediaId)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: 'Bearer test-access-token' } }
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      mediaUrl,
      { headers: { Authorization: 'Bearer test-access-token' } }
    )
  })

  it('returns a Buffer of the audio binary', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc'
    const audioBytes = new Uint8Array([102, 97, 107, 101, 45, 97, 117, 100, 105, 111]) // 'fake-audio'
    const arrayBuffer = audioBytes.buffer

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: mediaUrl }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => arrayBuffer,
      })

    vi.stubGlobal('fetch', mockFetch)

    const result = await downloadAudioMedia('media-id-456')

    expect(result).toBeInstanceOf(Buffer)
    expect(result).toEqual(Buffer.from(audioBytes))
  })

  it('throws AudioTooLargeError when response body exceeds 480_000 bytes', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=large'
    const largeArrayBuffer = new ArrayBuffer(480_001)

    const mockFetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ url: mediaUrl }),
        arrayBuffer: async () => largeArrayBuffer,
      })

    vi.stubGlobal('fetch', mockFetch)

    await expect(downloadAudioMedia('media-id-large')).rejects.toThrow(AudioTooLargeError)
    await expect(downloadAudioMedia('media-id-large')).rejects.toThrow('Audio exceeds 30 second limit')
  })

  it('throws when the media metadata request fails (non-ok response)', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
      })

    vi.stubGlobal('fetch', mockFetch)

    await expect(downloadAudioMedia('media-id-fail')).rejects.toThrow(
      'WhatsApp Media API error: 401'
    )
  })

  it('throws when the binary download request fails (non-ok response)', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=fail'

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: mediaUrl }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
      })

    vi.stubGlobal('fetch', mockFetch)

    await expect(downloadAudioMedia('media-id-binary-fail')).rejects.toThrow(
      'WhatsApp media download error: 403'
    )
  })

  it('throws when WHATSAPP_ACCESS_TOKEN is not configured', async () => {
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', '')

    await expect(downloadAudioMedia('media-id-no-token')).rejects.toThrow(
      'WHATSAPP_ACCESS_TOKEN is not configured'
    )
  })
})

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('OPENAI_API_KEY', 'test-api-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends POST to api.openai.com/v1/audio/transcriptions with correct headers and form data', async () => {
    const audioBuffer = Buffer.from('fake-audio-data')

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'almocei arroz e feijão' }),
    })

    vi.stubGlobal('fetch', mockFetch)

    await transcribeAudio(audioBuffer)

    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(options.method).toBe('POST')
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer test-api-key')

    const body = options.body as FormData
    expect(body.get('model')).toBe('whisper-1')
    expect(body.get('language')).toBe('pt')
    expect(body.get('file')).toBeInstanceOf(Blob)
  })

  it('returns a TranscriptionResult with text and latencyMs', async () => {
    const audioBuffer = Buffer.from('fake-audio-data')

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'almocei arroz e feijão' }),
    })

    vi.stubGlobal('fetch', mockFetch)

    const result = await transcribeAudio(audioBuffer)

    expect(result.text).toBe('almocei arroz e feijão')
    expect(typeof result.latencyMs).toBe('number')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('throws when OPENAI_API_KEY is not set', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')

    const audioBuffer = Buffer.from('fake-audio-data')

    await expect(transcribeAudio(audioBuffer)).rejects.toThrow(
      'OPENAI_API_KEY is not configured'
    )
  })

  it('throws when Whisper API returns non-ok response', async () => {
    const audioBuffer = Buffer.from('fake-audio-data')

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
    })

    vi.stubGlobal('fetch', mockFetch)

    await expect(transcribeAudio(audioBuffer)).rejects.toThrow(
      'Whisper API error: 429'
    )
  })

  it('returns empty string when Whisper returns empty text', async () => {
    const audioBuffer = Buffer.from('fake-audio-data')

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '' }),
    })

    vi.stubGlobal('fetch', mockFetch)

    const result = await transcribeAudio(audioBuffer)

    expect(result.text).toBe('')
  })
})
