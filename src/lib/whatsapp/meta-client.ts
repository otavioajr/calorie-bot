import type { MetaSendOutcome } from '@/lib/outbox/types'

const GRAPH_API_VERSION = 'v21.0'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RAW_RESPONSE_LENGTH = 4_096

export type MetaFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface SendMetaTextInput {
  to: string
  text: string
  replyToMessageId?: string
  bizOpaqueCallbackData?: string
}

export interface MetaClientOptions {
  timeoutMs?: number
  fetchImpl?: MetaFetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readResponseBody(response: Response): Promise<{
  body: Record<string, unknown> | null
  rawBody: string
}> {
  const rawBody = await response.text()
  if (!rawBody) return { body: null, rawBody }

  try {
    const parsed = JSON.parse(rawBody) as unknown
    return {
      body: isRecord(parsed) ? parsed : { value: parsed },
      rawBody,
    }
  } catch {
    return {
      body: { rawBody: rawBody.slice(0, MAX_RAW_RESPONSE_LENGTH) },
      rawBody,
    }
  }
}

function acceptedMessageId(body: Record<string, unknown> | null): string | undefined {
  const messages = body?.messages
  if (!Array.isArray(messages) || !isRecord(messages[0])) return undefined
  return optionalString(messages[0].id)
}

function recipientId(body: Record<string, unknown> | null): string | undefined {
  const contacts = body?.contacts
  if (!Array.isArray(contacts) || !isRecord(contacts[0])) return undefined
  return optionalString(contacts[0].wa_id)
}

function metaError(body: Record<string, unknown> | null): {
  metaCode?: number
  metaSubcode?: number
  message?: string
} {
  const error = body?.error
  if (!isRecord(error)) return {}
  return {
    metaCode: optionalNumber(error.code),
    metaSubcode: optionalNumber(error.error_subcode),
    message: optionalString(error.message),
  }
}

export async function sendMetaTextMessage(
  input: SendMetaTextInput,
  options: MetaClientOptions = {},
): Promise<MetaSendOutcome> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim()
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim()

  if (!accessToken) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')
  }
  if (!phoneNumberId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured')
  }

  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to: input.to,
    type: 'text',
    text: { body: input.text },
  }
  if (input.replyToMessageId) {
    payload.context = { message_id: input.replyToMessageId }
  }
  if (input.bizOpaqueCallbackData) {
    payload.biz_opaque_callback_data = input.bizOpaqueCallbackData
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Meta client timeout must be a positive number')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    )
  } catch (error) {
    clearTimeout(timer)
    return {
      kind: 'outcome_unknown',
      outcomeUnknown: true,
      message: errorMessage(error),
    }
  }

  const requestId = optionalString(response.headers.get('x-fb-request-id'))
  let body: Record<string, unknown> | null
  let rawBody: string
  try {
    const parsed = await readResponseBody(response)
    body = parsed.body
    rawBody = parsed.rawBody
  } catch (error) {
    clearTimeout(timer)
    if (!response.ok) {
      return {
        kind: 'rejected',
        httpStatus: response.status,
        ...(requestId ? { requestId } : {}),
        message: errorMessage(error),
      }
    }
    return {
      kind: 'outcome_unknown',
      outcomeUnknown: true,
      httpStatus: response.status,
      ...(requestId ? { requestId } : {}),
      message: errorMessage(error),
    }
  }
  clearTimeout(timer)

  if (!response.ok) {
    const details = metaError(body)
    return {
      kind: 'rejected',
      httpStatus: response.status,
      ...(requestId ? { requestId } : {}),
      response: body,
      ...details,
      message:
        details.message ??
        optionalString(rawBody)?.slice(0, MAX_RAW_RESPONSE_LENGTH) ??
        `Meta returned HTTP ${response.status}`,
    }
  }

  const providerMessageId = acceptedMessageId(body)
  if (!providerMessageId) {
    return {
      kind: 'outcome_unknown',
      outcomeUnknown: true,
      httpStatus: response.status,
      ...(requestId ? { requestId } : {}),
      response: body,
      message: 'Meta returned a 2xx response without a message ID',
    }
  }

  const acceptedRecipientId = recipientId(body)
  return {
    kind: 'accepted',
    providerMessageId,
    ...(acceptedRecipientId ? { recipientId: acceptedRecipientId } : {}),
    httpStatus: response.status,
    ...(requestId ? { requestId } : {}),
    response: body,
  }
}
