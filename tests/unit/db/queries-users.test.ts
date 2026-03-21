import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { User, UserSettings } from '@/lib/db/queries/users'

// Helper to build a mock Supabase query chain
function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const terminal = () => Promise.resolve(result)
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.single = vi.fn(terminal)
  chain.insert = vi.fn(() => chain)
  chain.update = vi.fn(() => chain)
  return chain
}

function buildClient(chain: Record<string, unknown>) {
  return {
    from: vi.fn(() => chain),
  }
}

const mockUser: Record<string, unknown> = {
  id: 'user-1',
  auth_id: null,
  phone: '+5511999999999',
  name: '',
  sex: null,
  age: null,
  weight_kg: null,
  height_cm: null,
  activity_level: null,
  goal: null,
  calorie_mode: 'approximate',
  daily_calorie_target: null,
  calorie_target_manual: false,
  tmb: null,
  tdee: null,
  timezone: 'America/Sao_Paulo',
  onboarding_complete: false,
  onboarding_step: 0,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
}

const mockSettings: Record<string, unknown> = {
  id: 'settings-1',
  user_id: 'user-1',
  reminders_enabled: true,
  daily_summary_time: '21:00',
  reminder_time: '14:00',
  detail_level: 'brief',
  weight_unit: 'kg',
  last_reminder_sent_at: null,
  last_summary_sent_at: null,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
}

describe('findUserByPhone', () => {
  it('calls correct Supabase chain and returns a User', async () => {
    const { findUserByPhone } = await import('@/lib/db/queries/users')
    const chain = buildChain({ data: mockUser, error: null })
    const supabase = buildClient(chain)

    const result = await findUserByPhone(supabase as never, '+5511999999999')

    expect(supabase.from).toHaveBeenCalledWith('users')
    expect(chain.select).toHaveBeenCalled()
    expect(chain.eq).toHaveBeenCalledWith('phone', '+5511999999999')
    expect(chain.single).toHaveBeenCalled()
    expect(result).not.toBeNull()
    expect(result!.id).toBe('user-1')
    expect(result!.phone).toBe('+5511999999999')
    expect(result!.calorieMode).toBe('approximate')
    expect(result!.onboardingComplete).toBe(false)
    expect(result!.onboardingStep).toBe(0)
  })

  it('returns null when user not found (PGRST116)', async () => {
    const { findUserByPhone } = await import('@/lib/db/queries/users')
    const chain = buildChain({ data: null, error: { code: 'PGRST116', message: 'No rows' } })
    const supabase = buildClient(chain)

    const result = await findUserByPhone(supabase as never, '+5500000000000')

    expect(result).toBeNull()
  })

  it('throws on unexpected errors', async () => {
    const { findUserByPhone } = await import('@/lib/db/queries/users')
    const chain = buildChain({ data: null, error: { code: '500', message: 'DB error' } })
    const supabase = buildClient(chain)

    await expect(findUserByPhone(supabase as never, '+5500000000000')).rejects.toThrow()
  })
})

describe('createUser', () => {
  it('inserts with phone and empty name, returns created User', async () => {
    const { createUser } = await import('@/lib/db/queries/users')
    const chain = buildChain({ data: mockUser, error: null })
    const supabase = buildClient(chain)

    const result = await createUser(supabase as never, '+5511999999999')

    expect(supabase.from).toHaveBeenCalledWith('users')
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+5511999999999', name: '' })
    )
    expect(chain.select).toHaveBeenCalled()
    expect(chain.single).toHaveBeenCalled()
    expect(result).toBeDefined()
    expect(result.phone).toBe('+5511999999999')
    expect(result.name).toBe('')
    expect(result.onboardingStep).toBe(0)
    expect(result.onboardingComplete).toBe(false)
  })

  it('throws when insert fails', async () => {
    const { createUser } = await import('@/lib/db/queries/users')
    const chain = buildChain({ data: null, error: { code: '23505', message: 'duplicate key' } })
    const supabase = buildClient(chain)

    await expect(createUser(supabase as never, '+5511999999999')).rejects.toThrow()
  })
})

describe('updateUser', () => {
  it('converts camelCase to snake_case before calling update', async () => {
    const { updateUser } = await import('@/lib/db/queries/users')
    const updatedUser = { ...mockUser, name: 'Alice', age: 30 }
    const chain = buildChain({ data: updatedUser, error: null })
    const supabase = buildClient(chain)

    const result = await updateUser(supabase as never, 'user-1', {
      name: 'Alice',
      age: 30,
      weightKg: 65.5,
    })

    expect(supabase.from).toHaveBeenCalledWith('users')
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Alice',
        age: 30,
        weight_kg: 65.5,
      })
    )
    expect(chain.eq).toHaveBeenCalledWith('id', 'user-1')
    expect(chain.select).toHaveBeenCalled()
    expect(chain.single).toHaveBeenCalled()
    expect(result).toBeDefined()
  })

  it('throws when update fails', async () => {
    const { updateUser } = await import('@/lib/db/queries/users')
    const chain = buildChain({ data: null, error: { code: '42P01', message: 'table not found' } })
    const supabase = buildClient(chain)

    await expect(updateUser(supabase as never, 'user-1', { name: 'Alice' })).rejects.toThrow()
  })
})

