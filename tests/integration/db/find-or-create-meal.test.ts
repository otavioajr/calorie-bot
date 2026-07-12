import { describe, it, expect, beforeEach } from 'vitest'
import { assertLocalSupabaseUrl, getIntegrationSupabase } from '../helpers/supabase-local'
import { assertDomainTablesEmpty, resetIntegrationDb } from '../helpers/db-reset'

type FindOrCreateRow = { meal_id: string; was_append: boolean }

function asRows(data: unknown): FindOrCreateRow {
  const row = (Array.isArray(data) ? data[0] : data) as FindOrCreateRow | null
  if (!row) throw new Error('RPC returned no row')
  return row
}

describe('integration harness', () => {
  it('accepts localhost supabase url', () => {
    expect(() => assertLocalSupabaseUrl('http://127.0.0.1:54321')).not.toThrow()
    expect(() => assertLocalSupabaseUrl('http://localhost:54321')).not.toThrow()
  })

  it('rejects production-like supabase urls', () => {
    expect(() => assertLocalSupabaseUrl('https://db.example.com')).toThrow(/non-local/)
    expect(() => assertLocalSupabaseUrl('https://xyz.supabase.co')).toThrow(/non-local/)
  })

  it('reset leaves meals and processed_messages empty', async () => {
    const supabase = getIntegrationSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seed = await (supabase as any)
      .from('processed_messages')
      .insert({ message_id: 'wamid.harness-seed' })
      .select()
      .single()
    expect(seed.error).toBeNull()
    expect(seed.data?.message_id).toBe('wamid.harness-seed')
    resetIntegrationDb()
    await assertDomainTablesEmpty()
  })
})

describe('find_or_create_meal RPC', () => {
  beforeEach(() => {
    resetIntegrationDb()
  })

  it('creates then appends the same meal for the same user/day/type', async () => {
    const supabase = getIntegrationSupabase()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: user, error: userErr } = await (supabase as any)
      .from('users')
      .insert({ phone: '5511999000001', name: 'Integration User' })
      .select('id')
      .single()
    expect(userErr).toBeNull()
    expect(user?.id).toBeTruthy()

    const dayStart = '2026-07-12T03:00:00.000Z'
    const dayEnd = '2026-07-13T02:59:59.999Z'
    const registeredAt = '2026-07-12T15:00:00.000Z'

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await (supabase as any).rpc('find_or_create_meal', {
      p_user_id: user!.id,
      p_meal_type: 'lunch',
      p_day_start: dayStart,
      p_day_end: dayEnd,
      p_total_calories: 100,
      p_original_message: 'primeira',
      p_llm_response: {},
      p_registered_at: registeredAt,
    })
    expect(first.error).toBeNull()
    const firstRow = asRows(first.data)
    expect(firstRow.was_append).toBe(false)
    expect(firstRow.meal_id).toBeTruthy()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await (supabase as any).rpc('find_or_create_meal', {
      p_user_id: user!.id,
      p_meal_type: 'lunch',
      p_day_start: dayStart,
      p_day_end: dayEnd,
      p_total_calories: 50,
      p_original_message: 'segunda',
      p_llm_response: {},
      p_registered_at: registeredAt,
    })
    expect(second.error).toBeNull()
    const secondRow = asRows(second.data)
    expect(secondRow.was_append).toBe(true)
    expect(secondRow.meal_id).toBe(firstRow.meal_id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const third = await (supabase as any).rpc('find_or_create_meal', {
      p_user_id: user!.id,
      p_meal_type: 'dinner',
      p_day_start: dayStart,
      p_day_end: dayEnd,
      p_total_calories: 200,
      p_original_message: 'jantar',
      p_llm_response: {},
      p_registered_at: registeredAt,
    })
    expect(third.error).toBeNull()
    const thirdRow = asRows(third.data)
    expect(thirdRow.was_append).toBe(false)
    expect(thirdRow.meal_id).not.toBe(firstRow.meal_id)
  })
})
