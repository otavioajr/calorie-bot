import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Hoist mock variables so they are available at vi.mock() factory call time
// ---------------------------------------------------------------------------
const { mockSetState, mockClearState, mockUpdateUser, mockGetUserWithSettings, mockCreateDefaultSettings } = vi.hoisted(() => ({
  mockSetState: vi.fn().mockResolvedValue(undefined),
  mockClearState: vi.fn().mockResolvedValue(undefined),
  mockUpdateUser: vi.fn(),
  mockGetUserWithSettings: vi.fn(),
  mockCreateDefaultSettings: vi.fn().mockResolvedValue({}),
}))

// ---------------------------------------------------------------------------
// Mock @/lib/bot/state — setState and clearState are side effects we spy on
// ---------------------------------------------------------------------------
vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: mockClearState,
}))

// ---------------------------------------------------------------------------
// Mock @/lib/db/queries/users — updateUser and getUserWithSettings
// ---------------------------------------------------------------------------
vi.mock('@/lib/db/queries/users', () => ({
  updateUser: mockUpdateUser,
  getUserWithSettings: mockGetUserWithSettings,
}))

// ---------------------------------------------------------------------------
// Mock @/lib/db/queries/settings — createDefaultSettings
// ---------------------------------------------------------------------------
vi.mock('@/lib/db/queries/settings', () => ({
  createDefaultSettings: mockCreateDefaultSettings,
}))

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { handleOnboarding } from '@/lib/bot/flows/onboarding'
import type { OnboardingResult } from '@/lib/bot/flows/onboarding'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-onboarding-123'

// A minimal mock Supabase client that supports the weight_log insert used in
// step 4. All higher-level DB calls (updateUser, getUserWithSettings, etc.)
// are intercepted by module-level vi.mock(), so the client only needs to
// satisfy the direct `supabase.from('weight_log').insert(...)` call.
function buildDefaultSupabase(): SupabaseClient {
  const insertChain = {
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: { id: 'wl-1' }, error: null }),
    }),
  }
  return {
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnValue(insertChain),
    }),
  } as unknown as SupabaseClient
}

let supabase: SupabaseClient

// A fully-populated mock user returned by getUserWithSettings at step 8.
const mockFullUser = {
  id: USER_ID,
  name: 'João',
  age: 28,
  sex: 'male' as const,
  weightKg: 72.5,
  heightCm: 175,
  activityLevel: 'moderate' as const,
  goal: 'lose' as const,
  calorieMode: 'approximate' as const,
  phone: '+5511999999999',
  authId: null,
  dailyCalorieTarget: null,
  calorieTargetManual: false,
  tmb: null,
  tdee: null,
  timezone: 'America/Sao_Paulo',
  onboardingComplete: false,
  onboardingStep: 7,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()

  // Fresh supabase mock per test (needed for weight_log insert in step 4)
  supabase = buildDefaultSupabase()

  // Default: updateUser returns a resolved promise with the user
  mockUpdateUser.mockResolvedValue({ ...mockFullUser })
  // Default for step 8: getUserWithSettings returns the full user
  mockGetUserWithSettings.mockResolvedValue({ user: { ...mockFullUser }, settings: null })
})

// ---------------------------------------------------------------------------
// Step 0 — Welcome message
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 0 (welcome)', () => {
  it('returns a response containing "CalorieBot"', async () => {
    const result: OnboardingResult = await handleOnboarding(supabase, USER_ID, 'oi', 0)

    expect(result.response).toContain('CalorieBot')
  })

  it('sets completed: false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, 'oi', 0)

    expect(result.completed).toBe(false)
  })

  it('calls setState with step 1', async () => {
    await handleOnboarding(supabase, USER_ID, 'oi', 0)

    expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'onboarding', expect.objectContaining({ step: 1 }))
  })

  it('calls updateUser with onboardingStep: 1', async () => {
    await handleOnboarding(supabase, USER_ID, 'oi', 0)

    expect(mockUpdateUser).toHaveBeenCalledWith(supabase, USER_ID, expect.objectContaining({ onboardingStep: 1 }))
  })

  it('asks for the user name in the response', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '', 0)

    expect(result.response.toLowerCase()).toMatch(/nome/)
  })
})