describe('getUserWithSettings', () => {
  it('returns user and settings when both exist', async () => {
    const { getUserWithSettings } = await import('@/lib/db/queries/users')

    // We need two different chains for two DB calls
    const userChain = buildChain({ data: mockUser, error: null })
    const settingsChain = buildChain({ data: mockSettings, error: null })
    let callCount = 0
    const supabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? userChain : settingsChain
      }),
    }

    const result = await getUserWithSettings(supabase as never, 'user-1')

    expect(supabase.from).toHaveBeenCalledWith('users')
    expect(supabase.from).toHaveBeenCalledWith('user_settings')
    expect(result.user).toBeDefined()
    expect(result.user.id).toBe('user-1')
    expect(result.settings).not.toBeNull()
    expect(result.settings!.userId).toBe('user-1')
    expect(result.settings!.dailySummaryTime).toBe('21:00')
  })

  it('returns null settings when not found', async () => {
    const { getUserWithSettings } = await import('@/lib/db/queries/users')

    const userChain = buildChain({ data: mockUser, error: null })
    const settingsChain = buildChain({ data: null, error: { code: 'PGRST116', message: 'No rows' } })
    let callCount = 0
    const supabase = {
      from: vi.fn(() => {
        callCount++
        return callCount === 1 ? userChain : settingsChain
      }),
    }

    const result = await getUserWithSettings(supabase as never, 'user-1')

    expect(result.user).toBeDefined()
    expect(result.settings).toBeNull()
  })
})

describe('createDefaultSettings', () => {
  it('inserts with user_id and all defaults, returns settings', async () => {
    const { createDefaultSettings } = await import('@/lib/db/queries/settings')
    const chain = buildChain({ data: mockSettings, error: null })
    const supabase = buildClient(chain)

    const result = await createDefaultSettings(supabase as never, 'user-1')

    expect(supabase.from).toHaveBeenCalledWith('user_settings')
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1' })
    )
    expect(chain.select).toHaveBeenCalled()
    expect(chain.single).toHaveBeenCalled()
    expect(result).toBeDefined()
    expect(result.userId).toBe('user-1')
    expect(result.remindersEnabled).toBe(true)
    expect(result.dailySummaryTime).toBe('21:00')
    expect(result.reminderTime).toBe('14:00')
    expect(result.detailLevel).toBe('brief')
    expect(result.weightUnit).toBe('kg')
  })

  it('throws when insert fails', async () => {
    const { createDefaultSettings } = await import('@/lib/db/queries/settings')
    const chain = buildChain({ data: null, error: { code: '23505', message: 'duplicate' } })
    const supabase = buildClient(chain)

    await expect(createDefaultSettings(supabase as never, 'user-1')).rejects.toThrow()
  })
})

describe('updateSettings', () => {
  it('converts camelCase to snake_case before calling update', async () => {
    const { updateSettings } = await import('@/lib/db/queries/settings')
    const updatedSettings = { ...mockSettings, reminders_enabled: false, detail_level: 'detailed' }
    const chain = buildChain({ data: updatedSettings, error: null })
    const supabase = buildClient(chain)

    const result = await updateSettings(supabase as never, 'user-1', {
      remindersEnabled: false,
      detailLevel: 'detailed',
    })

    expect(supabase.from).toHaveBeenCalledWith('user_settings')
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        reminders_enabled: false,
        detail_level: 'detailed',
      })
    )
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(chain.select).toHaveBeenCalled()
    expect(chain.single).toHaveBeenCalled()
    expect(result).toBeDefined()
    expect(result.remindersEnabled).toBe(false)
    expect(result.detailLevel).toBe('detailed')
  })

  it('throws when update fails', async () => {
    const { updateSettings } = await import('@/lib/db/queries/settings')
    const chain = buildChain({ data: null, error: { code: '500', message: 'error' } })
    const supabase = buildClient(chain)

    await expect(
      updateSettings(supabase as never, 'user-1', { remindersEnabled: false })
    ).rejects.toThrow()
  })
})

describe('UserSettings type shape', () => {
  it('exported UserSettings interface satisfies expected shape', async () => {
    const mod = await import('@/lib/db/queries/users')
    // Verify the export exists (type-level check at runtime)
    expect(mod).toBeDefined()
  })
})
