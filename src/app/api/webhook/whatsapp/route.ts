export const maxDuration = 60

import { randomUUID } from 'crypto'
import { verifyWebhook, parseWebhookEvents, verifyWebhookSignature } from '@/lib/whatsapp/webhook'
import { MAX_WEBHOOK_BODY_BYTES } from '@/lib/whatsapp/limits'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { processInboundWork } from '@/lib/bot/inbound-processor'
import {
  handleIncomingMessage,
  handleIncomingAudio,
  handleIncomingImage,
  handleUnsupportedMessage,
} from '@/lib/bot/handler'
import {
  enqueueInboundWork,
  INBOUND_WORK_PROVIDER,
  isInboundWorkEnabled,
  listStaleInboundWork,
  shouldSkipInboundProcessing,
  type InboundPayload,
} from '@/lib/db/queries/inbound-work'
import type { WhatsAppMessage } from '@/lib/whatsapp/webhook'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const params = url.searchParams
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN!

  const challenge = verifyWebhook(params, verifyToken)
  if (challenge) {
    return new Response(challenge, { status: 200 })
  }
  return new Response('Forbidden', { status: 403 })
}

function isExpectedPhoneNumberId(phoneNumberId: string | undefined): boolean {
  const expected = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim()
  if (!expected) {
    console.warn('[webhook] WHATSAPP_PHONE_NUMBER_ID is not configured; ignoring event')
    return false
  }
  if (!phoneNumberId) {
    console.warn('[webhook] Missing phone_number_id in payload; expected', expected)
    return false
  }
  if (phoneNumberId !== expected) {
    console.warn('[webhook] Ignoring event for unexpected phone_number_id:', phoneNumberId)
    return false
  }
  return true
}

function toInboundPayload(event: WhatsAppMessage): InboundPayload {
  return {
    type: event.type,
    from: event.from,
    messageId: event.messageId,
    phoneNumberId: event.phoneNumberId,
    text: event.text,
    audioId: event.audioId,
    imageId: event.imageId,
    caption: event.caption,
    quotedMessageId: event.quotedMessageId,
    rawType: event.rawType,
  }
}

async function claimLegacyMessage(
  supabase: ReturnType<typeof createServiceRoleClient>,
  messageId: string,
): Promise<'claimed' | 'duplicate' | 'failed'> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dedupError } = await (supabase as any)
    .from('processed_messages')
    .insert({ message_id: messageId })
    .select()
    .single()

  if (dedupError?.code === '23505') {
    return 'duplicate'
  }

  if (dedupError) {
    console.error('[webhook] Dedup insert failed (fail-closed):', dedupError.message)
    return 'failed'
  }

  return 'claimed'
}

async function dispatchMessage(event: WhatsAppMessage): Promise<void> {
  if (event.type === 'text') {
    await handleIncomingMessage(event.from, event.messageId, event.text ?? '', event.quotedMessageId)
    return
  }

  if (event.type === 'audio') {
    if (event.audioId) {
      await handleIncomingAudio(event.from, event.messageId, event.audioId, event.quotedMessageId)
    } else {
      await handleUnsupportedMessage(event.from, 'audio')
    }
    return
  }

  if (event.type === 'image') {
    if (event.imageId) {
      await handleIncomingImage(
        event.from,
        event.messageId,
        event.imageId,
        event.caption,
        event.quotedMessageId,
      )
    } else {
      await handleUnsupportedMessage(event.from, 'image')
    }
    return
  }

  if (event.type === 'unsupported') {
    await handleUnsupportedMessage(event.from, event.rawType ?? 'unknown')
  }
}

async function processLegacyMessage(event: WhatsAppMessage): Promise<void> {
  await dispatchMessage(event)
}

async function piggybackStaleInboundWork(
  supabase: ReturnType<typeof createServiceRoleClient>,
  leaseOwner: string,
  limit: number = 2,
): Promise<void> {
  const staleRows = await listStaleInboundWork(supabase, limit)
  for (const row of staleRows) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('inbound_work')
        .select('payload_json')
        .eq('id', row.workId)
        .single()

      if (error || !data?.payload_json) {
        console.error('[webhook] piggyback missing payload for', row.workId, error?.message)
        continue
      }

      await processInboundWork(
        supabase,
        { workId: row.workId, payload: data.payload_json as InboundPayload, status: row.status },
        leaseOwner,
      )
    } catch (err) {
      console.error('[webhook] piggyback failed for', row.workId, err)
    }
  }
}

