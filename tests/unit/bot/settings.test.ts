import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'

// ---------------------------------------------------------------------------
// Hoist mock variables
// ---------------------------------------------------------------------------
const {
  mockUpdateUser,
  mockUpdateSettings,
  mockSetState,
  mockClearState,
  mockFormatSettingsMenu,
  mockResetUserData,
} = vi.hoisted(() => {
  return {
    mockUpdateUser: vi.fn().mockResolvedValue({}),
    mockUpdateSettings: vi.fn().mockResolvedValue({}),
    mockSetState: vi.fn().mockResolvedValue(undefined),
    mockClearState: vi.fn().mockResolvedValue(undefined),
    mockFormatSettingsMenu: vi.fn().mockReturnValue('⚙️ Configurações:\n\n1️⃣ Objetivo...'),
    mockResetUserData: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@/lib/db/queries/users', () => ({
  updateUser: mockUpdateUser,
  resetUserData: mockResetUserData,
}))

vi.mock('@/lib/db/queries/settings', () => ({
  updateSettings: mockUpdateSettings,
}))

vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: mockClearState,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatSettingsMenu: mockFormatSettingsMenu,
}))

import { handleSettings } from '@/lib/bot/flows/settings'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-settings-123'

const mockUser = {
  id: USER_ID,
  authId: null,
  phone: '+5511999999999',
  name: 'João',
  sex: 'male' as const,
  age: 30,
  weightKg: 80,
  heightCm: 175,
  activityLevel: 'moderate' as const,
  goal: 'maintain' as const,
  calorieMode: 'taco' as const,
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

function buildSettingsMenuContext(): ConversationContext {
  return {
    id: 'ctx-1',
    userId: USER_ID,
    contextType: 'settings_menu',
    contextData: {},
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

function buildResetConfirmationContext(): ConversationContext {
  return {
    id: 'ctx-reset',
    userId: USER_ID,
    contextType: 'awaiting_reset_confirmation',
    contextData: {},
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

function buildSettingsChangeContext(option: number, field: string): ConversationContext {
  return {
    id: 'ctx-2',
    userId: USER_ID,
    contextType: 'settings_change',
    contextData: {
      option,
      field,
    },
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSettings', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockUpdateUser.mockResolvedValue(mockUser)
    mockUpdateSettings.mockResolvedValue(mockSettings)
    mockFormatSettingsMenu.mockReturnValue('⚙️ Configurações:\n\n1️⃣ Objetivo...')
  })

  // -------------------------------------------------------------------------
  // No context — show settings menu
  // -------------------------------------------------------------------------

  describe('no context — show settings menu', () => {
    it('returns settings menu when no context', async () => {
      const result = await handleSettings(supabase, USER_ID, 'config', mockUser, mockSettings, null)

      expect(mockFormatSettingsMenu).toHaveBeenCalled()
      expect(result).toContain('⚙️ Configurações')
    })

    it('sets settings_menu state', async () => {
      await handleSettings(supabase, USER_ID, 'config', mockUser, mockSettings, null)

      expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'settings_menu', expect.any(Object))
    })

    it('passes current values to formatSettingsMenu', async () => {
      await handleSettings(supabase, USER_ID, 'config', mockUser, mockSettings, null)

      expect(mockFormatSettingsMenu).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: expect.any(String),
          calorieMode: expect.any(String),
          dailyTarget: expect.any(Number),
          remindersEnabled: expect.any(Boolean),
          detailLevel: expect.any(String),
        }),
      )
    })

    it('uses defaults when settings is null', async () => {
      const result = await handleSettings(supabase, USER_ID, 'config', mockUser, null, null)

      expect(mockFormatSettingsMenu).toHaveBeenCalled()
      expect(result).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // settings_menu context + number — show sub-menu
  // -------------------------------------------------------------------------

  describe('settings_menu context + number', () => {
    it('handles option 1 (goal) — shows sub-menu', async () => {
      const context = buildSettingsMenuContext()
      const result = await handleSettings(supabase, USER_ID, '1', mockUser, mockSettings, context)

      expect(result).toMatch(/objetivo|perder|manter|ganhar/i)
      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'settings_change',
        expect.objectContaining({ option: 1, field: 'goal' }),
      )
    })

    it('handles option 2 (mode) — shows sub-menu', async () => {
      const context = buildSettingsMenuContext()
      const result = await handleSettings(supabase, USER_ID, '2', mockUser, mockSettings, context)

      expect(result).toMatch(/modo|aproximado|taco|manual/i)
      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'settings_change',
        expect.objectContaining({ option: 2, field: 'calorieMode' }),
      )
    })

    it('handles option 3 (calorie target) — shows sub-menu', async () => {
      const context = buildSettingsMenuContext()
      const result = await handleSettings(supabase, USER_ID, '3', mockUser, mockSettings, context)

      expect(result).toMatch(/meta|kcal|calorias/i)
      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'settings_change',
        expect.objectContaining({ option: 3, field: 'dailyCalorieTarget' }),
      )
    })

    it('handles option 7 (web link)', async () => {
      const context = buildSettingsMenuContext()
      const result = await handleSettings(supabase, USER_ID, '7', mockUser, mockSettings, context)

      expect(result).toMatch(/https?:\/\/|link|web|painel/i)
    })

    it('handles invalid option gracefully', async () => {
      const context = buildSettingsMenuContext()
      const result = await handleSettings(supabase, USER_ID, '99', mockUser, mockSettings, context)

      expect(result).toMatch(/opção|inválid|1.*8/i)
    })
  })

  // -------------------------------------------------------------------------
  // settings_change context + value — update setting
  // -------------------------------------------------------------------------

  describe('settings_change context + value', () => {
    it('updates goal to "lose" on "1" or "perder"', async () => {
      const context = buildSettingsChangeContext(1, 'goal')
      await handleSettings(supabase, USER_ID, '1', mockUser, mockSettings, context)

      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.objectContaining({ goal: 'lose' }),
      )
    })

    it('updates goal to "maintain" on "2" or "manter"', async () => {
      const context = buildSettingsChangeContext(1, 'goal')
      await handleSettings(supabase, USER_ID, '2', mockUser, mockSettings, context)

      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.objectContaining({ goal: 'maintain' }),
      )
    })

    it('updates goal to "gain" on "3" or "ganhar"', async () => {
      const context = buildSettingsChangeContext(1, 'goal')
      await handleSettings(supabase, USER_ID, '3', mockUser, mockSettings, context)

      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.objectContaining({ goal: 'gain' }),
      )
    })

    it('updates calorieMode to "taco" on "1"', async () => {
      const context = buildSettingsChangeContext(2, 'calorieMode')
      await handleSettings(supabase, USER_ID, '1', mockUser, mockSettings, context)

      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.objectContaining({ calorieMode: 'taco' }),
      )
    })

    it('updates calorieMode to "manual" on "2"', async () => {
      const context = buildSettingsChangeContext(2, 'calorieMode')
      await handleSettings(supabase, USER_ID, '2', mockUser, mockSettings, context)

      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.objectContaining({ calorieMode: 'manual' }),
      )
    })

    it('updates dailyCalorieTarget on "3" option with valid number', async () => {
      const context = buildSettingsChangeContext(3, 'dailyCalorieTarget')
      await handleSettings(supabase, USER_ID, '1800', mockUser, mockSettings, context)

      expect(mockUpdateUser).toHaveBeenCalledWith(
        supabase,
        USER_ID,
        expect.objectContaining({
          dailyCalorieTarget: 1800,
          calorieTargetManual: true,
        }),
      )
    })

    it('returns confirmation after update', async () => {
      const context = buildSettingsChangeContext(1, 'goal')
      const result = await handleSettings(supabase, USER_ID, '1', mockUser, mockSettings, context)

      expect(result).toMatch(/atualizado|salvo|✅/i)
    })

    it('clears state after update', async () => {
      const context = buildSettingsChangeContext(1, 'goal')
      await handleSettings(supabase, USER_ID, '1', mockUser, mockSettings, context)

      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
    })

    it('rejects invalid target calories', async () => {
      const context = buildSettingsChangeContext(3, 'dailyCalorieTarget')
      const result = await handleSettings(supabase, USER_ID, 'abc', mockUser, mockSettings, context)

      expect(mockUpdateUser).not.toHaveBeenCalled()
      expect(result).toMatch(/inválido|número|kcal/i)
    })
  })

  // -------------------------------------------------------------------------
  // option 8 — reset data
  // -------------------------------------------------------------------------

  describe('option 8 — reset data', () => {
    it('shows confirmation prompt when option 8 is selected', async () => {
      const context = buildSettingsMenuContext()
      const result = await handleSettings(supabase, USER_ID, '8', mockUser, mockSettings, context)

      expect(result).toMatch(/apagar/)
      expect(result).toMatch(/SIM/)
      expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'awaiting_reset_confirmation', {})
    })

    it('executes reset when user confirms with "sim"', async () => {
      const context = buildResetConfirmationContext()
      const result = await handleSettings(supabase, USER_ID, 'sim', mockUser, mockSettings, context)

      expect(mockResetUserData).toHaveBeenCalledWith(supabase, USER_ID)
      expect(result).toMatch(/apagados/i)
      expect(result).toMatch(/recomeçar/i)
    })

    it('executes reset when user confirms with "SIM"', async () => {
      const context = buildResetConfirmationContext()
      const result = await handleSettings(supabase, USER_ID, 'SIM', mockUser, mockSettings, context)

      expect(mockResetUserData).toHaveBeenCalledWith(supabase, USER_ID)
    })

    it('cancels reset when user sends anything other than "sim"', async () => {
      const context = buildResetConfirmationContext()
      const result = await handleSettings(supabase, USER_ID, 'não', mockUser, mockSettings, context)

      expect(mockResetUserData).not.toHaveBeenCalled()
      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
      expect(result).toMatch(/cancelado|intactos/i)
    })
  })
})
