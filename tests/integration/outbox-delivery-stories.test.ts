import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { sendOTP } from '@/lib/auth/otp'
import { hashPayload } from '@/lib/outbox/policy'
import {
  claimOutboxMessages,
  enqueueOutboxMessage,
} from '@/lib/outbox/repository'
import { sendTextThroughOutbox } from '@/lib/outbox/service'
import { server } from '../mocks/server'
import { resetIntegrationDb } from './helpers/db-reset'
import { getDbContainerName } from './helpers/ensure-grants'
import { getIntegrationSupabase } from './helpers/supabase-local'

type CapturedPost = {
  to: string
  text: { body: string }
  biz_opaque_callback_data?: string
}

type AdminRow = Record<string, unknown>

const META_MESSAGES_URL =
  'https://graph.facebook.com/v21.0/000000000000000/messages'
const GENERATION = 'delivery-stories-generation'
const capturedPosts: CapturedPost[] = []

const originalOutboxEnv = {
  OUTBOX_MODE: process.env.OUTBOX_MODE,
  OUTBOX_GENERATION: process.env.OUTBOX_GENERATION,
  OUTBOX_CANARY_PERCENT: process.env.OUTBOX_CANARY_PERCENT,
  INBOUND_WORK_ENABLED: process.env.INBOUND_WORK_ENABLED,
}

