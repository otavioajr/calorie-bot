import { describe, it, expect, vi, beforeEach } from 'vitest'
import { downloadWhatsAppMedia, AudioTooLargeError } from '@/lib/audio/transcribe'

describe('downloadWhatsAppMedia', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-access-token'
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

    await downloadWhatsAppMedia(mediaId)

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

    const result = await downloadWhatsAppMedia('media-id-456')

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

    await expect(downloadWhatsAppMedia('media-id-large')).rejects.toThrow(AudioTooLargeError)
    await expect(downloadWhatsAppMedia('media-id-large')).rejects.toThrow('Audio exceeds 30 second limit')
  })

  it('throws when the media metadata request fails (non-ok response)', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
      })

    vi.stubGlobal('fetch', mockFetch)

    await expect(downloadWhatsAppMedia('media-id-fail')).rejects.toThrow(
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

    await expect(downloadWhatsAppMedia('media-id-binary-fail')).rejects.toThrow(
      'WhatsApp media download error: 403'
    )
  })
})
