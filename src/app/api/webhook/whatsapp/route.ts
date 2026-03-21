import { verifyWebhook, parseWebhookPayload } from '@/lib/whatsapp/webhook'
import { createServiceRoleClient } from '@/lib/db/supabase'

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
    const { data, error } = await supabase
      .from('processed_messages')
      .insert({ message_id: event.messageId })
      .select()
      .single()

    if (error) {
      // Duplicate — already processed
      return new Response('OK', { status: 200 })
    }

    // TODO: Process message (will be wired in Task 15)
    // For now, just acknowledge
    console.log(`[webhook] Received message from ${event.from}: ${event.text}`)

    void data // suppress unused variable warning

    return new Response('OK', { status: 200 })
  } catch (err) {
    // ALWAYS return 200 to Meta, even on error
    console.error('[webhook] Error processing message:', err)
    return new Response('OK', { status: 200 })
  }
}
