import { http, HttpResponse } from 'msw'

export type CapturedMetaMessage = {
  url: string
  body: unknown
}

/** Mutable capture buffer — reset between tests via `clearCapturedMetaMessages()`. */
export const capturedMetaMessages: CapturedMetaMessage[] = []

export function clearCapturedMetaMessages(): void {
  capturedMetaMessages.length = 0
}

export const handlers = [
  // WhatsApp Meta API mock — send message
  http.post('https://graph.facebook.com/v21.0/*/messages', async ({ request }) => {
    const body = await request.json()
    capturedMetaMessages.push({ url: request.url, body })
    return HttpResponse.json({ messages: [{ id: 'wamid.test123' }] })
  }),
]
