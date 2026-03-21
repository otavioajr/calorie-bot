import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('Supabase client helpers', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('createBrowserClient is a function that returns an object', async () => {
    const { createBrowserClient } = await import('@/lib/db/supabase')
    expect(typeof createBrowserClient).toBe('function')
    const client = createBrowserClient()
    expect(typeof client).toBe('object')
    expect(client).not.toBeNull()
  })

  it('createServiceRoleClient is a function that returns an object', async () => {
    const { createServiceRoleClient } = await import('@/lib/db/supabase')
    expect(typeof createServiceRoleClient).toBe('function')
    const client = createServiceRoleClient()
    expect(typeof client).toBe('object')
    expect(client).not.toBeNull()
  })

  it('createServerClient is exported', async () => {
    const mod = await import('@/lib/db/supabase')
    expect(typeof mod.createServerClient).toBe('function')
  })
})
