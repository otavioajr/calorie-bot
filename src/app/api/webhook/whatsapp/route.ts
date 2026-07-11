export const maxDuration = 60

import { verifyWebhook, parseWebhookEvents, verifyWebhookSignature } from '@/lib/whatsapp/webhook'
import { MAX_WEBHOOK_BODY_BYTES } from '@/lib/whatsapp/limits'
import { createServiceRoleClient } from '@/lib/db/supabase'
import {
  handleIncomingMessage,
  handleIncomingAudio,
  handleIncomingImage,
  handleUnsupportedMessage,
} from '@/lib/bot/handler'
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
  if (!expected) return true
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

async function claimMessage(supabase: ReturnType<typeof createServiceRoleClient>, messageId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dedupError } = await (supabase as any)
    .from('processed_messages')
    .insert({ message_id: messageId })
    .select()
    .single()

  if (dedupError?.code === '23505') {
    return false
  }

  if (dedupError) {
    console.error('[webhook] Dedup insert failed (processing anyway):', dedupError.message)
  }

  return true
}

async function processMessage(event: WhatsAppMessage): Promise<void> {
  if (event.type === 'text') {
    await handleIncomingMessage(event.from, event.messageId, event.text ?? '', event.quotedMessageId)
    return
  }

  if (event.type === 'audio' && event.audioId) {
    await handleIncomingAudio(event.from, event.messageId, event.audioId, event.quotedMessageId)
    return
  }

  if (event.type === 'image' && event.imageId) {
    await handleIncomingImage(
      event.from,
      event.messageId,
      event.imageId,
      event.caption,
      event.quotedMessageId,
    )
    return
  }

  if (event.type === 'unsupported') {
    await handleUnsupportedMessage(event.from, event.rawType ?? 'unknown')
  }
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()

    if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
      return new Response('Payload Too Large', { status: 413 })
    }

    const appSecret = process.env.META_APP_SECRET
    const signatureHeader = request.headers.get('x-hub-signature-256')

    if (!verifyWebhookSignature(rawBody, signatureHeader, appSecret)) {
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

    for (const event of events) {
      if (!isExpectedPhoneNumberId(event.phoneNumberId)) {
        continue
      }

      try {
        const claimed = await claimMessage(supabase, event.messageId)
        if (!claimed) continue

        await processMessage(event)
      } catch (err) {
        console.error('[webhook] Error processing message', event.messageId, err)
      }
    }

    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[webhook] Error processing webhook:', err)
    return new Response('OK', { status: 200 })
  }
}
