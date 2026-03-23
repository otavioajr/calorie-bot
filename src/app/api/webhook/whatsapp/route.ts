import { verifyWebhook, parseWebhookPayload } from '@/lib/whatsapp/webhook'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { handleIncomingMessage, handleIncomingAudio, handleIncomingImage } from '@/lib/bot/handler'

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

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const event = parseWebhookPayload(body)

    // Ignore non-message events
    if (!event || event.type === 'status') {
      return new Response('OK', { status: 200 })
    }

    // Deduplicate by message_id
    const supabase = createServiceRoleClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('processed_messages')
      .insert({ message_id: event.messageId })
      .select()
      .single()

    if (error) {
      // Duplicate — already processed
      return new Response('OK', { status: 200 })
    }

    void data // suppress unused variable warning

    if (event.type === 'text' && event.text) {
      await handleIncomingMessage(event.from, event.messageId, event.text)
    }

    if (event.type === 'audio' && event.audioId) {
      await handleIncomingAudio(event.from, event.messageId, event.audioId)
    }

    if (event.type === 'image' && event.imageId) {
      await handleIncomingImage(event.from, event.messageId, event.imageId, event.caption)
    }

    return new Response('OK', { status: 200 })
  } catch (err) {
    // ALWAYS return 200 to Meta, even on error
    console.error('[webhook] Error processing message:', err)
    return new Response('OK', { status: 200 })
  }
}
