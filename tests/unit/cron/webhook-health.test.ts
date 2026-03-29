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
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

async function callWebhookHealth(authHeader?: string) {
  const { POST } = await import('@/app/api/cron/webhook-health/route')
  const request = new Request('http://localhost/api/cron/webhook-health', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  })
  return POST(request)
}

describe('POST /api/cron/webhook-health', () => {
  it('returns 401 without valid CRON_SECRET', async () => {
    const response = await callWebhookHealth('Bearer wrong-secret')
    expect(response.status).toBe(401)
  })

  it('reports OK when subscription is active with messages field', async () => {
    server.use(
      http.get(`https://graph.facebook.com/v21.0/${APP_ID}/subscriptions`, () => {
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

    const response = await callWebhookHealth(`Bearer ${CRON_SECRET}`)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
  })

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

    const response = await callWebhookHealth(`Bearer ${CRON_SECRET}`)
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

    const response = await callWebhookHealth(`Bearer ${CRON_SECRET}`)
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

    const response = await callWebhookHealth(`Bearer ${CRON_SECRET}`)
    const body = await response.json()

    expect(body.status).toBe('re-registered')
    expect(reRegistered).toBe(true)
  })
})
