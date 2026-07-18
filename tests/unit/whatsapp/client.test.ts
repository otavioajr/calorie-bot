import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import {
  sendMetaTextMessage,
  type MetaFetch,
} from '@/lib/whatsapp/meta-client'
import {
  sendTextMessage,
  sendTextMessageDirect,
} from '@/lib/whatsapp/client'
import { classifySynchronousFailure } from '@/lib/outbox/policy'

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => server.close())

function configureWhatsApp(): void {
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '123456789')
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token')
}

describe('sendMetaTextMessage', () => {
  it('returns a normalized accepted outcome', async () => {
    configureWhatsApp()
    server.use(
      http.post(
        'https://graph.facebook.com/v21.0/123456789/messages',
        () => HttpResponse.json(
          {
            contacts: [{ wa_id: '5511999887766' }],
            messages: [{ id: 'wamid.accepted' }],
          },
          { headers: { 'x-fb-request-id': 'fb-request-1' } },
        ),
      ),
    )

    await expect(sendMetaTextMessage({
      to: '5511999887766',
      text: 'Hello!',
    })).resolves.toMatchObject({
      kind: 'accepted',
      providerMessageId: 'wamid.accepted',
      recipientId: '5511999887766',
      httpStatus: 200,
      requestId: 'fb-request-1',
    })
  })

  it('sends the exact text payload and bearer token', async () => {
    configureWhatsApp()
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

    await sendMetaTextMessage({ to: '5511999887766', text: 'Hello!' })

    expect(capturedRequest).not.toBeNull()
    const request = capturedRequest as unknown as Request
    expect(request.headers.get('Authorization')).toBe('Bearer test-token')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    await expect(request.json()).resolves.toEqual({
      messaging_product: 'whatsapp',
      to: '5511999887766',
      type: 'text',
      text: { body: 'Hello!' },
    })
  })

  it('includes reply context and opaque callback correlation when provided', async () => {
    configureWhatsApp()
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

    await sendMetaTextMessage({
      to: '5511999887766',
      text: 'Corrigido!',
      replyToMessageId: 'wamid.original123',
      bizOpaqueCallbackData: 'outbox-123',
    })

    expect(capturedBody).toMatchObject({
      context: { message_id: 'wamid.original123' },
      biz_opaque_callback_data: 'outbox-123',
    })
  })

  it('omits optional correlation fields from direct sends', async () => {
    configureWhatsApp()
    let capturedBody: Record<string, unknown> | null = null
    server.use(
      http.post(
        'https://graph.facebook.com/v21.0/123456789/messages',
        async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>
          return HttpResponse.json({ messages: [{ id: 'wamid.direct' }] })
        },
      ),
    )

    await sendMetaTextMessage({ to: '5511999887766', text: 'Direct' })

    expect(capturedBody).not.toHaveProperty('context')
    expect(capturedBody).not.toHaveProperty('biz_opaque_callback_data')
  })

  it.each([
    [429, 130429, 249, 'Rate limited', 'retryable'],
    [503, 2, undefined, 'Temporarily unavailable', 'retryable'],
    [501, undefined, undefined, 'Not implemented', 'failed_terminal'],
    [400, 190, 460, 'Invalid token', 'failed_terminal'],
  ] as const)(
    'normalizes explicit HTTP %s rejection without deciding retry in the client',
    async (httpStatus, metaCode, metaSubcode, message, projection) => {
      configureWhatsApp()
      server.use(
        http.post(
          'https://graph.facebook.com/v21.0/123456789/messages',
          () => HttpResponse.json(
            {
              error: {
                message,
                ...(metaCode === undefined ? {} : { code: metaCode }),
                ...(metaSubcode === undefined
                  ? {}
                  : { error_subcode: metaSubcode }),
              },
            },
            { status: httpStatus },
          ),
        ),
      )

      const outcome = await sendMetaTextMessage({
        to: '5511999887766',
        text: 'Hello!',
      })

      expect(outcome).toMatchObject({
        kind: 'rejected',
        httpStatus,
        ...(metaCode === undefined ? {} : { metaCode }),
        ...(metaSubcode === undefined ? {} : { metaSubcode }),
        message,
      })
      expect(classifySynchronousFailure(outcome)).toMatchObject({ projection })
    },
  )

  it('normalizes a non-JSON HTTP rejection', async () => {
    configureWhatsApp()
    server.use(
      http.post(
        'https://graph.facebook.com/v21.0/123456789/messages',
        () => new HttpResponse('upstream unavailable', { status: 503 }),
      ),
    )

    await expect(sendMetaTextMessage({
      to: '5511999887766',
      text: 'Hello!',
    })).resolves.toMatchObject({
      kind: 'rejected',
      httpStatus: 503,
      message: 'upstream unavailable',
      response: { rawBody: 'upstream unavailable' },
    })
  })

  it.each([429, 503])(
    'keeps HTTP %s rejected when reading the body fails',
    async (status) => {
      configureWhatsApp()
      const fetchImpl = vi.fn<MetaFetch>().mockResolvedValue({
        ok: false,
        status,
        headers: new Headers({ 'x-fb-request-id': 'body-read-failed' }),
        text: vi.fn().mockRejectedValue(new Error('body stream failed')),
      } as unknown as Response)

      const outcome = await sendMetaTextMessage(
        { to: '5511999887766', text: 'Hello!' },
        { fetchImpl },
      )

      expect(outcome).toMatchObject({
        kind: 'rejected',
        httpStatus: status,
        requestId: 'body-read-failed',
        message: 'body stream failed',
      })
      expect(classifySynchronousFailure(outcome).retryable).toBe(true)
    },
  )

  it('keeps a 2xx response unknown when reading the body fails', async () => {
    configureWhatsApp()
    const fetchImpl = vi.fn<MetaFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-fb-request-id': 'body-read-failed' }),
      text: vi.fn().mockRejectedValue(new Error('body stream failed')),
    } as unknown as Response)

    const outcome = await sendMetaTextMessage(
      { to: '5511999887766', text: 'Hello!' },
      { fetchImpl },
    )

    expect(outcome).toMatchObject({
      kind: 'outcome_unknown',
      outcomeUnknown: true,
      httpStatus: 200,
      requestId: 'body-read-failed',
      message: 'body stream failed',
    })
  })

  it.each([
    ['non-JSON body', () => new HttpResponse('accepted maybe', { status: 200 })],
    ['missing messages', () => HttpResponse.json({})],
    ['empty messages', () => HttpResponse.json({ messages: [] })],
    ['empty provider ID', () => HttpResponse.json({ messages: [{ id: '  ' }] })],
  ])('treats malformed 2xx acceptance as unknown: %s', async (_name, response) => {
    configureWhatsApp()
    server.use(
      http.post(
        'https://graph.facebook.com/v21.0/123456789/messages',
        response,
      ),
    )

    const outcome = await sendMetaTextMessage({
      to: '5511999887766',
      text: 'Hello!',
    })

    expect(outcome).toMatchObject({
      kind: 'outcome_unknown',
      outcomeUnknown: true,
      httpStatus: 200,
    })
    expect(classifySynchronousFailure(outcome)).toMatchObject({
      projection: 'unknown',
      retryable: false,
    })
  })

  it('treats a socket failure after starting POST as unknown', async () => {
    configureWhatsApp()
    const fetchImpl = vi.fn<MetaFetch>().mockRejectedValue(
      new TypeError('socket closed'),
    )

    const outcome = await sendMetaTextMessage(
      { to: '5511999887766', text: 'Hello!' },
      { fetchImpl },
    )

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(outcome).toMatchObject({
      kind: 'outcome_unknown',
      outcomeUnknown: true,
      message: 'socket closed',
    })
  })

  it('aborts a timed-out POST and reports unknown', async () => {
    configureWhatsApp()
    vi.useFakeTimers()
    const fetchImpl = vi.fn<MetaFetch>().mockImplementation(
      (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }),
    )

    const pending = sendMetaTextMessage(
      { to: '5511999887766', text: 'Hello!' },
      { fetchImpl, timeoutMs: 50 },
    )
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toMatchObject({
      kind: 'outcome_unknown',
      outcomeUnknown: true,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('keeps the timeout active while reading the response body', async () => {
    configureWhatsApp()
    vi.useFakeTimers()
    const fetchImpl = vi.fn<MetaFetch>().mockImplementation(
      async (_input, init) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('body timed out', 'AbortError'))
          })
        }),
      }) as Response,
    )

    const pending = sendMetaTextMessage(
      { to: '5511999887766', text: 'Hello!' },
      { fetchImpl, timeoutMs: 50 },
    )
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toMatchObject({
      kind: 'outcome_unknown',
      outcomeUnknown: true,
      httpStatus: 200,
      message: expect.stringContaining('body timed out'),
    })
  })

  it('fails configuration before invoking fetch', async () => {
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', '')
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '')
    const fetchImpl = vi.fn<MetaFetch>()

    await expect(sendMetaTextMessage(
      { to: '5511999887766', text: 'Hello!' },
      { fetchImpl },
    )).rejects.toThrow('WHATSAPP_ACCESS_TOKEN is not configured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('sendTextMessageDirect', () => {
  it('preserves the direct accepted-ID contract', async () => {
    configureWhatsApp()
    await expect(sendTextMessageDirect(
      '5511999887766',
      'Health check',
    )).resolves.toBe('wamid.test123')
  })

  it('throws on an explicit direct rejection', async () => {
    configureWhatsApp()
    server.use(
      http.post(
        'https://graph.facebook.com/v21.0/123456789/messages',
        () => HttpResponse.json(
          { error: { message: 'Invalid token', code: 190 } },
          { status: 400 },
        ),
      ),
    )

    await expect(sendTextMessageDirect(
      '5511999887766',
      'Health check',
    )).rejects.toThrow(/WhatsApp API error: HTTP 400.*Invalid token/)
  })

  it('throws without retrying when the direct result is unknown', async () => {
    configureWhatsApp()
    const fetchImpl = vi.fn<MetaFetch>().mockRejectedValue(
      new TypeError('socket closed'),
    )

    await expect(sendTextMessageDirect(
      '5511999887766',
      'Health check',
      undefined,
      { fetchImpl },
    )).rejects.toThrow(/outcome unknown.*socket closed/i)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('sendTextMessage facade', () => {
  it('keeps the positional API source-compatible while outbox mode is off', async () => {
    configureWhatsApp()
    vi.stubEnv('OUTBOX_MODE', 'off')

    await expect(sendTextMessage(
      '5511999887766',
      'Reply',
      'wamid.original',
    )).resolves.toBe('wamid.test123')
  })
})
