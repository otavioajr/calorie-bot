interface WhatsAppSendResponse {
  messages: Array<{ id: string }>
}

export async function sendTextMessage(to: string, text: string): Promise<string> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN

  if (!accessToken) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')
  }
  if (!phoneNumberId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured')
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `WhatsApp API error: HTTP ${response.status} — ${errorBody}`,
    )
  }

  const data = (await response.json()) as WhatsAppSendResponse
  return data.messages[0].id
}
