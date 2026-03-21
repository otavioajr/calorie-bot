import { http, HttpResponse } from 'msw'

export const handlers = [
  // WhatsApp Meta API mock — send message
  http.post('https://graph.facebook.com/v21.0/*/messages', () => {
    return HttpResponse.json({ messages: [{ id: 'wamid.test123' }] })
  }),
]
