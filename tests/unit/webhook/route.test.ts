import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock dependencies before importing the route
// ---------------------------------------------------------------------------

const mockInsert = vi.fn()
const mockSelect = vi.fn()
const mockSingle = vi.fn()

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      insert: mockInsert.mockReturnValue({
        select: mockSelect.mockReturnValue({
          single: mockSingle,
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/whatsapp/webhook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/webhook')>()
  return actual
})

const { mockHandleIncomingMessage, mockHandleIncomingAudio, mockHandleIncomingImage } = vi.hoisted(() => ({
  mockHandleIncomingMessage: vi.fn().mockResolvedValue(undefined),
  mockHandleIncomingAudio: vi.fn().mockResolvedValue(undefined),
  mockHandleIncomingImage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bot/handler', () => ({
  handleIncomingMessage: mockHandleIncomingMessage,
  handleIncomingAudio: mockHandleIncomingAudio,
  handleIncomingImage: mockHandleIncomingImage,
}))


// Import after mocks are set up
import { GET, POST } from '@/app/api/webhook/whatsapp/route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerifyRequest(params: Record<string, string>): Request {
  const url = new URL('http://localhost/api/webhook/whatsapp')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return new Request(url.toString())
}

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/api/webhook/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeTextPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'BIZ_ACCOUNT_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from: '5511999887766',
                  id: 'wamid.abc123',
                  timestamp: '1710000000',
                  type: 'text',
                  text: { body: 'almocei arroz e feijão' },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  }
}

function makeAudioPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'BIZ_ACCOUNT_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          messages: [{
            from: '5511999887766',
            id: 'wamid.audio789',
            timestamp: '1710000002',
            type: 'audio',
            audio: { id: 'media_audio_123', mime_type: 'audio/ogg' },
          }],
        },
        field: 'messages',
      }],
    }],
  }
}

function makeImagePayload(caption?: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'BIZ_ACCOUNT_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          messages: [{
            from: '5511999887766',
            id: 'wamid.image456',
            timestamp: '1710000003',
            type: 'image',
            image: { id: 'media_image_456', mime_type: 'image/jpeg', caption },
          }],
        },
        field: 'messages',
      }],
    }],
  }
}

function makeStatusPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'BIZ_ACCOUNT_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              statuses: [
                {
                  id: 'wamid.abc123',
                  status: 'delivered',
                  timestamp: '1710000000',
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Route exports
// ---------------------------------------------------------------------------

describe('webhook route — exports', () => {
  it('exports a GET function', () => {
    expect(typeof GET).toBe('function')
  })

  it('exports a POST function', () => {
    expect(typeof POST).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// GET — webhook verification
// ---------------------------------------------------------------------------

describe('GET /api/webhook/whatsapp', () => {
  beforeEach(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token'
  })

  it('returns 200 with challenge when verification params are valid', async () => {
    const request = makeVerifyRequest({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'challenge_abc123',
    })

    const response = await GET(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('challenge_abc123')
  })

  it('returns 403 when verify token is wrong', async () => {
    const request = makeVerifyRequest({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge_abc123',
    })

    const response = await GET(request)

    expect(response.status).toBe(403)
    const text = await response.text()
    expect(text).toBe('Forbidden')
  })

  it('returns 403 when hub.mode is missing', async () => {
    const request = makeVerifyRequest({
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'challenge_abc123',
    })

    const response = await GET(request)
    expect(response.status).toBe(403)
  })

  it('returns 403 when hub.challenge is missing', async () => {
    const request = makeVerifyRequest({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
    })

    const response = await GET(request)
    expect(response.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST — incoming messages
// ---------------------------------------------------------------------------

describe('POST /api/webhook/whatsapp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('always returns 200 — never non-200 to Meta', async () => {
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.abc123' }, error: null })

    const request = makePostRequest(makeTextPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
  })

  it('returns 200 for a valid text message and deduplicates via insert', async () => {
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.abc123' }, error: null })

    const request = makePostRequest(makeTextPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
    expect(mockInsert).toHaveBeenCalledWith({ message_id: 'wamid.abc123' })
  })

  it('returns 200 for a duplicate message (insert error = already processed)', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })

    const request = makePostRequest(makeTextPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
  })

  it('returns 200 for a status update event (no deduplication needed)', async () => {
    const request = makePostRequest(makeStatusPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
    // No insert for status events
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns 200 for an empty / unparseable body', async () => {
    const request = makePostRequest({})
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
  })

  it('returns 200 even when an unexpected error is thrown', async () => {
    mockSingle.mockRejectedValue(new Error('unexpected network error'))

    const request = makePostRequest(makeTextPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
  })

  it('processes message when insert fails with non-duplicate error (e.g. connection error)', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'connection refused' },
    })

    const request = makePostRequest(makeTextPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    // Message should still be processed despite dedup insert failure
    expect(mockHandleIncomingMessage).toHaveBeenCalledWith(
      '5511999887766',
      'wamid.abc123',
      'almocei arroz e feijão',
    )
  })

  it('logs error when dedup insert fails with non-duplicate error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'connection refused' },
    })

    const request = makePostRequest(makeTextPayload())
    await POST(request)

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[webhook] Dedup insert failed'),
      expect.stringContaining('connection refused'),
    )
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// POST — audio messages
// ---------------------------------------------------------------------------

describe('POST — audio messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 200 for audio message and calls handleIncomingAudio with correct args', async () => {
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.audio789' }, error: null })

    const request = makePostRequest(makeAudioPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
    expect(mockHandleIncomingAudio).toHaveBeenCalledWith(
      '5511999887766',
      'wamid.audio789',
      'media_audio_123',
    )
  })

  it('returns 200 even when handleIncomingAudio throws', async () => {
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.audio789' }, error: null })
    mockHandleIncomingAudio.mockRejectedValueOnce(new Error('audio processing failed'))

    const request = makePostRequest(makeAudioPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
  })

  it('deduplication works for audio: when insert returns error, handler is NOT called', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })

    const request = makePostRequest(makeAudioPayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(mockHandleIncomingAudio).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST — image messages
// ---------------------------------------------------------------------------

describe('POST — image messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 200 for image message and calls handleIncomingImage with correct args', async () => {
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.image456' }, error: null })

    const request = makePostRequest(makeImagePayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
    expect(mockHandleIncomingImage).toHaveBeenCalledWith(
      '5511999887766',
      'wamid.image456',
      'media_image_456',
      undefined,
    )
  })

  it('passes caption to handleIncomingImage when present', async () => {
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.image456' }, error: null })

    const request = makePostRequest(makeImagePayload('tabela nutricional'))
    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(mockHandleIncomingImage).toHaveBeenCalledWith(
      '5511999887766',
      'wamid.image456',
      'media_image_456',
      'tabela nutricional',
    )
  })

  it('returns 200 even when handleIncomingImage throws', async () => {
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.image456' }, error: null })
    mockHandleIncomingImage.mockRejectedValueOnce(new Error('image processing failed'))

    const request = makePostRequest(makeImagePayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('OK')
  })

  it('deduplication works for image: when insert returns error, handler is NOT called', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })

    const request = makePostRequest(makeImagePayload())
    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(mockHandleIncomingImage).not.toHaveBeenCalled()
  })
})
