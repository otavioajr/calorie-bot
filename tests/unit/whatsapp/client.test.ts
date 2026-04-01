import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { sendTextMessage } from '@/lib/whatsapp/client'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('sendTextMessage', () => {
  it('sends a message and returns the message ID', async () => {
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token')

    const messageId = await sendTextMessage('5511999887766', 'Hello!')

    expect(messageId).toBe('wamid.test123')
  })

  it('sends correct request body and headers', async () => {
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token')

    let capturedRequest: Request | null = null

    server.use(
      http.post(
        'https://graph.facebook.com/v21.0/123456789/messages',
        async ({ request }) => {
          capturedRequest = request.clone()
          return HttpResponse.json({ messages: [{ id: 'wamid.captured' }] })
        },
      ),
    )

    await sendTextMessage('5511999887766', 'Hello!')

    expect(capturedRequest).not.toBeNull()

    const req = capturedRequest as unknown as Request
    expect(req.url).toContain('123456789')
    expect(req.headers.get('Authorization')).toBe('Bearer test-token')
    expect(req.headers.get('Content-Type')).toBe('application/json')

    const body = await req.json() as {
      messaging_product: string
      to: string
      type: string
      text: { body: string }
    }
    expect(body.messaging_product).toBe('whatsapp')
    expect(body.to).toBe('5511999887766')
    expect(body.type).toBe('text')
    expect(body.text.body).toBe('Hello!')
  })

  it('throws a descriptive error on API error response', async () => {
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token')

    server.use(
      http.post('https://graph.facebook.com/v21.0/123456789/messages', () => {
        return HttpResponse.json(
          { error: { message: 'Invalid token', code: 190 } },
          { status: 400 },
        )
      }),
    )

    await expect(sendTextMessage('5511999887766', 'Hello!')).rejects.toThrow(
      /WhatsApp API error/,
    )
  })

  it('includes context when replyToMessageId is provided', async () => {
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token')

    let capturedBody: Record<string, unknown> | null = null

    server.use(
      http.post(
        'https://graph.facebook.com/v21.0/123456789/messages',
        async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>
          return HttpResponse.json({ messages: [{ id: 'wamid.reply' }] })
        },
      ),
    )

    const msgId = await sendTextMessage('5511999887766', 'Corrigido!', 'wamid.original123')

    expect(msgId).toBe('wamid.reply')
    expect(capturedBody).not.toBeNull()
    expect((capturedBody as unknown as Record<string, unknown>).context).toEqual({ message_id: 'wamid.original123' })
  })

  it('does not include context when replyToMessageId is undefined', async () => {
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token')

    let capturedBody: Record<string, unknown> | null = null

    server.use(
      http.post(
        'https://graph.facebook.com/v21.0/123456789/messages',
        async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>
          return HttpResponse.json({ messages: [{ id: 'wamid.noreply' }] })
        },
      ),
    )

    await sendTextMessage('5511999887766', 'Normal message')

    expect(capturedBody).not.toBeNull()
    expect((capturedBody as unknown as Record<string, unknown>).context).toBeUndefined()
  })
})
