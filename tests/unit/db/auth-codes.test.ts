import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createAuthCode } from '@/lib/db/queries/auth-codes'

function clientReturning(
  result: { data: { id?: unknown } | null; error: { message: string } | null },
) {
  const single = vi.fn().mockResolvedValue(result)
  const select = vi.fn().mockReturnValue({ single })
  const insert = vi.fn().mockReturnValue({ select })
  const from = vi.fn().mockReturnValue({ insert })
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    insert,
    select,
    single,
  }
}

describe('createAuthCode', () => {
  it('returns the generated durable auth-code ID', async () => {
    const fixture = clientReturning({
      data: { id: '10000000-0000-4000-8000-000000000001' },
      error: null,
    })
    const expiresAt = new Date('2026-07-13T21:05:00.000Z')

    const id = await createAuthCode(
      fixture.client,
      '5511999999999',
      '123456',
      expiresAt,
    )

    expect(id).toBe('10000000-0000-4000-8000-000000000001')
    expect(fixture.from).toHaveBeenCalledWith('auth_codes')
    expect(fixture.insert).toHaveBeenCalledWith({
      phone: '5511999999999',
      code: '123456',
      expires_at: expiresAt.toISOString(),
      used: false,
    })
    expect(fixture.select).toHaveBeenCalledWith('id')
    expect(fixture.single).toHaveBeenCalledOnce()
  })

  it('fails closed when Postgres does not return an ID', async () => {
    const fixture = clientReturning({ data: {}, error: null })

    await expect(createAuthCode(
      fixture.client,
      '5511999999999',
      '123456',
      new Date('2026-07-13T21:05:00.000Z'),
    )).rejects.toThrow('auth code ID')
  })
})
