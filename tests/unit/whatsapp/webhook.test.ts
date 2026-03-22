import { describe, it, expect } from 'vitest'
import {
  parseWebhookPayload,
  verifyWebhook,
} from '@/lib/whatsapp/webhook'
import type { WhatsAppMessage, WhatsAppStatus } from '@/lib/whatsapp/webhook'

// ---------------------------------------------------------------------------
// Helpers — fixture builders
// ---------------------------------------------------------------------------

function makeTextPayload(overrides?: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'BIZ_ACCOUNT_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550001234',
                phone_number_id: 'PHONE_NUMBER_ID',
              },
              contacts: [{ profile: { name: 'User' }, wa_id: '5511999887766' }],
              messages: [
                {
                  from: '5511999887766',
                  id: 'wamid.abc123',
                  timestamp: '1710000000',
                  type: 'text',
                  text: { body: 'almocei arroz e feijão' },
                },
              ],
              ...overrides,
            },
            field: 'messages',
          },
        ],
      },
    ],
  }
}

function makeImagePayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'BIZ_ACCOUNT_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550001234',
                phone_number_id: 'PHONE_NUMBER_ID',
              },
              contacts: [{ profile: { name: 'User' }, wa_id: '5511999887766' }],
              messages: [
                {
                  from: '5511999887766',
                  id: 'wamid.img456',
                  timestamp: '1710000001',
                  type: 'image',
                  image: { id: 'img_media_id', mime_type: 'image/jpeg' },
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

function makeStatusPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
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

// ---------------------------------------------------------------------------
// parseWebhookPayload
// ---------------------------------------------------------------------------

describe('parseWebhookPayload', () => {
  it('returns WhatsAppMessage with type "text" for a valid text message payload', () => {
    const result = parseWebhookPayload(makeTextPayload())

    expect(result).not.toBeNull()
    const msg = result as WhatsAppMessage
    expect(msg.type).toBe('text')
    expect(msg.from).toBe('5511999887766')
    expect(msg.messageId).toBe('wamid.abc123')
    expect(msg.text).toBe('almocei arroz e feijão')
    expect(msg.timestamp).toBe(1710000000)
  })

  it('returns WhatsAppStatus for a valid status update payload', () => {
    const result = parseWebhookPayload(makeStatusPayload())

    expect(result).not.toBeNull()
    const status = result as WhatsAppStatus
    expect(status.type).toBe('status')
    expect(status.status).toBe('delivered')
  })

  it('returns null for an empty object', () => {
    const result = parseWebhookPayload({})
    expect(result).toBeNull()
  })

  it('returns null when entry is missing', () => {
    const result = parseWebhookPayload({ object: 'whatsapp_business_account' })
    expect(result).toBeNull()
  })

  it('returns null for null body', () => {
    const result = parseWebhookPayload(null)
    expect(result).toBeNull()
  })

  it('returns null for undefined body', () => {
    const result = parseWebhookPayload(undefined)
    expect(result).toBeNull()
  })

  it('returns null for a non-object primitive', () => {
    const result = parseWebhookPayload(42)
    expect(result).toBeNull()
  })

  it('returns first message only when payload contains multiple messages', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'BIZ_ACCOUNT_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {},
                contacts: [{ profile: { name: 'User' }, wa_id: '5511999887766' }],
                messages: [
                  {
                    from: '5511999887766',
                    id: 'wamid.first',
                    timestamp: '1710000000',
                    type: 'text',
                    text: { body: 'first message' },
                  },
                  {
                    from: '5511999887766',
                    id: 'wamid.second',
                    timestamp: '1710000001',
                    type: 'text',
                    text: { body: 'second message' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    }

    const result = parseWebhookPayload(payload)
    expect(result).not.toBeNull()
    const msg = result as WhatsAppMessage
    expect(msg.messageId).toBe('wamid.first')
    expect(msg.text).toBe('first message')
  })

  it('returns WhatsAppMessage with type "image" for an image message', () => {
    const result = parseWebhookPayload(makeImagePayload())

    expect(result).not.toBeNull()
    const msg = result as WhatsAppMessage
    expect(msg.type).toBe('image')
    expect(msg.from).toBe('5511999887766')
    expect(msg.messageId).toBe('wamid.img456')
    expect(msg.text).toBeUndefined()
    expect(msg.timestamp).toBe(1710000001)
  })

  it('returns WhatsAppMessage with type "unknown" for an unrecognised message type', () => {
    const payload = makeTextPayload()
    // Replace the single message with an audio message type
    const messages = (
      (payload.entry[0].changes[0].value as Record<string, unknown>)
        .messages as Array<Record<string, unknown>>
    )
    messages[0].type = 'audio'
    messages[0].audio = { id: 'media_audio_123', mime_type: 'audio/ogg' }

    const result = parseWebhookPayload(payload)
    expect(result).not.toBeNull()
    const msg = result as WhatsAppMessage
    expect(msg.type).toBe('audio')
    expect(msg.audioId).toBe('media_audio_123')
  })

  it('returns null when messages array is empty', () => {
    const result = parseWebhookPayload(makeTextPayload({ messages: [] }))
    expect(result).toBeNull()
  })

  it('parses timestamp from string to number', () => {
    const result = parseWebhookPayload(makeTextPayload())
    expect(result).not.toBeNull()
    const msg = result as WhatsAppMessage
    expect(typeof msg.timestamp).toBe('number')
    expect(msg.timestamp).toBe(1710000000)
  })

  it('parses audio message correctly', () => {
    const result = parseWebhookPayload(makeAudioPayload())

    expect(result).not.toBeNull()
    const msg = result as WhatsAppMessage
    expect(msg.type).toBe('audio')
    expect(msg.from).toBe('5511999887766')
    expect(msg.messageId).toBe('wamid.audio789')
    expect(msg.audioId).toBe('media_audio_123')
    expect(msg.timestamp).toBe(1710000002)
  })

  it('audioId is undefined for non-audio message types', () => {
    const result = parseWebhookPayload(makeTextPayload())

    expect(result).not.toBeNull()
    const msg = result as WhatsAppMessage
    expect(msg.type).toBe('text')
    expect(msg.audioId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// verifyWebhook
// ---------------------------------------------------------------------------

describe('verifyWebhook', () => {
  it('returns the challenge string when mode is "subscribe" and token matches', () => {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'my-secret-token',
      'hub.challenge': 'challenge_abc123',
    })

    const result = verifyWebhook(params, 'my-secret-token')
    expect(result).toBe('challenge_abc123')
  })

  it('returns null when the verify token is wrong', () => {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge_abc123',
    })

    const result = verifyWebhook(params, 'my-secret-token')
    expect(result).toBeNull()
  })

  it('returns null when hub.mode is missing', () => {
    const params = new URLSearchParams({
      'hub.verify_token': 'my-secret-token',
      'hub.challenge': 'challenge_abc123',
    })

    const result = verifyWebhook(params, 'my-secret-token')
    expect(result).toBeNull()
  })

  it('returns null when hub.mode is not "subscribe"', () => {
    const params = new URLSearchParams({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'my-secret-token',
      'hub.challenge': 'challenge_abc123',
    })

    const result = verifyWebhook(params, 'my-secret-token')
    expect(result).toBeNull()
  })

  it('returns null when hub.challenge is missing', () => {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'my-secret-token',
    })

    const result = verifyWebhook(params, 'my-secret-token')
    expect(result).toBeNull()
  })

  it('returns null when hub.verify_token is missing', () => {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.challenge': 'challenge_abc123',
    })

    const result = verifyWebhook(params, 'my-secret-token')
    expect(result).toBeNull()
  })
})