function adminRows(sql: string): AdminRow[] {
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::text FROM (${sql}) q;`
  const output = execFileSync(
    'docker',
    [
      'exec', '-i', getDbContainerName(), 'psql', '-U', 'postgres',
      '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', wrapped,
    ],
    { encoding: 'utf8' },
  ).trim()
  return JSON.parse(output || '[]') as AdminRow[]
}

function adminExec(sql: string): void {
  execFileSync(
    'docker',
    [
      'exec', '-i', getDbContainerName(), 'psql', '-U', 'postgres',
      '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function captureAcceptedPosts(): void {
  server.use(http.post(META_MESSAGES_URL, async ({ request }) => {
    capturedPosts.push(await request.json() as CapturedPost)
    return HttpResponse.json({
      contacts: [{ wa_id: capturedPosts.at(-1)?.to }],
      messages: [{ id: `wamid.story.${capturedPosts.length}` }],
    })
  }))
}

async function sendWithMetaStatus(httpStatus: number) {
  capturedPosts.length = 0
  server.use(http.post(META_MESSAGES_URL, async ({ request }) => {
    capturedPosts.push(await request.json() as CapturedPost)
    return HttpResponse.json(
      { error: { message: `HTTP ${httpStatus}` } },
      { status: httpStatus },
    )
  }))
  return sendTextThroughOutbox({
    to: '5511999000003',
    text: `status ${httpStatus}`,
    options: {
      source: 'reminder',
      messageKind: 'reminder',
      idempotencyKey: `reminder:error:${httpStatus}`,
    },
  })
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
    restoreEnv('OUTBOX_MODE', originalOutboxEnv.OUTBOX_MODE)
    restoreEnv('OUTBOX_GENERATION', originalOutboxEnv.OUTBOX_GENERATION)
    restoreEnv('OUTBOX_CANARY_PERCENT', originalOutboxEnv.OUTBOX_CANARY_PERCENT)
    restoreEnv('INBOUND_WORK_ENABLED', originalOutboxEnv.INBOUND_WORK_ENABLED)
  }
})

beforeEach(() => {
  resetIntegrationDb()
  capturedPosts.length = 0
  server.resetHandlers()
  process.env.OUTBOX_MODE = 'active'
  process.env.OUTBOX_GENERATION = GENERATION
  process.env.OUTBOX_CANARY_PERCENT = '100'
  process.env.INBOUND_WORK_ENABLED = 'true'
  captureAcceptedPosts()
})

describe('durable outbox delivery stories', () => {
  it('delivers OTP once with auth-code key, three-attempt policy, and redaction', async () => {
    await sendOTP('5511999000001')

    expect(capturedPosts).toHaveLength(1)
    expect(capturedPosts[0]).toMatchObject({
      to: '5511999000001',
      text: { body: expect.stringMatching(/código de acesso.*\*\d{6}\*/i) },
      biz_opaque_callback_data: expect.any(String),
    })
    const otp = adminRows(`
      SELECT om.id, om.idempotency_key, om.max_attempts, om.attempt, om.status,
             om.provider_message_id, om.payload_json,
             om.payload_redacted_at IS NOT NULL AS redacted,
             ac.id AS auth_code_id
      FROM public.outbox_messages AS om
      JOIN public.auth_codes AS ac ON ac.id = om.resource_id
      WHERE om.recipient = '5511999000001'
    `)[0]
    expect(otp).toMatchObject({
      id: capturedPosts[0].biz_opaque_callback_data,
      idempotency_key: `otp:${otp?.auth_code_id}`,
      max_attempts: 3,
      attempt: 1,
      status: 'api_accepted',
      provider_message_id: 'wamid.story.1',
      payload_json: null,
      redacted: true,
    })
  })

  it('rejects the fourth OTP in the same window before a Meta POST', async () => {
    const phone = '5511999000011'

    await sendOTP(phone)
    await sendOTP(phone)
    await sendOTP(phone)
    await expect(sendOTP(phone)).rejects.toThrow(/rate limit/i)

    expect(capturedPosts).toHaveLength(3)
    expect(capturedPosts.every((post) => post.to === phone)).toBe(true)
    expect(adminRows(`
      SELECT
        (SELECT COUNT(*)::integer FROM public.auth_codes WHERE phone = '${phone}') AS codes,
        (SELECT COUNT(*)::integer FROM public.outbox_messages WHERE recipient = '${phone}') AS outbox_rows,
        (SELECT COUNT(*)::integer FROM public.outbox_messages
          WHERE recipient = '${phone}' AND status = 'api_accepted') AS accepted
    `)[0]).toMatchObject({ codes: 3, outbox_rows: 3, accepted: 3 })
  })

  it('replays a reminder idempotently with one row and one Meta POST', async () => {
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: user, error } = await (supabase as any)
      .from('users')
      .insert({ phone: '5511999000002', name: 'Reminder Story' })
      .select('id')
      .single()
    expect(error).toBeNull()

    const reminder = {
      to: '5511999000002',
      text: 'Hora do almoço',
      options: {
        source: 'reminder' as const,
        messageKind: 'reminder' as const,
        idempotencyKey: 'reminder:user-1:daily-reminder:2026-07-14',
        userId: user!.id,
        resourceMetadata: {
          reminderType: 'lunch',
          localDate: '2026-07-14',
        },
      },
    }

    const first = await sendTextThroughOutbox(reminder)
    const replay = await sendTextThroughOutbox(reminder)

    expect(capturedPosts).toHaveLength(1)
    expect(capturedPosts[0]).toMatchObject({
      to: reminder.to,
      text: { body: reminder.text },
      biz_opaque_callback_data: first.outboxId,
    })
    expect(replay).toMatchObject({
      outboxId: first.outboxId,
      providerMessageId: 'wamid.story.1',
      status: 'api_accepted',
      replayed: true,
    })
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count,
             MIN(status) AS status,
             MIN(provider_message_id) AS provider_message_id
      FROM public.outbox_messages
      WHERE idempotency_key =
        'reminder:user-1:daily-reminder:2026-07-14'
    `)[0]).toMatchObject({
      count: 1,
      status: 'api_accepted',
      provider_message_id: 'wamid.story.1',
    })
  })

  const rejectionStories = [
    { httpStatus: 429, expectedStatus: 'retryable', hasBackoff: true },
    { httpStatus: 400, expectedStatus: 'failed_terminal', hasBackoff: false },
  ] as const

  it.each(rejectionStories)(
    'projects HTTP $httpStatus as $expectedStatus after exactly one POST',
    async ({ httpStatus, expectedStatus, hasBackoff }) => {
      const result = await sendWithMetaStatus(httpStatus)

      expect(result.status).toBe(expectedStatus)
      expect(capturedPosts).toHaveLength(1)
      expect(capturedPosts[0].text.body).toBe(`status ${httpStatus}`)
      const stored = adminRows(`
        SELECT status, attempt, provider_message_id,
               next_attempt_at IS NOT NULL AS has_backoff,
               CASE
                 WHEN next_attempt_at IS NULL THEN FALSE
                 ELSE next_attempt_at > NOW()
               END AS backoff_is_future
        FROM public.outbox_messages
        WHERE idempotency_key = 'reminder:error:${httpStatus}'
      `)[0]
      expect(stored).toMatchObject({
        status: expectedStatus,
        attempt: 1,
        provider_message_id: null,
        has_backoff: hasBackoff,
        backoff_is_future: hasBackoff,
      })
    },
  )

  it('moves a real expired sending lease to unknown without posting or replaying', async () => {
    const supabase = getIntegrationSupabase()
    const recipient = '5511999000006'
    const idempotencyKey = 'reminder:expired-lease:2026-07-14'
    const text = 'Lease maintenance story'
    const payload = { version: 1, type: 'text', text }
    const enqueued = await enqueueOutboxMessage(supabase, {
      provider: 'whatsapp_cloud',
      businessAccountId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
      recipient,
      userId: null,
      workId: null,
      emissionIndex: null,
      idempotencyKey,
      messageKind: 'reminder',
      payload,
      payloadHash: hashPayload({
        version: 1,
        messageKind: 'reminder',
        payload,
        replyToMessageId: null,
        userId: null,
        resourceType: null,
        resourceId: null,
        resourceMetadata: null,
      }),
      replyToMessageId: null,
      resourceType: null,
      resourceId: null,
      resourceMetadata: null,
      rolloutMode: 'active',
      rolloutGeneration: GENERATION,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    })
    expect(enqueued.ok).toBe(true)
    if (!enqueued.ok) throw new Error(enqueued.error.message)

    const firstClaim = await claimOutboxMessages(
      supabase,
      'story:expired-lease:first-claim',
      GENERATION,
      { limit: 1, leaseSeconds: 90, outboxId: enqueued.outboxId },
    )
    expect(firstClaim.ok).toBe(true)
    if (!firstClaim.ok) throw new Error(firstClaim.error.message)
    expect(firstClaim.rows).toHaveLength(1)
    expect(capturedPosts).toHaveLength(0)
    expect(adminRows(`
      SELECT status, attempt, lease_token IS NOT NULL AS leased
      FROM public.outbox_messages
      WHERE id = '${enqueued.outboxId}'
    `)[0]).toMatchObject({ status: 'sending', attempt: 1, leased: true })

    adminExec(`
      UPDATE public.outbox_messages
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE id = '${enqueued.outboxId}'
    `)

    const maintained = await claimOutboxMessages(
      supabase,
      'story:expired-lease:maintenance',
      GENERATION,
      { limit: 1, leaseSeconds: 90, outboxId: enqueued.outboxId },
    )
    expect(maintained).toMatchObject({ ok: true, rows: [] })
    expect(adminRows(`
      SELECT status, attempt, next_attempt_at, lease_owner, lease_token,
             lease_expires_at,
             unknown_reconcile_at IS NOT NULL AS awaits_reconciliation,
             last_error_code
      FROM public.outbox_messages
      WHERE id = '${enqueued.outboxId}'
    `)[0]).toMatchObject({
      status: 'unknown',
      attempt: 1,
      next_attempt_at: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      awaits_reconciliation: true,
      last_error_code: 'stale_sending_lease',
    })
    expect(capturedPosts).toHaveLength(0)

    const repeatedMaintenance = await claimOutboxMessages(
      supabase,
      'story:expired-lease:repeat',
      GENERATION,
      { limit: 1, leaseSeconds: 90, outboxId: enqueued.outboxId },
    )
    expect(repeatedMaintenance).toMatchObject({ ok: true, rows: [] })

    const replay = await sendTextThroughOutbox({
      to: recipient,
      text,
      options: {
        source: 'reminder',
        messageKind: 'reminder',
        idempotencyKey,
      },
    })
    expect(replay).toMatchObject({
      outboxId: enqueued.outboxId,
      status: 'unknown',
      replayed: true,
      providerMessageId: null,
    })
    expect(capturedPosts).toHaveLength(0)
    expect(adminRows(`
      SELECT COUNT(*)::integer AS count
      FROM public.outbox_status_events
      WHERE outbox_id = '${enqueued.outboxId}'
        AND event_type = 'lease_expired_unknown'
    `)[0]).toMatchObject({ count: 1 })
  })

  it('marks a socket-close outcome unknown and blocks its successor without a POST', async () => {
    const recipient = '5511999000004'
    server.use(http.post(META_MESSAGES_URL, async ({ request }) => {
      capturedPosts.push(await request.json() as CapturedPost)
      return HttpResponse.error()
    }))

    const unknown = await sendTextThroughOutbox({
      to: recipient,
      text: 'socket closes after POST starts',
      options: {
        source: 'reminder',
        messageKind: 'reminder',
        idempotencyKey: 'reminder:unknown:socket',
      },
    })

    expect(unknown.status).toBe('unknown')
    expect(capturedPosts).toHaveLength(1)
    expect(adminRows(`
      SELECT status, attempt, next_attempt_at,
             unknown_reconcile_at IS NOT NULL AS awaits_reconciliation
      FROM public.outbox_messages
      WHERE idempotency_key = 'reminder:unknown:socket'
    `)[0]).toMatchObject({
      status: 'unknown',
      attempt: 1,
      next_attempt_at: null,
      awaits_reconciliation: true,
    })

    captureAcceptedPosts()
    const successor = await sendTextThroughOutbox({
      to: recipient,
      text: 'must wait behind unknown',
      options: {
        source: 'reminder',
        messageKind: 'reminder',
        idempotencyKey: 'reminder:unknown:successor',
      },
    })

    expect(successor).toMatchObject({
      providerMessageId: null,
      status: 'pending',
    })
    expect(capturedPosts).toHaveLength(1)
    expect(capturedPosts.filter(
      (post) => post.text.body === 'must wait behind unknown',
    )).toHaveLength(0)
    expect(adminRows(`
      SELECT status, attempt, provider_message_id
      FROM public.outbox_messages
      WHERE idempotency_key = 'reminder:unknown:successor'
    `)[0]).toMatchObject({
      status: 'pending',
      attempt: 0,
      provider_message_id: null,
    })
  })

  it('uses one-attempt progress policy and supersedes unsent progress with the final response', async () => {
    const recipient = '5511999000005'
    server.use(http.post(META_MESSAGES_URL, async ({ request }) => {
      capturedPosts.push(await request.json() as CapturedPost)
      return HttpResponse.error()
    }))
    await sendTextThroughOutbox({
      to: recipient,
      text: 'FIFO blocker',
      options: {
        source: 'reminder',
        messageKind: 'reminder',
        idempotencyKey: 'reminder:progress:blocker',
      },
    })
    captureAcceptedPosts()

    const progress = await sendTextThroughOutbox({
      to: recipient,
      text: 'Processando...',
      options: {
        source: 'bot',
        messageKind: 'progress',
        idempotencyKey: 'inbound:progress-story:0',
      },
    })
    expect(progress.status).toBe('pending')
    expect(capturedPosts.filter(
      (post) => post.text.body === 'Processando...',
    )).toHaveLength(0)

    const final = await sendTextThroughOutbox({
      to: recipient,
      text: 'Resposta final',
      options: {
        source: 'bot',
        messageKind: 'terminal',
        idempotencyKey: 'inbound:progress-story:1',
      },
    })

    expect(final.status).toBe('pending')
    expect(capturedPosts).toHaveLength(1)
    expect(capturedPosts.filter(
      (post) => post.text.body === 'Resposta final',
    )).toHaveLength(0)
    expect(adminRows(`
      SELECT idempotency_key, status, attempt, max_attempts, next_attempt_at
      FROM public.outbox_messages
      WHERE idempotency_key IN (
        'inbound:progress-story:0',
        'inbound:progress-story:1'
      )
      ORDER BY sequence_no
    `)).toEqual([
      expect.objectContaining({
        idempotency_key: 'inbound:progress-story:0',
        status: 'superseded',
        attempt: 0,
        max_attempts: 1,
        next_attempt_at: null,
      }),
      expect.objectContaining({
        idempotency_key: 'inbound:progress-story:1',
        status: 'pending',
        attempt: 0,
        max_attempts: 5,
      }),
    ])
  })
})
