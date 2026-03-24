import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Hoist mock variables
// ---------------------------------------------------------------------------
const {
  mockLogWeight,
  mockGetLastWeight,
  mockUpdateUser,
  mockSetState,
  mockFormatWeightUpdate,
} = vi.hoisted(() => {
  return {
    mockLogWeight: vi.fn().mockResolvedValue(undefined),
    mockGetLastWeight: vi.fn().mockResolvedValue(null),
    mockUpdateUser: vi.fn().mockResolvedValue({}),
    mockSetState: vi.fn().mockResolvedValue(undefined),
    mockFormatWeightUpdate: vi.fn().mockReturnValue('Peso registrado! ⚖️\nHoje: 78.5 kg'),
  }
})

vi.mock('@/lib/db/queries/weight', () => ({
  logWeight: mockLogWeight,
  getLastWeight: mockGetLastWeight,
}))

vi.mock('@/lib/db/queries/users', () => ({
  updateUser: mockUpdateUser,
}))

vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatWeightUpdate: mockFormatWeightUpdate,
}))

import { handleWeight } from '@/lib/bot/flows/weight'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-weight-123'

const mockUserBase = {
  id: USER_ID,
  authId: null,
  phone: '+5511999999999',
  name: 'João',
  sex: 'male' as const,
  age: 30,
  weightKg: 80,
  heightCm: 175,
  activityLevel: 'moderate' as const,
  goal: 'lose' as const,
  calorieMode: 'taco' as const,
  dailyCalorieTarget: 2000,
  calorieTargetManual: false,
  tmb: 1750,
  tdee: 2300,
  timezone: 'America/Sao_Paulo',
  onboardingComplete: true,
  onboardingStep: 0,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
}

const mockUserManual = {
  ...mockUserBase,
  calorieTargetManual: true,
}

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleWeight', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockGetLastWeight.mockResolvedValue(null)
    mockUpdateUser.mockResolvedValue({ ...mockUserBase, weightKg: 78.5 })
    mockFormatWeightUpdate.mockReturnValue('Peso registrado! ⚖️\nHoje: 78.5 kg')
  })

  // -------------------------------------------------------------------------
  // Message with weight number
  // -------------------------------------------------------------------------

  describe('message with weight number', () => {
    it('extracts weight from "pesei 78.5" and saves', async () => {
      const result = await handleWeight(supabase, USER_ID, 'pesei 78.5', mockUserBase)

      expect(mockLogWeight).toHaveBeenCalledWith(supabase, USER_ID, 78.5)
      expect(result).toContain('78.5')
    })

    it('extracts weight with comma "76,3" and saves', async () => {
      await handleWeight(supabase, USER_ID, '76,3 kg', mockUserBase)

      expect(mockLogWeight).toHaveBeenCalledWith(supabase, USER_ID, 76.3)
    })

    it('updates user weight_kg after logging', async () => {
      await handleWeight(supabase, USER_ID, 'pesei 78.5', mockUserBase)

      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.objectContaining({ weightKg: 78.5 }),
      )
    })

    it('calls formatWeightUpdate with current and previous weight', async () => {
      mockGetLastWeight.mockResolvedValue({
        weightKg: 80,
        loggedAt: '2024-03-15T10:00:00Z',
      })

      await handleWeight(supabase, USER_ID, 'pesei 78.5', mockUserBase)

      expect(mockFormatWeightUpdate).toHaveBeenCalledWith(
        78.5,
        80,
        expect.any(Number),
      )
    })

    it('calls formatWeightUpdate with null previous when first log', async () => {
      mockGetLastWeight.mockResolvedValue(null)

      await handleWeight(supabase, USER_ID, 'pesei 78.5', mockUserBase)

      expect(mockFormatWeightUpdate).toHaveBeenCalledWith(78.5, null, null)
    })

    it('returns formatted response from formatWeightUpdate', async () => {
      mockFormatWeightUpdate.mockReturnValue('Peso registrado! ⚖️\nHoje: 78.5 kg')

      const result = await handleWeight(supabase, USER_ID, 'pesei 78.5', mockUserBase)

      expect(result).toBe('Peso registrado! ⚖️\nHoje: 78.5 kg')
    })
  })

  // -------------------------------------------------------------------------
  // Message without weight number
  // -------------------------------------------------------------------------

  describe('message without weight number', () => {
    it('returns prompt when no number is given', async () => {
      const result = await handleWeight(supabase, USER_ID, 'quero registrar meu peso', mockUserBase)

      expect(result).toContain('kg')
      expect(mockLogWeight).not.toHaveBeenCalled()
    })

    it('sets awaiting_weight state when no number is given', async () => {
      await handleWeight(supabase, USER_ID, 'pesei', mockUserBase)

      expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'awaiting_weight', expect.any(Object))
    })
  })

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('weight validation', () => {
    it('rejects weight below 30', async () => {
      const result = await handleWeight(supabase, USER_ID, 'pesei 25', mockUserBase)

      expect(mockLogWeight).not.toHaveBeenCalled()
      expect(result).toMatch(/inválido|entre|kg/i)
    })

    it('rejects weight above 300', async () => {
      const result = await handleWeight(supabase, USER_ID, 'pesei 350', mockUserBase)

      expect(mockLogWeight).not.toHaveBeenCalled()
      expect(result).toMatch(/inválido|entre|kg/i)
    })

    it('accepts weight at boundary of 30', async () => {
      await handleWeight(supabase, USER_ID, 'pesei 30', mockUserBase)

      expect(mockLogWeight).toHaveBeenCalledWith(supabase, USER_ID, 30)
    })

    it('accepts weight at boundary of 300', async () => {
      await handleWeight(supabase, USER_ID, 'pesei 300', mockUserBase)

      expect(mockLogWeight).toHaveBeenCalledWith(supabase, USER_ID, 300)
    })
  })

  // -------------------------------------------------------------------------
  // Recalculation
  // -------------------------------------------------------------------------

  describe('TDEE recalculation', () => {
    it('recalculates TDEE when calorieTargetManual is false', async () => {
      await handleWeight(supabase, USER_ID, 'pesei 78.5', mockUserBase)

      // updateUser should be called with new TDEE/calorie targets
      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.objectContaining({
          weightKg: 78.5,
          tmb: expect.any(Number),
          tdee: expect.any(Number),
          dailyCalorieTarget: expect.any(Number),
        }),
      )
    })

    it('skips recalculation when calorieTargetManual is true', async () => {
      await handleWeight(supabase, USER_ID, 'pesei 78.5', mockUserManual)

      // updateUser should only update the weight, not tdee
      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.not.objectContaining({
          tdee: expect.any(Number),
        }),
      )
    })
  })
})