// ---------------------------------------------------------------------------
// Step 1 — Name input
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 1 (name)', () => {
  it('valid name: response contains "Prazer, João"', async () => {
    const result = await handleOnboarding(supabase, USER_ID, 'João', 1)

    expect(result.response).toContain('Prazer, João')
  })

  it('valid name: completed is false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, 'João', 1)

    expect(result.completed).toBe(false)
  })

  it('valid name: calls updateUser with name and onboardingStep: 2', async () => {
    await handleOnboarding(supabase, USER_ID, 'João', 1)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ name: 'João', onboardingStep: 2 }),
    )
  })

  it('valid name: calls setState with step: 2 and name', async () => {
    await handleOnboarding(supabase, USER_ID, 'João', 1)

    expect(mockSetState).toHaveBeenCalledWith(
      USER_ID,
      'onboarding',
      expect.objectContaining({ step: 2, name: 'João' }),
    )
  })

  it('invalid name (single char): returns error, completed false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, 'A', 1)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('2 caracteres')
  })

  it('invalid name (contains number): returns error', async () => {
    const result = await handleOnboarding(supabase, USER_ID, 'Jo4o', 1)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('números')
  })

  it('invalid name: does NOT call updateUser', async () => {
    await handleOnboarding(supabase, USER_ID, 'A', 1)

    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('asks for age in the next prompt', async () => {
    const result = await handleOnboarding(supabase, USER_ID, 'Maria', 1)

    expect(result.response.toLowerCase()).toMatch(/anos/)
  })
})

