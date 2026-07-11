import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSendTextMessage } = vi.hoisted(() => ({
  mockSendTextMessage: vi.fn().mockResolvedValue('sent-id'),
}))

vi.mock('@/lib/whatsapp/client', () => ({
  sendTextMessage: mockSendTextMessage,
}))

import { handleUnsupportedMessage } from '@/lib/bot/handler'

describe('handleUnsupportedMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends video-specific guidance', async () => {
    await handleUnsupportedMessage('5511999887766', 'video')
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '5511999887766',
      expect.stringContaining('vídeo'),
    )
  })

  it('sends generic guidance for unknown raw types', async () => {
    await handleUnsupportedMessage('5511999887766', 'foo_bar')
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '5511999887766',
      expect.stringContaining('Ainda não consigo processar'),
    )
  })
})
