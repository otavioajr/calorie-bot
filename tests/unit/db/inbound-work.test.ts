import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  __dirname,
  '../../../supabase/migrations/20260712140000_inbound_work.sql',
)

describe('migration: inbound_work', () => {
  const sql = (() => {
    try {
      return readFileSync(MIGRATION, 'utf8')
    } catch {
      return ''
    }
  })()

  it('creates inbound_work with unique provider triple', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS inbound_work/i)
    expect(sql).toMatch(/UNIQUE\s*\(\s*provider\s*,\s*business_account_id\s*,\s*provider_message_id\s*\)/i)
  })

  it('defines claim_inbound_work as SECURITY DEFINER with pinned search_path', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION claim_inbound_work/i)
    expect(sql).toMatch(/SECURITY DEFINER/i)
    expect(sql).toMatch(/SET search_path = public, pg_temp/i)
  })

  it('defines enqueue_inbound_work, complete_inbound_work, list_stale_inbound_work', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION enqueue_inbound_work/i)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION complete_inbound_work/i)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION list_stale_inbound_work/i)
  })

  it('grants execute only to service_role', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION claim_inbound_work/i)
    expect(sql).toMatch(/TO service_role/i)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION claim_inbound_work/i)
  })
})

describe('enqueueInboundWork', () => {
  it('calls enqueue_inbound_work RPC and returns work id', async () => {
    const { enqueueInboundWork } = await import('@/lib/db/queries/inbound-work')
    const rpc = vi.fn().mockResolvedValue({
      data: [{ work_id: '11111111-1111-1111-1111-111111111111', status: 'accepted', was_inserted: true }],
      error: null,
    })
    const supabase = { rpc } as never
    const result = await enqueueInboundWork(supabase, {
      provider: 'whatsapp_cloud',
      businessAccountId: 'pnid',
      providerMessageId: 'wamid.1',
      userPhone: '5511999999999',
      eventAt: new Date().toISOString(),
      payload: { type: 'text', from: '5511999999999', messageId: 'wamid.1', text: 'oi' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.workId).toBe('11111111-1111-1111-1111-111111111111')
      expect(result.wasInserted).toBe(true)
    }
  })

  it('returns ok=false on RPC error (fail-closed)', async () => {
    const { enqueueInboundWork } = await import('@/lib/db/queries/inbound-work')
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } })
    const result = await enqueueInboundWork({ rpc } as never, {
      provider: 'whatsapp_cloud',
      businessAccountId: 'pnid',
      providerMessageId: 'wamid.err',
      userPhone: '5511999999999',
      eventAt: new Date().toISOString(),
      payload: { type: 'text', from: '5511999999999', messageId: 'wamid.err' },
    })
    expect(result.ok).toBe(false)
  })
})

describe('claimInboundWork', () => {
  it('returns claimed=false without failing open on RPC error', async () => {
    const { claimInboundWork } = await import('@/lib/db/queries/inbound-work')
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } })
    const result = await claimInboundWork({ rpc } as never, '11111111-1111-1111-1111-111111111111', 'owner-1')
    expect(result.claimed).toBe(false)
  })
})

describe('isInboundWorkEnabled', () => {
  it('is true only when env is exactly true', async () => {
    const { isInboundWorkEnabled } = await import('@/lib/db/queries/inbound-work')
    const prev = process.env.INBOUND_WORK_ENABLED
    process.env.INBOUND_WORK_ENABLED = 'true'
    expect(isInboundWorkEnabled()).toBe(true)
    process.env.INBOUND_WORK_ENABLED = 'false'
    expect(isInboundWorkEnabled()).toBe(false)
    process.env.INBOUND_WORK_ENABLED = prev
  })
})

function makeHasNewerInboundWorkSupabase(
  maybeSingleResult: { data: unknown; error: { message?: string } | null },
) {
  const maybeSingle = vi.fn().mockResolvedValue(maybeSingleResult)
  const limit = vi.fn(() => ({ maybeSingle }))
  const or = vi.fn(() => ({ limit }))
  const neq = vi.fn(() => ({ or }))
  const eq = vi.fn(() => ({ neq }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { supabase: { from } as never, from, select, eq, neq, or, limit, maybeSingle }
}

const HAS_NEWER_INPUT = {
  workId: 'work-old',
  userPhone: '5511999999999',
  receivedAt: '2026-07-13T12:00:00.000Z',
  createdAt: '2026-07-13T12:00:00.000Z',
}

describe('hasNewerInboundWork', () => {
  it('returns true when maybeSingle returns a row', async () => {
    const { hasNewerInboundWork } = await import('@/lib/db/queries/inbound-work')
    const { supabase, from, select, eq, neq, or, limit } = makeHasNewerInboundWorkSupabase({
      data: { id: 'newer-id' },
      error: null,
    })

    const newer = await hasNewerInboundWork(supabase, HAS_NEWER_INPUT)

    expect(newer).toBe(true)
    expect(from).toHaveBeenCalledWith('inbound_work')
    expect(select).toHaveBeenCalledWith('id')
    expect(eq).toHaveBeenCalledWith('user_phone', '5511999999999')
    expect(neq).toHaveBeenCalledWith('id', 'work-old')
    expect(or).toHaveBeenCalledWith(
      'received_at.gt.2026-07-13T12:00:00.000Z,and(received_at.eq.2026-07-13T12:00:00.000Z,created_at.gt.2026-07-13T12:00:00.000Z)',
    )
    expect(limit).toHaveBeenCalledWith(1)
  })

  it('returns false when userPhone is null (no DB call)', async () => {
    const { hasNewerInboundWork } = await import('@/lib/db/queries/inbound-work')
    const from = vi.fn()
    const newer = await hasNewerInboundWork({ from } as never, {
      ...HAS_NEWER_INPUT,
      userPhone: null,
    })
    expect(newer).toBe(false)
    expect(from).not.toHaveBeenCalled()
  })

  it('returns false when data is null', async () => {
    const { hasNewerInboundWork } = await import('@/lib/db/queries/inbound-work')
    const { supabase } = makeHasNewerInboundWorkSupabase({ data: null, error: null })
    const newer = await hasNewerInboundWork(supabase, HAS_NEWER_INPUT)
    expect(newer).toBe(false)
  })

  it('returns true on error (fail-closed)', async () => {
    const { hasNewerInboundWork } = await import('@/lib/db/queries/inbound-work')
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = makeHasNewerInboundWorkSupabase({
      data: null,
      error: { message: 'down' },
    })
    const newer = await hasNewerInboundWork(supabase, HAS_NEWER_INPUT)
    expect(newer).toBe(true)
    expect(consoleSpy).toHaveBeenCalledWith(
      '[inbound-work] hasNewerInboundWork failed:',
      'down',
    )
    consoleSpy.mockRestore()
  })
})
