import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'

const APP_ID = 'test-app-id'
const APP_SECRET = 'test-app-secret'
const ADMIN_PHONE = '5511999999999'
const WEBHOOK_URL = 'https://calorie-bot-theta.vercel.app'
const VERIFY_TOKEN = 'test-verify-token'
const CRON_SECRET = 'test-cron-secret'

beforeAll(() => {
  server.listen()
  vi.stubEnv('META_APP_ID', APP_ID)
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
  vi.stubEnv('ADMIN_PHONE_NUMBER', ADMIN_PHONE)
  vi.stubEnv('WEBHOOK_BASE_URL', WEBHOOK_URL)
  vi.stubEnv('WHATSAPP_VERIFY_TOKEN', VERIFY_TOKEN)
  vi.stubEnv('CRON_SECRET', CRON_SECRET)
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'wa-token')
  // A health alert must bypass durable routing even when outbox configuration
  // is intentionally incomplete during rollback/recovery.
  vi.stubEnv('OUTBOX_MODE', 'active')
  vi.stubEnv('OUTBOX_GENERATION', '')
})
afterEach(() => server.resetHandlers())
afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})

type CronMethod = 'GET' | 'POST'

function request(
  method: CronMethod,
  secret: string = CRON_SECRET,
) {
  return new Request('http://localhost/api/cron/webhook-health', {
    method,
    headers: { authorization: `Bearer ${secret}` },
  })
}

async function callWebhookHealth(method: CronMethod, secret?: string) {
  const { GET, POST } = await import('@/app/api/cron/webhook-health/route')
  const handler = method === 'GET' ? GET : POST
  return handler(request(method, secret))
}

describe('GET and POST /api/cron/webhook-health', () => {
  it('exports GET and POST as the same handler', async () => {
    const { GET, POST } = await import('@/app/api/cron/webhook-health/route')

    expect(GET).toBe(POST)
  })

  it.each<CronMethod>(['GET', 'POST'])(
    'returns 401 for %s without valid CRON_SECRET and skips effects',
    async (method) => {
      let subscriptionChecks = 0
      server.use(
        http.get(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
          subscriptionChecks++
          return HttpResponse.json({ data: [] })
        }),
      )

      const response = await callWebhookHealth(method, 'wrong-secret')

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expect(subscriptionChecks).toBe(0)
    },
  )

  it.each<CronMethod>(['GET', 'POST'])(
    'returns 401 for %s when CRON_SECRET env is unset',
    async (method) => {
      delete process.env.CRON_SECRET

      try {
        const response = await callWebhookHealth(method)

        expect(response.status).toBe(401)
      } finally {
        process.env.CRON_SECRET = CRON_SECRET
      }
    },
  )

  it.each<CronMethod>(['GET', 'POST'])(
    'reports OK for %s when subscription is active with messages field',
    async (method) => {
      let subscriptionChecks = 0
      server.use(
        http.get(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
          subscriptionChecks++
          return HttpResponse.json({
            data: [
              {
                object: 'whatsapp_business_account',
                active: true,
                fields: [{ name: 'messages', version: 'v21.0' }],
              },
            ],
          })
        }),
      )

      const response = await callWebhookHealth(method)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ status: 'ok' })
      expect(subscriptionChecks).toBe(1)
    },
  )

  it('re-registers and alerts admin when subscription is inactive', async () => {
    let reRegistered = false
    let alertSent = false

    server.use(
      http.get(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
        return HttpResponse.json({ data: [] })
      }),
      http.post(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
        reRegistered = true
        return HttpResponse.json({ success: true })
      }),
      http.post('https://graph.facebook.com/v21.0/123456789/messages', async ({ request }) => {
        const body = await request.json() as { to: string; text: { body: string } }
        if (body.to === ADMIN_PHONE) {
          alertSent = true
        }
        return HttpResponse.json({ messages: [{ id: 'wamid.alert' }] })
      }),
    )

    const response = await callWebhookHealth('POST')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('re-registered')
    expect(reRegistered).toBe(true)
    expect(alertSent).toBe(true)
  })

  it('alerts admin with error when re-registration fails', async () => {
    let alertMessage = ''

    server.use(
      http.get(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
        return HttpResponse.json({ data: [] })
      }),
      http.post(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
        return HttpResponse.json(
          { error: { message: 'Invalid OAuth access token', code: 190 } },
          { status: 400 },
        )
      }),
      http.post('https://graph.facebook.com/v21.0/123456789/messages', async ({ request }) => {
        const body = await request.json() as { text: { body: string } }
        alertMessage = body.text.body
        return HttpResponse.json({ messages: [{ id: 'wamid.alert' }] })
      }),
    )

    const response = await callWebhookHealth('POST')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('failed')
    expect(alertMessage).toContain('inativo')
    expect(alertMessage).toContain('manualmente')
  })

  it('detects subscription without messages field as inactive', async () => {
    let reRegistered = false

    server.use(
      http.get(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
        return HttpResponse.json({
          data: [
            {
              object: 'whatsapp_business_account',
              active: true,
              fields: [{ name: 'account_update', version: 'v21.0' }],
            },
          ],
        })
      }),
      http.post(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
        reRegistered = true
        return HttpResponse.json({ success: true })
      }),
      http.post('https://graph.facebook.com/v21.0/123456789/messages', () => {
        return HttpResponse.json({ messages: [{ id: 'wamid.alert' }] })
      }),
    )

    const response = await callWebhookHealth('POST')
    const body = await response.json()

    expect(body.status).toBe('re-registered')
    expect(reRegistered).toBe(true)
  })
})