// ---------------------------------------------------------------------------
// Step 2 — Age input
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 2 (age)', () => {
  it('valid age: response mentions sex options (Masculino)', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '28', 2)

    expect(result.response).toContain('Masculino')
  })

  it('valid age: completed is false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '28', 2)

    expect(result.completed).toBe(false)
  })

  it('valid age: calls updateUser with age and onboardingStep: 3', async () => {
    await handleOnboarding(supabase, USER_ID, '28', 2)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ age: 28, onboardingStep: 3 }),
    )
  })

  it('valid age: calls setState with step: 3 and age', async () => {
    await handleOnboarding(supabase, USER_ID, '28', 2)

    expect(mockSetState).toHaveBeenCalledWith(
      USER_ID,
      'onboarding',
      expect.objectContaining({ step: 3, age: 28 }),
    )
  })

  it('invalid age (text): returns error, completed false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, 'vinte', 2)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('inteiro')
  })

  it('invalid age (too young): returns error', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '5', 2)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('12')
  })

  it('invalid age: does NOT call updateUser', async () => {
    await handleOnboarding(supabase, USER_ID, 'abc', 2)

    expect(mockUpdateUser).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Step 3 — Sex input
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 3 (sex)', () => {
  it('valid sex "1" (male): response asks for weight (peso)', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '1', 3)

    expect(result.response.toLowerCase()).toContain('peso')
  })

  it('valid sex "2" (female): completed is false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '2', 3)

    expect(result.completed).toBe(false)
  })

  it('valid sex "1": calls updateUser with sex: "male" and onboardingStep: 4', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 3)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ sex: 'male', onboardingStep: 4 }),
    )
  })

  it('valid sex "feminino": calls updateUser with sex: "female"', async () => {
    await handleOnboarding(supabase, USER_ID, 'feminino', 3)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ sex: 'female' }),
    )
  })

  it('valid sex: calls setState with step: 4 and sex', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 3)

    expect(mockSetState).toHaveBeenCalledWith(
      USER_ID,
      'onboarding',
      expect.objectContaining({ step: 4, sex: 'male' }),
    )
  })

  it('invalid sex: returns error, completed false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, 'talvez', 3)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('1')
  })

  it('invalid sex: does NOT call updateUser', async () => {
    await handleOnboarding(supabase, USER_ID, 'x', 3)

    expect(mockUpdateUser).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Step 4 — Weight input
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 4 (weight)', () => {
  it('valid weight: response asks for height (altura)', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '72.5', 4)

    expect(result.response.toLowerCase()).toContain('altura')
  })

  it('valid weight: completed is false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '72.5', 4)

    expect(result.completed).toBe(false)
  })

  it('valid weight: calls updateUser with weightKg and onboardingStep: 5', async () => {
    await handleOnboarding(supabase, USER_ID, '72.5', 4)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ weightKg: 72.5, onboardingStep: 5 }),
    )
  })

  it('valid weight: calls setState with step: 5 and weightKg', async () => {
    await handleOnboarding(supabase, USER_ID, '72.5', 4)

    expect(mockSetState).toHaveBeenCalledWith(
      USER_ID,
      'onboarding',
      expect.objectContaining({ step: 5, weightKg: 72.5 }),
    )
  })

  it('valid weight with comma separator: parses correctly', async () => {
    await handleOnboarding(supabase, USER_ID, '72,5', 4)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ weightKg: 72.5 }),
    )
  })

  it('invalid weight (too low): returns error', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '10', 4)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('30')
  })

  it('invalid weight: does NOT call updateUser', async () => {
    await handleOnboarding(supabase, USER_ID, 'abc', 4)

    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('valid weight: also inserts a weight_log entry via supabase', async () => {
    // We spy on a mock supabase from-chain to verify weight_log insertion
    const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'wl-1' }, error: null })
    const mockChain = {
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: mockSingle,
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({ single: mockSingle }),
        }),
      }),
    }
    const spySupabase = {
      from: vi.fn().mockReturnValue(mockChain),
    } as unknown as SupabaseClient

    mockUpdateUser.mockResolvedValue({ ...mockFullUser, weightKg: 72.5 })

    await handleOnboarding(spySupabase, USER_ID, '72.5', 4)

    // weight_log table should be called
    expect(spySupabase.from).toHaveBeenCalledWith('weight_log')
    expect(mockChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        weight_kg: 72.5,
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Step 5 — Height input
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 5 (height)', () => {
  it('valid height: response asks for activity level', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '175', 5)

    expect(result.response.toLowerCase()).toMatch(/atividade|sedent/)
  })

  it('valid height: completed is false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '175', 5)

    expect(result.completed).toBe(false)
  })

  it('valid height: calls updateUser with heightCm and onboardingStep: 6', async () => {
    await handleOnboarding(supabase, USER_ID, '175', 5)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ heightCm: 175, onboardingStep: 6 }),
    )
  })

  it('valid height: calls setState with step: 6 and heightCm', async () => {
    await handleOnboarding(supabase, USER_ID, '175', 5)

    expect(mockSetState).toHaveBeenCalledWith(
      USER_ID,
      'onboarding',
      expect.objectContaining({ step: 6, heightCm: 175 }),
    )
  })

  it('invalid height (decimal): returns error', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '175.5', 5)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('inteiro')
  })

  it('invalid height (too short): returns error', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '50', 5)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('100')
  })
})

// ---------------------------------------------------------------------------
// Step 6 — Activity level input
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 6 (activity level)', () => {
  it('valid activity "1" (sedentary): response asks for goal', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '1', 6)

    expect(result.response.toLowerCase()).toMatch(/objetivo|perder|manter|ganhar/)
  })

  it('valid activity "3" (moderate): completed is false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '3', 6)

    expect(result.completed).toBe(false)
  })

  it('valid activity "2": calls updateUser with activityLevel: "light" and onboardingStep: 7', async () => {
    await handleOnboarding(supabase, USER_ID, '2', 6)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ activityLevel: 'light', onboardingStep: 7 }),
    )
  })

  it('valid activity: calls setState with step: 7 and activityLevel', async () => {
    await handleOnboarding(supabase, USER_ID, '3', 6)

    expect(mockSetState).toHaveBeenCalledWith(
      USER_ID,
      'onboarding',
      expect.objectContaining({ step: 7, activityLevel: 'moderate' }),
    )
  })

  it('invalid activity: returns error, completed false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '5', 6)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('sedentário')
  })
})

