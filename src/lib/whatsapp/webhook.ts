import { createHmac, timingSafeEqual } from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WhatsAppMessageType = 'text' | 'image' | 'audio' | 'unsupported'

export interface WhatsAppMessage {
  type: WhatsAppMessageType
  /** Original Meta message type when type is 'unsupported'. */
  rawType?: string
  from: string
  messageId: string
  text?: string
  audioId?: string
  imageId?: string
  caption?: string
  timestamp: number
  quotedMessageId?: string
  phoneNumberId?: string
}

/** @deprecated Status events are not returned by parseWebhookEvents (Fase 2). */
export interface WhatsAppStatus {
  type: 'status'
  status: string
}

/** @deprecated Use parseWebhookEvents instead. */
export type WebhookEvent = WhatsAppMessage | WhatsAppStatus | null

const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'image', 'audio'])

// ---------------------------------------------------------------------------
// Internal raw payload types — avoids `any`, uses `unknown` + narrowing
// ---------------------------------------------------------------------------

interface RawMessage {
  from?: unknown
  id?: unknown
  timestamp?: unknown
  type?: unknown
  text?: { body?: unknown }
  audio?: { id?: unknown; mime_type?: unknown }
  image?: { id?: unknown; caption?: unknown; mime_type?: unknown }
  context?: { id?: unknown }
}

interface RawChangeValue {
  messaging_product?: unknown
  metadata?: unknown
  messages?: unknown
  statuses?: unknown
}

interface RawChange {
  value?: unknown
  field?: unknown
}

interface RawEntry {
  id?: unknown
  changes?: unknown
}

interface RawPayload {
  object?: unknown
  entry?: unknown
}

interface RawMetadata {
  phone_number_id?: unknown
}

// ---------------------------------------------------------------------------
// Type guards / safe accessors
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRawPayload(body: unknown): RawPayload | null {
  if (!isObject(body)) return null
  return body as RawPayload
}

function asRawEntry(value: unknown): RawEntry | null {
  if (!isObject(value)) return null
  return value as RawEntry
}

function asRawChange(value: unknown): RawChange | null {
  if (!isObject(value)) return null
  return value as RawChange
}

function asRawChangeValue(value: unknown): RawChangeValue | null {
  if (!isObject(value)) return null
  return value as RawChangeValue
}

function asRawMessage(value: unknown): RawMessage | null {
  if (!isObject(value)) return null
  return value as RawMessage
}

function asRawMetadata(value: unknown): RawMetadata | null {
  if (!isObject(value)) return null
  return value as RawMetadata
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature (WEB-01)
// ---------------------------------------------------------------------------

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  const secret = appSecret?.trim()
  if (!secret || !signatureHeader) return false

  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))
  } catch {
    return false
  }
}

/** Signs a raw body for tests and local development. */
export function signWebhookBody(rawBody: string, appSecret: string): string {
  const hash = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  return `sha256=${hash}`
}

// ---------------------------------------------------------------------------
// parseWebhookEvents (WEB-02)
// ---------------------------------------------------------------------------

function parseRawMessage(rawMsg: RawMessage, phoneNumberId?: string): WhatsAppMessage | null {
  const from = asString(rawMsg.from)
  const messageId = asString(rawMsg.id)
  const timestampStr = asString(rawMsg.timestamp)
  const msgType = asString(rawMsg.type)

  if (!from || !messageId || !timestampStr || !msgType) return null

  const timestamp = parseInt(timestampStr, 10)
  if (isNaN(timestamp)) return null

  const quotedMessageId = isObject(rawMsg.context)
    ? asString((rawMsg.context as { id?: unknown }).id)
    : undefined

  const base = { from, messageId, timestamp, quotedMessageId, phoneNumberId }

  if (msgType === 'text') {
    const textBody =
      isObject(rawMsg.text) ? asString((rawMsg.text as { body?: unknown }).body) : undefined

    return {
      ...base,
      type: 'text',
      text: textBody,
    }
  }

  if (msgType === 'image') {
    const imageId = isObject(rawMsg.image) ? asString((rawMsg.image as { id?: unknown }).id) : undefined
    const caption = isObject(rawMsg.image) ? asString((rawMsg.image as { caption?: unknown }).caption) : undefined

    return {
      ...base,
      type: 'image',
      imageId,
      caption,
    }
  }

  if (msgType === 'audio') {
    const audioId = isObject(rawMsg.audio) ? asString((rawMsg.audio as { id?: unknown }).id) : undefined

    return {
      ...base,
      type: 'audio',
      audioId,
    }
  }

  if (!SUPPORTED_MESSAGE_TYPES.has(msgType)) {
    return {
      ...base,
      type: 'unsupported',
      rawType: msgType,
    }
  }

  return null
}

export function parseWebhookEvents(body: unknown): WhatsAppMessage[] {
  const events: WhatsAppMessage[] = []

  try {
    const payload = asRawPayload(body)
    if (!payload || !isNonEmptyArray(payload.entry)) return events

    for (const entryValue of payload.entry) {
      const entry = asRawEntry(entryValue)
      if (!entry || !isNonEmptyArray(entry.changes)) continue

      for (const changeValue of entry.changes) {
        const change = asRawChange(changeValue)
        if (!change) continue

        const value = asRawChangeValue(change.value)
        if (!value || !isNonEmptyArray(value.messages)) continue

        const metadata = asRawMetadata(value.metadata)
        const phoneNumberId = metadata ? asString(metadata.phone_number_id) : undefined

        for (const messageValue of value.messages) {
          const rawMsg = asRawMessage(messageValue)
          if (!rawMsg) continue

          const parsed = parseRawMessage(rawMsg, phoneNumberId)
          if (parsed) events.push(parsed)
        }
      }
    }
  } catch {
    return events
  }

  return events
}

/**
 * @deprecated Use parseWebhookEvents. Returns the first message only.
 */
export function parseWebhookPayload(body: unknown): WebhookEvent {
  const events = parseWebhookEvents(body)
  if (events.length > 0) return events[0]

  // Legacy: status-only payloads (no messages)
  try {
    const payload = asRawPayload(body)
    if (!payload || !isNonEmptyArray(payload.entry)) return null

    const entry = asRawEntry(payload.entry[0])
    if (!entry || !isNonEmptyArray(entry.changes)) return null

    const change = asRawChange(entry.changes[0])
    if (!change) return null

    const value = asRawChangeValue(change.value)
    if (!value || !isNonEmptyArray(value.statuses)) return null

    const rawStatus = value.statuses[0]
    if (!isObject(rawStatus)) return null

    const status = asString(rawStatus.status)
    if (!status) return null

    return { type: 'status', status }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// verifyWebhook
// ---------------------------------------------------------------------------

export function verifyWebhook(params: URLSearchParams, verifyToken: string): string | null {
  const mode = params.get('hub.mode')
  const token = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')

  if (mode !== 'subscribe') return null
  if (token !== verifyToken) return null
  if (!challenge) return null

  return challenge
}
