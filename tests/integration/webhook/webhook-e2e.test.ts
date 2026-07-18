/**
 * E2E in-process: signed webhook → route handler → Postgres local → Meta (MSW).
 * Supabase is NEVER mocked here. LLM is not needed: blank-text / onboarding paths are local.
 */
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { server } from '../../mocks/server'
import { capturedMetaMessages, clearCapturedMetaMessages } from '../../mocks/handlers'
import { getIntegrationSupabase } from '../helpers/supabase-local'
import { resetIntegrationDb } from '../helpers/db-reset'
import { getDbContainerName } from '../helpers/ensure-grants'
import {
  buildSignedWebhookRequest,
  buildTextWebhookPayload,
} from '../helpers/webhook-request'

function adminRows(sql: string): Array<Record<string, unknown>> {
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::text FROM (${sql}) q;`
  const output = execFileSync(
    'docker',
    [
      'exec', '-i', getDbContainerName(), 'psql', '-U', 'postgres',
      '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', wrapped,
    ],
    { encoding: 'utf8' },
  ).trim()
  return JSON.parse(output || '[]') as Array<Record<string, unknown>>
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(() => {
  server.listen({
    onUnhandledRequest(request, print) {
      const supabaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin
      if (new URL(request.url).origin === supabaseOrigin) return
      print.error()
    },
  })
})

afterAll(() => {
  try {
    resetIntegrationDb()
  } finally {
    server.close()
  }
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
    expect(capturedMetaMessages.length).toBe(metaAfterFirst)
  })
})

async function countInboundWork(messageId: string): Promise<number> {
  const supabase = getIntegrationSupabase()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count, error } = await (supabase as any)
    .from('inbound_work')
    .select('*', { count: 'exact', head: true })
    .eq('provider_message_id', messageId)
  if (error) throw new Error(error.message)
  return count ?? 0
}

describe('webhook E2E with inbound_work enabled', () => {
  const prevFlag = process.env.INBOUND_WORK_ENABLED

  beforeEach(() => {
    process.env.INBOUND_WORK_ENABLED = 'true'
  })

  afterEach(() => {
    process.env.INBOUND_WORK_ENABLED = prevFlag
  })

  it('smoke: commits inbound_work row for signed text', async () => {
    const { POST } = await import('@/app/api/webhook/whatsapp/route')
    const payload = buildTextWebhookPayload({
      messageId: 'wamid.e2e-inbox-1',
      text: 'oi',
      from: '5511555444333',
    })
    const res = await POST(buildSignedWebhookRequest(payload))
    expect(res.status).toBe(200)
    expect(await countInboundWork('wamid.e2e-inbox-1')).toBe(1)

    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('inbound_work')
      .select('status')
      .eq('provider_message_id', 'wamid.e2e-inbox-1')
      .single()
    expect(error).toBeNull()
    expect(data.status).toBe('committed')
  })

  it('dedup: replay does not create a second inbound_work row', async () => {
    const { POST } = await import('@/app/api/webhook/whatsapp/route')
    const payload = buildTextWebhookPayload({
      messageId: 'wamid.e2e-inbox-dedup',
      text: 'oi',
      from: '5511444333222',
    })
    const req1 = buildSignedWebhookRequest(payload)
    const req2 = buildSignedWebhookRequest(payload)

    expect((await POST(req1)).status).toBe(200)
    const metaAfterFirst = capturedMetaMessages.length
    expect((await POST(req2)).status).toBe(200)
    expect(await countInboundWork('wamid.e2e-inbox-dedup')).toBe(1)
    expect(capturedMetaMessages.length).toBe(metaAfterFirst)
  })

  it('active outbox: signed webhook reaches Meta, callback, and replay without duplication', async () => {
    const previousMode = process.env.OUTBOX_MODE
    const previousGeneration = process.env.OUTBOX_GENERATION
    const previousPercent = process.env.OUTBOX_CANARY_PERCENT
    process.env.OUTBOX_MODE = 'active'
    process.env.OUTBOX_GENERATION = 'e2e-active-generation'
    process.env.OUTBOX_CANARY_PERCENT = '100'

    try {
      const { POST } = await import('@/app/api/webhook/whatsapp/route')
      const payload = buildTextWebhookPayload({
        messageId: 'wamid.e2e-outbox-active',
        text: 'oi',
        from: '5511333222111',
      })

      expect((await POST(buildSignedWebhookRequest(payload))).status).toBe(200)
      expect(capturedMetaMessages).toHaveLength(1)
      const sent = capturedMetaMessages[0].body as {
        to?: string
        text?: { body?: string }
        biz_opaque_callback_data?: string
      }
      expect(sent.to).toBe('5511333222111')
      expect(sent.text?.body).toBeTruthy()
      expect(sent.biz_opaque_callback_data).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )

      const beforeReplay = adminRows(`
        SELECT id, status, provider_message_id
        FROM public.outbox_messages
        WHERE id = '${sent.biz_opaque_callback_data}'
      `)[0]
      expect(beforeReplay).toMatchObject({
        status: 'api_accepted',
        provider_message_id: 'wamid.test123',
      })

      const callbackPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'BIZ_ACCOUNT_ID',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID,
              },
              statuses: [{
                id: 'wamid.test123',
                status: 'delivered',
                timestamp: '1783976400',
                recipient_id: '5511333222111',
                biz_opaque_callback_data: sent.biz_opaque_callback_data,
              }],
            },
            field: 'messages',
          }],
        }],
      }
      expect((await POST(buildSignedWebhookRequest(callbackPayload))).status).toBe(200)

      expect(adminRows(`
        SELECT status
        FROM public.outbox_messages
        WHERE id = '${sent.biz_opaque_callback_data}'
      `)[0]).toMatchObject({ status: 'delivered' })

      expect((await POST(buildSignedWebhookRequest(payload))).status).toBe(200)
      expect(await countInboundWork('wamid.e2e-outbox-active')).toBe(1)
      expect(capturedMetaMessages).toHaveLength(1)
      expect(adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.outbox_messages
      `)[0]).toMatchObject({ count: 1 })
      expect(adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.outbox_status_events
        WHERE outbox_id = '${sent.biz_opaque_callback_data}'
          AND event_type = 'scope_finalized'
      `)[0]).toMatchObject({ count: 1 })
      expect(adminRows(`
        SELECT COUNT(*)::integer AS count
        FROM public.bot_messages
        WHERE metadata->>'outbox_id' = '${sent.biz_opaque_callback_data}'
      `)[0]).toMatchObject({ count: 1 })
    } finally {
      restoreEnv('OUTBOX_MODE', previousMode)
      restoreEnv('OUTBOX_GENERATION', previousGeneration)
      restoreEnv('OUTBOX_CANARY_PERCENT', previousPercent)
    }
  })
})