async function processInboundEvent(
  supabase: ReturnType<typeof createServiceRoleClient>,
  event: WhatsAppMessage,
  leaseOwner: string,
): Promise<'ok' | 'enqueue_failed' | 'skipped'> {
  const businessAccountId = event.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'unknown'
  const enqueued = await enqueueInboundWork(supabase, {
    provider: INBOUND_WORK_PROVIDER,
    businessAccountId,
    providerMessageId: event.messageId,
    userPhone: event.from,
    eventAt: new Date(event.timestamp * 1000).toISOString(),
    payload: toInboundPayload(event),
  })

  if (!enqueued.ok) {
    return 'enqueue_failed'
  }

  if (shouldSkipInboundProcessing(enqueued.status)) {
    return 'skipped'
  }

  await processInboundWork(
    supabase,
    {
      workId: enqueued.workId,
      payload: toInboundPayload(event),
      status: enqueued.status,
    },
    leaseOwner,
  )

  return 'ok'
}

type WebhookBodyReadResult =
  | { tooLarge: true }
  | { tooLarge: false; rawBody: string; rawBytes: Uint8Array }

function hasOversizedDeclaredBody(request: Request): boolean {
  const contentLength = request.headers.get('content-length')?.trim()
  if (!contentLength || !/^\d+$/.test(contentLength)) return false

  return Number(contentLength) > MAX_WEBHOOK_BODY_BYTES
}

async function readWebhookBody(request: Request): Promise<WebhookBodyReadResult> {
  if (hasOversizedDeclaredBody(request)) {
    return { tooLarge: true }
  }

  if (!request.body) {
    return { tooLarge: false, rawBody: '', rawBytes: new Uint8Array() }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      if (value.byteLength > MAX_WEBHOOK_BODY_BYTES - totalBytes) {
        await reader.cancel().catch(() => undefined)
        return { tooLarge: true }
      }

      chunks.push(value)
      totalBytes += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  const rawBytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    rawBytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return {
    tooLarge: false,
    rawBody: new TextDecoder().decode(rawBytes),
    rawBytes,
  }
}

export async function POST(request: Request) {
  try {
    const bodyRead = await readWebhookBody(request)
    if (bodyRead.tooLarge) {
      return new Response('Payload Too Large', { status: 413 })
    }

    const { rawBody, rawBytes } = bodyRead

    const appSecret = process.env.META_APP_SECRET
    const signatureHeader = request.headers.get('x-hub-signature-256')

    if (!verifyWebhookSignature(rawBytes, signatureHeader, appSecret)) {
      return new Response('Unauthorized', { status: 401 })
    }

    let body: unknown
    try {
      body = JSON.parse(rawBody) as unknown
    } catch {
      return new Response('Bad Request', { status: 400 })
    }

    const events = parseWebhookEvents(body)
    if (events.length === 0) {
      return new Response('OK', { status: 200 })
    }

    const supabase = createServiceRoleClient()
    const leaseOwner = randomUUID()
    let inboxDirty = false

    if (isInboundWorkEnabled()) {
      await piggybackStaleInboundWork(supabase, leaseOwner, 2)
    }

    for (const event of events) {
      if (!isExpectedPhoneNumberId(event.phoneNumberId)) {
        continue
      }

      try {
        if (isInboundWorkEnabled()) {
          const result = await processInboundEvent(supabase, event, leaseOwner)
          if (result === 'enqueue_failed') {
            inboxDirty = true
          }
          continue
        }

        const claimResult = await claimLegacyMessage(supabase, event.messageId)
        if (claimResult === 'duplicate') {
          continue
        }
        if (claimResult === 'failed') {
          inboxDirty = true
          continue
        }

        await processLegacyMessage(event)
      } catch (err) {
        console.error('[webhook] Error processing message', event.messageId, err)
        inboxDirty = true
      }
    }

    if (inboxDirty) {
      return new Response('Service Unavailable', { status: 503 })
    }

    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[webhook] Error processing webhook:', err)
    return new Response('Service Unavailable', { status: 503 })
  }
}
