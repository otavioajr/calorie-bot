import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock dependencies before importing the module under test ──────────────────

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: vi.fn(),
}))

vi.mock('@/lib/whatsapp/client', () => ({
  sendTextMessage: vi.fn(),
}))

vi.mock('@/lib/db/queries/auth-codes', () => ({
  createAuthCode: vi.fn(),
  verifyAuthCode: vi.fn(),
  countRecentCodes: vi.fn(),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

import { createServiceRoleClient } from '@/lib/db/supabase'
import { sendTextMessage } from '@/lib/whatsapp/client'
import { createAuthCode, verifyAuthCode, countRecentCodes } from '@/lib/db/queries/auth-codes'

const mockCreateServiceRoleClient = vi.mocked(createServiceRoleClient)
const mockSendTextMessage = vi.mocked(sendTextMessage)
const mockCreateAuthCode = vi.mocked(createAuthCode)
const mockVerifyAuthCode = vi.mocked(verifyAuthCode)
const mockCountRecentCodes = vi.mocked(countRecentCodes)

const fakeSupabase = {} as ReturnType<typeof createServiceRoleClient>

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateServiceRoleClient.mockReturnValue(fakeSupabase)
})

// ── generateOTP ───────────────────────────────────────────────────────────────

describe('generateOTP', () => {
  it('returns a 6-digit string', async () => {
    const { generateOTP } = await import('@/lib/auth/otp')
    const code = generateOTP()
    expect(code).toMatch(/^\d{6}$/)
  })

  it('returns different values on repeated calls (non-deterministic)', async () => {
    const { generateOTP } = await import('@/lib/auth/otp')
    const codes = new Set(Array.from({ length: 20 }, () => generateOTP()))
    // With 1,000,000 possible values the chance of all 20 being identical is negligible
    expect(codes.size).toBeGreaterThan(1)
  })
})

// ── sendOTP ───────────────────────────────────────────────────────────────────

describe('sendOTP', () => {
  it('creates a code in the DB and sends a WhatsApp message', async () => {
    mockCountRecentCodes.mockResolvedValue(0)
    mockCreateAuthCode.mockResolvedValue(undefined)
    mockSendTextMessage.mockResolvedValue('msg-id-1')

    const { sendOTP } = await import('@/lib/auth/otp')
    await sendOTP('+5511999999999')

    expect(mockCreateServiceRoleClient).toHaveBeenCalled()
    expect(mockCountRecentCodes).toHaveBeenCalledWith(fakeSupabase, '+5511999999999', 15)
    expect(mockCreateAuthCode).toHaveBeenCalledWith(
      fakeSupabase,
      '+5511999999999',
      expect.stringMatching(/^\d{6}$/),
      expect.any(Date),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '+5511999999999',
      expect.stringContaining('CalorieBot Web'),
    )
    // Verify expira em 5 min is in the message
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '+5511999999999',
      expect.stringContaining('expira em 5 min'),
    )
  })

  it('throws RateLimitError when 3 or more codes have been sent in the last 15 min', async () => {
    mockCountRecentCodes.mockResolvedValue(3)

    const { sendOTP } = await import('@/lib/auth/otp')
    await expect(sendOTP('+5511999999999')).rejects.toThrow(/rate limit/i)

    expect(mockCreateAuthCode).not.toHaveBeenCalled()
    expect(mockSendTextMessage).not.toHaveBeenCalled()
  })

  it('formats the WhatsApp message correctly', async () => {
    mockCountRecentCodes.mockResolvedValue(0)
    mockCreateAuthCode.mockResolvedValue(undefined)
    mockSendTextMessage.mockResolvedValue('msg-id-2')

    const { sendOTP } = await import('@/lib/auth/otp')
    await sendOTP('+5511999999999')

    const [, message] = mockSendTextMessage.mock.calls[0]
    // Should contain the bold code pattern *{code}*
    expect(message).toMatch(/\*\d{6}\*/)
  })
})

// ── verifyOTP ─────────────────────────────────────────────────────────────────

describe('verifyOTP', () => {
  it('returns true for a valid code', async () => {
    mockVerifyAuthCode.mockResolvedValue(true)

    const { verifyOTP } = await import('@/lib/auth/otp')
    const result = await verifyOTP('+5511999999999', '123456')

    expect(mockCreateServiceRoleClient).toHaveBeenCalled()
    expect(mockVerifyAuthCode).toHaveBeenCalledWith(fakeSupabase, '+5511999999999', '123456')
    expect(result).toBe(true)
  })

  it('returns false for a wrong code', async () => {
    mockVerifyAuthCode.mockResolvedValue(false)

    const { verifyOTP } = await import('@/lib/auth/otp')
    const result = await verifyOTP('+5511999999999', '000000')

    expect(result).toBe(false)
  })

  it('returns false for an expired code', async () => {
    // verifyAuthCode checks expiry internally and returns false
    mockVerifyAuthCode.mockResolvedValue(false)

    const { verifyOTP } = await import('@/lib/auth/otp')
    const result = await verifyOTP('+5511999999999', '999999')

    expect(result).toBe(false)
  })

  it('returns false for an already-used code', async () => {
    // verifyAuthCode checks used flag internally and returns false
    mockVerifyAuthCode.mockResolvedValue(false)

    const { verifyOTP } = await import('@/lib/auth/otp')
    const result = await verifyOTP('+5511999999999', '482910')

    expect(result).toBe(false)
  })
})
