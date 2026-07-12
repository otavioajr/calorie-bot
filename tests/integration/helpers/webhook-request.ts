import { signWebhookBody } from '@/lib/whatsapp/webhook'

const DEFAULT_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID ?? '000000000000000'

export function buildTextWebhookPayload(options: {
  messageId: string
  from?: string
  text?: string
  phoneNumberId?: string
  extraMessages?: Array<{ id: string; from?: string; text?: string }>
}) {
  const phoneNumberId = options.phoneNumberId ?? DEFAULT_PHONE_NUMBER_ID
  const messages = [
    {
      from: options.from ?? '5511999887766',
      id: options.messageId,
      timestamp: '1710000000',
      type: 'text' as const,
      text: { body: options.text ?? 'oi' },
    },
    ...(options.extraMessages ?? []).map((m) => ({
      from: m.from ?? '5511999887766',
      id: m.id,
      timestamp: '1710000001',
      type: 'text' as const,
      text: { body: m.text ?? 'oi' },
    })),
  ]

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'BIZ_ACCOUNT_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              messages,
            },
            field: 'messages',
          },
        ],
      },
    ],
  }
}

export function buildSignedWebhookRequest(
  body: unknown,
  appSecret = process.env.META_APP_SECRET ?? 'test-meta-app-secret',
): Request {
  const rawBody = JSON.stringify(body)
  const signature = signWebhookBody(rawBody, appSecret)
  return new Request('http://localhost/api/webhook/whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': signature,
    },
    body: rawBody,
  })
}
