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
