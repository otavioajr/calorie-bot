/**
 * E2E in-process: signed webhook → route handler → Postgres local → Meta (MSW).
 * Supabase is NEVER mocked here. LLM is not needed: blank-text / onboarding paths are local.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { server } from '../../mocks/server'
import { capturedMetaMessages, clearCapturedMetaMessages } from '../../mocks/handlers'
import { getIntegrationSupabase } from '../helpers/supabase-local'
import { resetIntegrationDb } from '../helpers/db-reset'
import {
  buildSignedWebhookRequest,
  buildTextWebhookPayload,
} from '../helpers/webhook-request'

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' })
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  resetIntegrationDb()
  clearCapturedMetaMessages()
  server.resetHandlers()
})

afterEach(() => {
  clearCapturedMetaMessages()
})

async function countProcessed(messageId?: string): Promise<number> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabase as any).from('processed_messages').select('*', { count: 'exact', head: true })
  if (messageId) {
    query = query.eq('message_id', messageId)
  }
  const { count, error } = await query
  if (error) throw new Error(error.message)
  return count ?? 0
}

describe('webhook E2E (in-process)', () => {
  it('smoke: signed text claims message, writes DB, and calls Meta', async () => {
    const { POST } = await import('@/app/api/webhook/whatsapp/route')
    const payload = buildTextWebhookPayload({
      messageId: 'wamid.e2e-smoke-1',
      text: 'oi',
      from: '5511888777666',
    })
    const res = await POST(buildSignedWebhookRequest(payload))
    expect(res.status).toBe(200)

    expect(await countProcessed('wamid.e2e-smoke-1')).toBe(1)

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: users, error } = await (supabase as any)
      .from('users')
      .select('phone, onboarding_step')
      .eq('phone', '5511888777666')
    expect(error).toBeNull()
    expect(users?.length).toBe(1)
    expect(users![0].onboarding_step).toBeGreaterThanOrEqual(1)

    expect(capturedMetaMessages.length).toBeGreaterThanOrEqual(1)
    const sent = capturedMetaMessages[0].body as { to?: string; text?: { body?: string } }
    expect(sent.to).toBe('5511888777666')
    expect(sent.text?.body).toBeTruthy()
  })

  it('batch: N message ids produce N processed_messages rows', async () => {
    const { POST } = await import('@/app/api/webhook/whatsapp/route')
    const payload = buildTextWebhookPayload({
      messageId: 'wamid.e2e-batch-a',
      text: 'oi',
      from: '5511777666555',
      extraMessages: [
        { id: 'wamid.e2e-batch-b', text: 'oi', from: '5511777666555' },
      ],
    })
    const res = await POST(buildSignedWebhookRequest(payload))
    expect(res.status).toBe(200)

    expect(await countProcessed('wamid.e2e-batch-a')).toBe(1)
    expect(await countProcessed('wamid.e2e-batch-b')).toBe(1)
    expect(await countProcessed()).toBe(2)
  })

  it('dedup: same message_id is claimed only once', async () => {
    const { POST } = await import('@/app/api/webhook/whatsapp/route')
    const payload = buildTextWebhookPayload({
      messageId: 'wamid.e2e-dedup',
      text: 'oi',
      from: '5511666555444',
    })
    const req1 = buildSignedWebhookRequest(payload)
    const req2 = buildSignedWebhookRequest(payload)

    expect((await POST(req1)).status).toBe(200)
    const metaAfterFirst = capturedMetaMessages.length
    expect(metaAfterFirst).toBeGreaterThanOrEqual(1)

    expect((await POST(req2)).status).toBe(200)
    expect(await countProcessed('wamid.e2e-dedup')).toBe(1)
    // Second delivery must not send another WhatsApp message
    expect(capturedMetaMessages.length).toBe(metaAfterFirst)
  })
})
