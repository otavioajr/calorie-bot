import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadWhatsAppMedia, MediaTooLargeError } from '@/lib/whatsapp/media'

describe('downloadWhatsAppMedia', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-access-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('downloads media by ID via Graph API two-step flow', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: mediaUrl }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(100) })

    vi.stubGlobal('fetch', mockFetch)

    const result = await downloadWhatsAppMedia('media-123')

    expect(result).toBeInstanceOf(Buffer)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://graph.facebook.com/v21.0/media-123', {
      headers: { Authorization: 'Bearer test-access-token' },
    })
  })

  it('throws MediaTooLargeError when buffer exceeds maxSize', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=large'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: mediaUrl }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(1000) })

    vi.stubGlobal('fetch', mockFetch)

    await expect(downloadWhatsAppMedia('media-large', 500)).rejects.toThrow(MediaTooLargeError)
  })

  it('does not throw when no maxSize is provided', async () => {
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=big'
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: mediaUrl }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(10_000_000) })

    vi.stubGlobal('fetch', mockFetch)

    const result = await downloadWhatsAppMedia('media-big')
    expect(result).toBeInstanceOf(Buffer)
  })

  it('throws when WHATSAPP_ACCESS_TOKEN is not configured', async () => {
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', '')
    await expect(downloadWhatsAppMedia('media-no-token')).rejects.toThrow('WHATSAPP_ACCESS_TOKEN is not configured')
  })

  it('throws when metadata request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }))
    await expect(downloadWhatsAppMedia('media-fail')).rejects.toThrow('WhatsApp Media API error: 401')
  })

  it('throws when binary download fails', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://example.com/media' }) })
      .mockResolvedValueOnce({ ok: false, status: 403 })

    vi.stubGlobal('fetch', mockFetch)
    await expect(downloadWhatsAppMedia('media-dl-fail')).rejects.toThrow('WhatsApp media download error: 403')
  })
})
