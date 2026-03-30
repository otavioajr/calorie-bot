# Webhook Health Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect and fix Meta webhook subscription failures so the WhatsApp bot never silently stops receiving messages.

**Architecture:** A single cron endpoint (`/api/cron/webhook-health`) that queries the Meta Graph API to verify the webhook subscription is active, re-registers it if not, and alerts the admin via WhatsApp. Follows the same auth pattern as the existing `/api/cron/reminders` endpoint.

**Tech Stack:** Next.js API Route, Meta Graph API v21.0, MSW for test mocks, Vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/app/api/cron/webhook-health/route.ts` | Cron endpoint: check subscription, re-register if needed, alert admin |
| Create | `tests/unit/cron/webhook-health.test.ts` | Unit tests for all health check scenarios |
| Modify | `vercel.json` | Add second cron job |
| Modify | `.env.example` | Document new env vars |

---

### Task 1: Write tests for webhook health check

**Files:**
- Create: `tests/unit/cron/webhook-health.test.ts`

- [ ] **Step 1: Create test file with all test cases**

```typescript
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

// Dynamic import to pick up stubbed env
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/cron/webhook-health.test.ts`
Expected: FAIL — module `@/app/api/cron/webhook-health/route` not found

---

### Task 2: Implement webhook health check endpoint

**Files:**
- Create: `src/app/api/cron/webhook-health/route.ts`

- [ ] **Step 1: Create the endpoint**

```typescript
import { NextResponse } from 'next/server'
import { sendTextMessage } from '@/lib/whatsapp/client'

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0'

interface SubscriptionField {
  name: string
  version: string
}

interface Subscription {
  object: string
  active: boolean
  fields: SubscriptionField[]
}

interface SubscriptionsResponse {
  data: Subscription[]
}

function getAppAccessToken(): string {
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET must be configured')
  }
  return `${appId}|${appSecret}`
}

async function checkSubscription(): Promise<boolean> {
  const appId = process.env.META_APP_ID!
  const token = getAppAccessToken()

  const response = await fetch(
    `${GRAPH_API_BASE}/${appId}/subscriptions?access_token=${token}`,
  )

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Graph API error checking subscription: HTTP ${response.status} — ${errorBody}`)
  }

  const data = (await response.json()) as SubscriptionsResponse

  const whatsappSub = data.data.find(
    (sub) => sub.object === 'whatsapp_business_account' && sub.active,
  )

  if (!whatsappSub) return false

  return whatsappSub.fields.some((field) => field.name === 'messages')
}

async function reRegisterWebhook(): Promise<void> {
  const appId = process.env.META_APP_ID!
  const token = getAppAccessToken()
  const callbackUrl = `${process.env.WEBHOOK_BASE_URL}/api/webhook/whatsapp`
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN!

  const response = await fetch(`${GRAPH_API_BASE}/${appId}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      callback_url: callbackUrl,
      verify_token: verifyToken,
      fields: 'messages',
      access_token: token,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Graph API error re-registering webhook: HTTP ${response.status} — ${errorBody}`)
  }
}

async function alertAdmin(message: string): Promise<void> {
  const adminPhone = process.env.ADMIN_PHONE_NUMBER
  if (!adminPhone) {
    console.error('[webhook-health] ADMIN_PHONE_NUMBER not configured, cannot send alert')
    return
  }
  await sendTextMessage(adminPhone, message)
}

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const isActive = await checkSubscription()

    if (isActive) {
      console.log('[webhook-health] Subscription OK')
      return NextResponse.json({ status: 'ok' })
    }

    console.warn('[webhook-health] Subscription inactive, attempting re-registration')

    try {
      await reRegisterWebhook()
      console.log('[webhook-health] Re-registration successful')

      const now = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      await alertAdmin(
        `⚠️ O webhook do WhatsApp estava inativo e foi reativado automaticamente às ${now}. Fique atento se as mensagens estão chegando.`,
      )

      return NextResponse.json({ status: 're-registered' })
    } catch (reRegError) {
      const errorMsg = reRegError instanceof Error ? reRegError.message : String(reRegError)
      console.error('[webhook-health] Re-registration failed:', errorMsg)

      await alertAdmin(
        `🚨 O webhook do WhatsApp está inativo e não consegui reativar. Erro: ${errorMsg}. Acesse o painel do Meta para corrigir manualmente.`,
      )

      return NextResponse.json({ status: 'failed', error: errorMsg })
    }
  } catch (error) {
    console.error('[webhook-health] Error:', error)
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/cron/webhook-health.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/webhook-health/route.ts tests/unit/cron/webhook-health.test.ts
git commit -m "feat: add webhook health check cron with auto-re-registration"
```

---

### Task 3: Update configuration files

**Files:**
- Modify: `vercel.json`
- Modify: `.env.example`

- [ ] **Step 1: Add cron job to vercel.json**

Update `vercel.json` to:
```json
{
  "crons": [
    {
      "path": "/api/cron/reminders",
      "schedule": "0 21 * * *"
    },
    {
      "path": "/api/cron/webhook-health",
      "schedule": "0 12 * * *"
    }
  ]
}
```

- [ ] **Step 2: Add new env vars to .env.example**

Add at the end of `.env.example`, after the existing `OPENAI_API_KEY` line:
```env

# Webhook Health Check
ADMIN_PHONE_NUMBER=           # WhatsApp number for admin alerts (e.g. 5511999999999)
META_APP_ID=                  # Meta app ID (from Developer Console)
META_APP_SECRET=              # Meta app secret (Settings > Basic)
```

- [ ] **Step 3: Run full test suite**

Run: `npm run test:unit`
Expected: All tests PASS (existing + new)

- [ ] **Step 4: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add vercel.json .env.example
git commit -m "chore: add webhook-health cron schedule and document new env vars"
```