// ---------------------------------------------------------------------------
// Step 7 — Goal input
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 7 (goal)', () => {
  it('valid goal "1" (lose): response asks for calorie mode', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '1', 7)

    expect(result.response.toLowerCase()).toMatch(/calorias|taco|manual|aproximado/)
  })

  it('valid goal "2" (maintain): completed is false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '2', 7)

    expect(result.completed).toBe(false)
  })

  it('valid goal "3" (gain): calls updateUser with goal: "gain" and onboardingStep: 8', async () => {
    await handleOnboarding(supabase, USER_ID, '3', 7)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ goal: 'gain', onboardingStep: 8 }),
    )
  })

  it('valid goal: calls setState with step: 8 and goal', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 7)

    expect(mockSetState).toHaveBeenCalledWith(
      USER_ID,
      'onboarding',
      expect.objectContaining({ step: 8, goal: 'lose' }),
    )
  })

  it('invalid goal: returns error, completed false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '4', 7)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('perder')
  })
})

// ---------------------------------------------------------------------------
// Step 8 — Calorie mode input + finalization
// ---------------------------------------------------------------------------

describe('handleOnboarding — step 8 (calorie mode + finalization)', () => {
  it('valid mode "1": completed is true', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(result.completed).toBe(true)
  })

  it('valid mode "1": response contains "Tudo pronto"', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(result.response).toContain('Tudo pronto')
  })

  it('valid mode "1": response contains the user name', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '1', 8)

    // formatOnboardingComplete includes "Tudo pronto, {name}!"
    expect(result.response).toContain('João')
  })

  it('valid mode "1" (taco): updateUser called with calorieMode: "taco"', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ calorieMode: 'taco' }),
    )
  })

  it('valid mode: updateUser called with tmb, tdee, dailyCalorieTarget', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({
        tmb: expect.any(Number),
        tdee: expect.any(Number),
        dailyCalorieTarget: expect.any(Number),
      }),
    )
  })

  it('valid mode: updateUser called with onboardingComplete: true and onboardingStep: 8', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({
        onboardingComplete: true,
        onboardingStep: 8,
      }),
    )
  })

  it('valid mode: createDefaultSettings is called with the userId', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockCreateDefaultSettings).toHaveBeenCalledWith(supabase, USER_ID)
  })

  it('valid mode: clearState is called with the userId', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockClearState).toHaveBeenCalledWith(USER_ID)
  })

  it('valid mode: getUserWithSettings is called to fetch user data for calculations', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockGetUserWithSettings).toHaveBeenCalledWith(supabase, USER_ID)
  })

  it('tmb/tdee values are calculated correctly from mock user data', async () => {
    // For João: male, 72.5kg, 175cm, age 28, moderate, lose
    // TMB = 10*72.5 + 6.25*175 - 5*28 + 5 = 725 + 1093.75 - 140 + 5 = 1683.75
    // TDEE = 1683.75 * 1.55 = 2609.81
    // dailyTarget = 2609.81 - 500 = 2109.81
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({
        tmb: 1683.75,
        tdee: 2609.81,
        dailyCalorieTarget: 2110,
      }),
    )
  })

  it('invalid mode: returns error, completed false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '5', 8)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('TACO')
  })

  it('invalid mode: does NOT call createDefaultSettings', async () => {
    await handleOnboarding(supabase, USER_ID, 'xyz', 8)

    expect(mockCreateDefaultSettings).not.toHaveBeenCalled()
  })

  it('invalid mode: does NOT call clearState', async () => {
    await handleOnboarding(supabase, USER_ID, 'xyz', 8)

    expect(mockClearState).not.toHaveBeenCalled()
  })

  it('valid mode "2" (manual): completed true', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '2', 8)

    expect(result.completed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('handleOnboarding — edge cases', () => {
  it('step 0: welcome message mentions perguntas or configurar', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '', 0)

    expect(result.response.toLowerCase()).toMatch(/perguntas|configur/)
  })

  it('step 1: whitespace-only name returns error', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '   ', 1)

    expect(result.completed).toBe(false)
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('step 2: decimal age returns error', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '25.5', 2)

    expect(result.completed).toBe(false)
  })

  it('step 4: weight exactly at lower bound (30) is valid', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '30', 4)

    expect(result.completed).toBe(false)
    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ weightKg: 30 }),
    )
  })

  it('step 5: height exactly at upper bound (250) is valid', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '250', 5)

    expect(result.completed).toBe(false)
    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ heightCm: 250 }),
    )
  })
})
