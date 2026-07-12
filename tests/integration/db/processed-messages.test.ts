import { describe, it, expect, beforeEach } from 'vitest'
import { getIntegrationSupabase } from '../helpers/supabase-local'
import { resetIntegrationDb } from '../helpers/db-reset'

describe('processed_messages', () => {
  beforeEach(() => {
    resetIntegrationDb()
  })

  it('accepts a new message_id and rejects duplicates (PRIMARY KEY)', async () => {
    const supabase = getIntegrationSupabase()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await (supabase as any)
      .from('processed_messages')
      .insert({ message_id: 'wamid.dedup-1' })
      .select()
      .single()
    expect(first.error).toBeNull()
    expect(first.data.message_id).toBe('wamid.dedup-1')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await (supabase as any)
      .from('processed_messages')
      .insert({ message_id: 'wamid.dedup-1' })
      .select()
      .single()
    expect(second.error).toBeTruthy()
    expect(second.error.code).toBe('23505')
  })
})
