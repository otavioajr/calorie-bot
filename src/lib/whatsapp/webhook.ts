// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhatsAppMessage {
  type: 'text' | 'image' | 'audio' | 'unknown'
  from: string
  messageId: string
  text?: string
  audioId?: string
  timestamp: number
}

export interface WhatsAppStatus {
  type: 'status'
  status: string
}

export type WebhookEvent = WhatsAppMessage | WhatsAppStatus | null

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
}

interface RawStatus {
  id?: unknown
  status?: unknown
  timestamp?: unknown
}

interface RawChangeValue {
  messaging_product?: unknown
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

function asRawStatus(value: unknown): RawStatus | null {
  if (!isObject(value)) return null
  return value as RawStatus
}

// ---------------------------------------------------------------------------
// parseWebhookPayload
// ---------------------------------------------------------------------------

export function parseWebhookPayload(body: unknown): WebhookEvent {
  try {
    const payload = asRawPayload(body)
    if (!payload) return null

    if (!isNonEmptyArray(payload.entry)) return null

    const entry = asRawEntry(payload.entry[0])
    if (!entry) return null

    if (!isNonEmptyArray(entry.changes)) return null

    const change = asRawChange(entry.changes[0])
    if (!change) return null

    const value = asRawChangeValue(change.value)
    if (!value) return null

    // --- Status update (has "statuses", no "messages") ---
    if (isNonEmptyArray(value.statuses)) {
      const rawStatus = asRawStatus(value.statuses[0])
      if (!rawStatus) return null

      const status = asString(rawStatus.status)
      if (!status) return null

      return { type: 'status', status }
    }

    // --- Message ---
    if (!isNonEmptyArray(value.messages)) return null

    const rawMsg = asRawMessage(value.messages[0])
    if (!rawMsg) return null

    const from = asString(rawMsg.from)
    const messageId = asString(rawMsg.id)
    const timestampStr = asString(rawMsg.timestamp)
    const msgType = asString(rawMsg.type)

    if (!from || !messageId || !timestampStr || !msgType) return null

    const timestamp = parseInt(timestampStr, 10)
    if (isNaN(timestamp)) return null

    if (msgType === 'text') {
      const textBody =
        isObject(rawMsg.text) ? asString((rawMsg.text as { body?: unknown }).body) : undefined

      return {
        type: 'text',
        from,
        messageId,
        text: textBody,
        timestamp,
      }
    }

    if (msgType === 'image') {
      return {
        type: 'image',
        from,
        messageId,
        timestamp,
      }
    }

    if (msgType === 'audio') {
      const audioId = isObject(rawMsg.audio) ? asString((rawMsg.audio as { id?: unknown }).id) : undefined

      return {
        type: 'audio',
        from,
        messageId,
        audioId,
        timestamp,
      }
    }

    // Unrecognised type
    return {
      type: 'unknown',
      from,
      messageId,
      timestamp,
    }
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
