import { describe, it, expect, beforeEach } from 'vitest'
import { getIntegrationSupabase } from '../helpers/supabase-local'
import { resetIntegrationDb } from '../helpers/db-reset'

const WORK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

describe('inbound_work RPCs', () => {
  beforeEach(() => {
    resetIntegrationDb()
  })

  it('enqueue is idempotent for the same provider triple', async () => {
    const supabase = getIntegrationSupabase()
    const payload = { type: 'text', from: '5511999999999', messageId: 'wamid.int-1', text: 'oi' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await (supabase as any).rpc('enqueue_inbound_work', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_provider_message_id: 'wamid.int-1',
      p_user_phone: '5511999999999',
      p_event_at: new Date().toISOString(),
      p_payload_json: payload,
    })
    expect(first.error).toBeNull()
    expect(first.data[0].was_inserted).toBe(true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await (supabase as any).rpc('enqueue_inbound_work', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_provider_message_id: 'wamid.int-1',
      p_user_phone: '5511999999999',
      p_event_at: new Date().toISOString(),
      p_payload_json: payload,
    })
    expect(second.error).toBeNull()
    expect(second.data[0].was_inserted).toBe(false)
    expect(second.data[0].work_id).toBe(first.data[0].work_id)
  })

  it('only one concurrent claim succeeds', async () => {
    const supabase = getIntegrationSupabase()
    const payload = { type: 'text', from: '5511999999999', messageId: 'wamid.int-claim', text: 'oi' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enq = await (supabase as any).rpc('enqueue_inbound_work', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_provider_message_id: 'wamid.int-claim',
      p_user_phone: '5511999999999',
      p_event_at: new Date().toISOString(),
      p_payload_json: payload,
    })
    const workId = enq.data[0].work_id as string

    const claim = async (owner: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('claim_inbound_work', {
        p_work_id: workId,
        p_owner: owner,
        p_lease_seconds: 90,
      })
      if (error) throw error
      return data[0] as { claimed: boolean }
    }

    const [a, b] = await Promise.all([claim('owner-a'), claim('owner-b')])
    const claimedCount = [a.claimed, b.claimed].filter(Boolean).length
    expect(claimedCount).toBe(1)
  })

  it('complete only succeeds for lease owner', async () => {
    const supabase = getIntegrationSupabase()
    const payload = { type: 'text', from: '5511999999999', messageId: 'wamid.int-complete', text: 'oi' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enq = await (supabase as any).rpc('enqueue_inbound_work', {
      p_provider: 'whatsapp_cloud',
      p_business_account_id: 'PHONE_NUMBER_ID',
      p_provider_message_id: 'wamid.int-complete',
      p_user_phone: '5511999999999',
      p_event_at: new Date().toISOString(),
      p_payload_json: payload,
    })
    const workId = enq.data[0].work_id as string

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).rpc('claim_inbound_work', {
      p_work_id: workId,
      p_owner: 'owner-a',
      p_lease_seconds: 90,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrongOwner = await (supabase as any).rpc('complete_inbound_work', {
      p_work_id: workId,
      p_owner: 'owner-b',
      p_status: 'committed',
    })
    expect(wrongOwner.data[0].completed).toBe(false)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rightOwner = await (supabase as any).rpc('complete_inbound_work', {
      p_work_id: workId,
      p_owner: 'owner-a',
      p_status: 'committed',
    })
    expect(rightOwner.data[0].completed).toBe(true)
    expect(rightOwner.data[0].status).toBe('committed')
  })
})
