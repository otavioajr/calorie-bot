import { createHmac, timingSafeEqual } from 'crypto'
import type { MetaCallbackStatus } from '@/lib/outbox/types'

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
  businessAccountId?: string
}

export interface WhatsAppStatusError {
  code?: number
  subcode?: number
  title?: string
  message?: string
  details?: string
}

export interface WhatsAppStatusEvent {
  type: 'status'
  providerMessageId: string
  status: MetaCallbackStatus
  rawStatus: string
  timestamp: number
  recipientId?: string
  phoneNumberId?: string
  businessAccountId?: string
  opaqueCallbackData?: string
  errors: WhatsAppStatusError[]
  payload: Record<string, unknown>
}

/** @deprecated Use WhatsAppStatusEvent from parseWhatsAppWebhookEvents. */
export interface WhatsAppStatus {
  type: 'status'
  status: string
}

export type WhatsAppWebhookEvent = WhatsAppMessage | WhatsAppStatusEvent

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

interface RawStatus {
  id?: unknown
  status?: unknown
  timestamp?: unknown
  recipient_id?: unknown
  biz_opaque_callback_data?: unknown
  errors?: unknown
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

function asRawStatus(value: unknown): RawStatus | null {
  if (!isObject(value)) return null
  return value as RawStatus
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature (WEB-01)
// ---------------------------------------------------------------------------

export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  const secret = appSecret?.trim()
  if (!secret || !signatureHeader) return false

  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader

  const hmac = createHmac('sha256', secret)
  const expected = (typeof rawBody === 'string'
    ? hmac.update(rawBody, 'utf8')
    : hmac.update(rawBody)
  ).digest('hex')

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

function parseRawMessage(
  rawMsg: RawMessage,
  phoneNumberId?: string,
  businessAccountId?: string,
): WhatsAppMessage | null {
  const from = asString(rawMsg.from)
  const messageId = asString(rawMsg.id)
  const timestampStr = asString(rawMsg.timestamp)
  const msgType = asString(rawMsg.type)

  if (!from || !messageId || !timestampStr || !msgType) return null

  const timestamp = asInteger(timestampStr)
  if (timestamp === undefined || !isValidEpochSeconds(timestamp)) return null

  const quotedMessageId = isObject(rawMsg.context)
    ? asString((rawMsg.context as { id?: unknown }).id)
    : undefined

  const base = {
    from,
    messageId,
    timestamp,
    quotedMessageId,
    phoneNumberId,
    businessAccountId,
  }

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

function asInteger(value: unknown): number | undefined {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) return value
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function isValidEpochSeconds(value: number): boolean {
  return Number.isFinite(new Date(value * 1000).getTime())
}

function parseStatusErrors(value: unknown): WhatsAppStatusError[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isObject(candidate)) return []
    const code = asInteger(candidate.code)
    const subcode = asInteger(candidate.error_subcode)
    const title = asString(candidate.title)
    const message = asString(candidate.message)
    const errorData = isObject(candidate.error_data)
      ? candidate.error_data
      : null
    const details = errorData ? asString(errorData.details) : undefined
    const normalized = {
      ...(code === undefined ? {} : { code }),
      ...(subcode === undefined ? {} : { subcode }),
      ...(title === undefined ? {} : { title }),
      ...(message === undefined ? {} : { message }),
      ...(details === undefined ? {} : { details }),
    }
    return Object.keys(normalized).length === 0 ? [] : [normalized]
  })
}

function normalizeCallbackStatus(status: string): MetaCallbackStatus {
  return status === 'sent' ||
    status === 'delivered' ||
    status === 'read' ||
    status === 'failed'
    ? status
    : 'unknown'
}

function parseRawStatus(
  rawStatus: RawStatus,
  payload: Record<string, unknown>,
  phoneNumberId?: string,
  businessAccountId?: string,
): WhatsAppStatusEvent | null {
  const providerMessageId = asString(rawStatus.id)
  const status = asString(rawStatus.status)
  const timestamp = asInteger(rawStatus.timestamp)
  if (
    !providerMessageId ||
    !status ||
    timestamp === undefined ||
    !isValidEpochSeconds(timestamp)
  ) return null

  return {
    type: 'status',
    providerMessageId,
    status: normalizeCallbackStatus(status),
    rawStatus: status,
    timestamp,
    recipientId: asString(rawStatus.recipient_id),
    phoneNumberId,
    businessAccountId,
    opaqueCallbackData: asString(rawStatus.biz_opaque_callback_data),
    errors: parseStatusErrors(rawStatus.errors),
    payload,
  }
}

export function parseWhatsAppWebhookEvents(
  body: unknown,
): WhatsAppWebhookEvent[] {
  const events: WhatsAppWebhookEvent[] = []

  try {
    const payload = asRawPayload(body)
    if (!payload || !isNonEmptyArray(payload.entry)) return events

    for (const entryValue of payload.entry) {
      const entry = asRawEntry(entryValue)
      if (!entry || !isNonEmptyArray(entry.changes)) continue
      const businessAccountId = asString(entry.id)

      for (const changeValue of entry.changes) {
        const change = asRawChange(changeValue)
        if (!change) continue

        const value = asRawChangeValue(change.value)
        if (!value) continue

        const metadata = asRawMetadata(value.metadata)
        const phoneNumberId = metadata ? asString(metadata.phone_number_id) : undefined

        if (Array.isArray(value.messages)) {
          for (const messageValue of value.messages) {
            const rawMsg = asRawMessage(messageValue)
            if (!rawMsg) continue

            const parsed = parseRawMessage(
              rawMsg,
              phoneNumberId,
              businessAccountId,
            )
            if (parsed) events.push(parsed)
          }
        }

        if (Array.isArray(value.statuses)) {
          for (const statusValue of value.statuses) {
            const rawStatus = asRawStatus(statusValue)
            if (!rawStatus || !isObject(statusValue)) continue
            const parsed = parseRawStatus(
              rawStatus,
              statusValue,
              phoneNumberId,
              businessAccountId,
            )
            if (parsed) events.push(parsed)
          }
        }
      }
    }
  } catch (err) {
    console.error('[whatsapp] Error parsing webhook events:', err)
    return events
  }

  return events
}

export function parseWebhookEvents(body: unknown): WhatsAppMessage[] {
  return parseWhatsAppWebhookEvents(body).filter(
    (event): event is WhatsAppMessage => event.type !== 'status',
  )
}

/**
 * @deprecated Use parseWebhookEvents. Returns the first message only.
 */
export function parseWebhookPayload(body: unknown): WebhookEvent {
  const events = parseWhatsAppWebhookEvents(body)
  const message = events.find(
    (event): event is WhatsAppMessage => event.type !== 'status',
  )
  if (message) return message
  const status = events.find(
    (event): event is WhatsAppStatusEvent => event.type === 'status',
  )
  return status ? { type: 'status', status: status.rawStatus } : null
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
