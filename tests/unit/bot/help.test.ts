import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Hoist mock variables
// ---------------------------------------------------------------------------
const { mockGetUserWithSettings, mockFormatHelpMenu } = vi.hoisted(() => {
  return {
    mockGetUserWithSettings: vi.fn(),
    mockFormatHelpMenu: vi.fn().mockReturnValue('📋 O que posso fazer:\n\n...menu content...'),
  }
})

vi.mock('@/lib/db/queries/users', () => ({
  getUserWithSettings: mockGetUserWithSettings,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatHelpMenu: mockFormatHelpMenu,
}))

import { handleHelp, handleUserData } from '@/lib/bot/flows/help'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-help-123'

const mockUser = {
  id: USER_ID,
  authId: null,
  phone: '+5511999999999',
  name: 'João',
  sex: 'male' as const,
  age: 30,
  weightKg: 75,
  heightCm: 175,
  activityLevel: 'moderate' as const,
  goal: 'maintain' as const,
  calorieMode: 'approximate' as const,
  dailyCalorieTarget: 2000,
  calorieTargetManual: false,
  tmb: 1750,
  tdee: 2100,
  timezone: 'America/Sao_Paulo',
  onboardingComplete: true,
  onboardingStep: 0,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
}

const mockSettings = {
  id: 'settings-1',
  userId: USER_ID,
  remindersEnabled: true,
  dailySummaryTime: '21:00',
  reminderTime: '14:00',
  detailLevel: 'brief' as const,
  weightUnit: 'kg' as const,
  lastReminderSentAt: null,
  lastSummarySentAt: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
}

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleHelp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the help menu', async () => {
    const result = await handleHelp()

    expect(result).toBe('📋 O que posso fazer:\n\n...menu content...')
  })

  it('calls formatHelpMenu', async () => {
    await handleHelp()

    expect(mockFormatHelpMenu).toHaveBeenCalled()
  })
})

describe('handleUserData', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockGetUserWithSettings.mockResolvedValue({ user: mockUser, settings: mockSettings })
  })

  it('fetches user data and returns formatted response', async () => {
    const result = await handleUserData(supabase, USER_ID)

    expect(mockGetUserWithSettings).toHaveBeenCalledWith(supabase, USER_ID)
    expect(result).toContain('João')
  })

  it('includes user stats in the response', async () => {
    const result = await handleUserData(supabase, USER_ID)

    expect(result).toContain('75')
    expect(result).toContain('2000')
  })

  it('handles user without settings gracefully', async () => {
    mockGetUserWithSettings.mockResolvedValue({ user: mockUser, settings: null })

    const result = await handleUserData(supabase, USER_ID)

    expect(result).toBeTruthy()
    expect(result).toContain('João')
  })

  it('includes goal in the response', async () => {
    const result = await handleUserData(supabase, USER_ID)

    expect(result).toMatch(/manter|perder|ganhar|maintain/i)
  })
})
