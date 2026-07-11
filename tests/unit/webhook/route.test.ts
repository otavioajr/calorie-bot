import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signWebhookBody } from '@/lib/whatsapp/webhook'

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

const {
  mockHandleIncomingMessage,
  mockHandleIncomingAudio,
  mockHandleIncomingImage,
  mockHandleUnsupportedMessage,
} = vi.hoisted(() => ({
  mockHandleIncomingMessage: vi.fn().mockResolvedValue(undefined),
  mockHandleIncomingAudio: vi.fn().mockResolvedValue(undefined),
  mockHandleIncomingImage: vi.fn().mockResolvedValue(undefined),
  mockHandleUnsupportedMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bot/handler', () => ({
  handleIncomingMessage: mockHandleIncomingMessage,
  handleIncomingAudio: mockHandleIncomingAudio,
  handleIncomingImage: mockHandleIncomingImage,
  handleUnsupportedMessage: mockHandleUnsupportedMessage,
}))

import { GET, POST } from '@/app/api/webhook/whatsapp/route'

const TEST_APP_SECRET = 'test-meta-app-secret'

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

function makeSignedPostRequest(body: unknown, options?: { signature?: string | null }): Request {
  const rawBody = JSON.stringify(body)
  const signature =
    options && 'signature' in options
      ? options.signature
      : signWebhookBody(rawBody, TEST_APP_SECRET)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (signature) {
    headers['x-hub-signature-256'] = signature
  }

  return new Request('http://localhost/api/webhook/whatsapp', {
    method: 'POST',
    headers,
    body: rawBody,
  })
}

function makeTextPayload(phoneNumberId = 'PHONE_NUMBER_ID') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'BIZ_ACCOUNT_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
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
          metadata: { phone_number_id: 'PHONE_NUMBER_ID' },
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
          metadata: { phone_number_id: 'PHONE_NUMBER_ID' },
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

function makeVideoPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'PHONE_NUMBER_ID' },
          messages: [{
            from: '5511999887766',
            id: 'wamid.video1',
            timestamp: '1710000004',
            type: 'video',
          }],
        },
        field: 'messages',
      }],
    }],
  }
}

function makeMultiMessagePayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'PHONE_NUMBER_ID' },
          messages: [
            {
              from: '5511999887766',
              id: 'wamid.first',
              timestamp: '1710000000',
              type: 'text',
              text: { body: 'first' },
            },
            {
              from: '5511999887766',
              id: 'wamid.second',
              timestamp: '1710000001',
              type: 'text',
              text: { body: 'second' },
            },
          ],
        },
        field: 'messages',
      }],
    }],
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
})

// ---------------------------------------------------------------------------
// POST — signature & perimeter
// ---------------------------------------------------------------------------

describe('POST /api/webhook/whatsapp — signature', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.META_APP_SECRET = TEST_APP_SECRET
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PHONE_NUMBER_ID'
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.abc123' }, error: null })
  })

  it('returns 401 when signature is missing', async () => {
    const request = makeSignedPostRequest(makeTextPayload(), { signature: null })
    const response = await POST(request)

    expect(response.status).toBe(401)
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
  })

  it('returns 401 when signature is invalid', async () => {
    const request = makeSignedPostRequest(makeTextPayload(), { signature: 'sha256=bad' })
    const response = await POST(request)

    expect(response.status).toBe(401)
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
  })

  it('returns 401 when META_APP_SECRET is missing', async () => {
    delete process.env.META_APP_SECRET
    const rawBody = JSON.stringify(makeTextPayload())
    const request = new Request('http://localhost/api/webhook/whatsapp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': signWebhookBody(rawBody, TEST_APP_SECRET),
      },
      body: rawBody,
    })

    const response = await POST(request)
    expect(response.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// POST — incoming messages
// ---------------------------------------------------------------------------

describe('POST /api/webhook/whatsapp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.META_APP_SECRET = TEST_APP_SECRET
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PHONE_NUMBER_ID'
  })

  it('returns 200 for a valid signed text message and deduplicates via insert', async () => {
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.abc123' }, error: null })

    const response = await POST(makeSignedPostRequest(makeTextPayload()))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')
    expect(mockInsert).toHaveBeenCalledWith({ message_id: 'wamid.abc123' })
    expect(mockHandleIncomingMessage).toHaveBeenCalledWith(
      '5511999887766',
      'wamid.abc123',
      'almocei arroz e feijão',
      undefined,
    )
  })

  it('processes all messages in a batch', async () => {
    mockSingle.mockResolvedValue({ data: {}, error: null })

    await POST(makeSignedPostRequest(makeMultiMessagePayload()))

    expect(mockHandleIncomingMessage).toHaveBeenCalledTimes(2)
    expect(mockInsert).toHaveBeenCalledTimes(2)
  })

  it('ignores events with unexpected phone_number_id', async () => {
    mockSingle.mockResolvedValue({ data: {}, error: null })

    await POST(makeSignedPostRequest(makeTextPayload('WRONG_PHONE_ID')))

    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns 200 for a duplicate message (insert error = already processed)', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })

    const response = await POST(makeSignedPostRequest(makeTextPayload()))

    expect(response.status).toBe(200)
    expect(mockHandleIncomingMessage).not.toHaveBeenCalled()
  })

  it('returns 200 for an empty / unparseable body (no messages)', async () => {
    const response = await POST(makeSignedPostRequest({}))

    expect(response.status).toBe(200)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('continues processing other messages when one handler throws', async () => {
    mockSingle.mockResolvedValue({ data: {}, error: null })
    mockHandleIncomingMessage
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce(undefined)

    const response = await POST(makeSignedPostRequest(makeMultiMessagePayload()))

    expect(response.status).toBe(200)
    expect(mockHandleIncomingMessage).toHaveBeenCalledTimes(2)
  })

  it('processes message when insert fails with non-duplicate error', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'connection refused' },
    })

    await POST(makeSignedPostRequest(makeTextPayload()))

    expect(mockHandleIncomingMessage).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST — audio / image / unsupported
// ---------------------------------------------------------------------------

describe('POST — audio messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.META_APP_SECRET = TEST_APP_SECRET
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PHONE_NUMBER_ID'
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.audio789' }, error: null })
  })

  it('calls handleIncomingAudio with correct args', async () => {
    await POST(makeSignedPostRequest(makeAudioPayload()))

    expect(mockHandleIncomingAudio).toHaveBeenCalledWith(
      '5511999887766',
      'wamid.audio789',
      'media_audio_123',
      undefined,
    )
  })
})

describe('POST — image messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.META_APP_SECRET = TEST_APP_SECRET
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PHONE_NUMBER_ID'
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.image456' }, error: null })
  })

  it('passes caption to handleIncomingImage when present', async () => {
    await POST(makeSignedPostRequest(makeImagePayload('tabela nutricional')))

    expect(mockHandleIncomingImage).toHaveBeenCalledWith(
      '5511999887766',
      'wamid.image456',
      'media_image_456',
      'tabela nutricional',
      undefined,
    )
  })
})

describe('POST — unsupported messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.META_APP_SECRET = TEST_APP_SECRET
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'PHONE_NUMBER_ID'
    mockSingle.mockResolvedValue({ data: { message_id: 'wamid.video1' }, error: null })
  })

  it('calls handleUnsupportedMessage for video', async () => {
    await POST(makeSignedPostRequest(makeVideoPayload()))

    expect(mockHandleUnsupportedMessage).toHaveBeenCalledWith('5511999887766', 'video')
  })
})
