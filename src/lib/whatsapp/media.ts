export class MediaTooLargeError extends Error {
  constructor(size: number, maxSize: number) {
    super(`Media size ${size} bytes exceeds limit of ${maxSize} bytes`)
    this.name = 'MediaTooLargeError'
  }
}

export async function downloadWhatsAppMedia(mediaId: string, maxSize?: number): Promise<Buffer> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN
  if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured')

  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!metaRes.ok) throw new Error(`WhatsApp Media API error: ${metaRes.status}`)
  const { url } = (await metaRes.json()) as { url: string }

  const binaryRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!binaryRes.ok) throw new Error(`WhatsApp media download error: ${binaryRes.status}`)

  const arrayBuffer = await binaryRes.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  if (maxSize !== undefined && buffer.length > maxSize) {
    throw new MediaTooLargeError(buffer.length, maxSize)
  }

  return buffer
}
