import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectOutboxCallback } from '@/lib/outbox/callbacks'

const OUTBOX_ID = '10000000-0000-4000-8000-000000000001'
const CALLBACK_AT = '2024-03-09T16:00:00.000Z'

function statusEvent(
  overrides: Record<string, unknown> = {},
) {
  const rawStatus = {
    id: 'wamid.callback-1',
    status: 'delivered',
    timestamp: '1710000000',
    recipient_id: '5511999887766',
    biz_opaque_callback_data: OUTBOX_ID,
  }

  return {
    type: 'status' as const,
    providerMessageId: 'wamid.callback-1',
    status: 'delivered',
    timestamp: 1710000000,
    recipientId: '5511999887766',
    phoneNumberId: 'phone-number-1',
    wabaId: 'waba-1',
    opaqueCallbackData: OUTBOX_ID,
    errors: [],
    rawStatus,
    ...overrides,
  }
}

function appliedResult(
  overrides: Record<string, unknown> = {},
) {
  return {
    ok: true as const,
    applied: true,
    outboxId: OUTBOX_ID,
    previousStatus: 'api_accepted' as const,
    status: 'delivered' as const,
    orphaned: false,
    ...overrides,
  }
}

function dependencies(
  overrides: Record<string, unknown> = {},
) {
  return {
    applyCallback: vi.fn().mockResolvedValue(appliedResult()),
    reportCritical: vi.fn(),
    readEnv: () => ({ OUTBOX_MODE: 'active' }),
    ...overrides,
  }
}

describe('projectOutboxCallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('correlates first by a valid opaque outbox UUID', async () => {
    const deps = dependencies()
    const event = statusEvent()

    const result = await projectOutboxCallback(
      {} as SupabaseClient,
      event,
      deps,
    )

    expect(result).toEqual({ ok: true, result: appliedResult() })
    expect(deps.applyCallback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outboxId: OUTBOX_ID,
        providerMessageId: 'wamid.callback-1',
      }),
    )
  })

  it.each([
    ['missing', undefined],
    ['not a UUID', 'outbox-not-a-uuid'],
  ])('falls back to the wamid when opaque correlation is %s', async (_case, opaque) => {
    const deps = dependencies()

    await projectOutboxCallback(
      {} as SupabaseClient,
      statusEvent({ opaqueCallbackData: opaque }),
      deps,
    )

    expect(deps.applyCallback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outboxId: null,
        providerMessageId: 'wamid.callback-1',
      }),
    )
  })

  it('preserves callback time, normalized error and the raw Meta status', async () => {
    const deps = dependencies()
    const errors = [{
      code: 131026,
      subcode: 2494010,
      title: 'Message undeliverable',
      message: 'Message undeliverable',
      errorData: { details: 'The recipient is unavailable.' },
    }]
    const rawStatus = {
      id: 'wamid.failed-1',
      status: 'failed',
      timestamp: '1710000000',
      errors: [{
        code: 131026,
        title: 'Message undeliverable',
        message: 'Message undeliverable',
        error_data: { details: 'The recipient is unavailable.' },
      }],
    }

    await projectOutboxCallback(
      {} as SupabaseClient,
      statusEvent({
        providerMessageId: 'wamid.failed-1',
        status: 'failed',
        errors,
        rawStatus,
      }),
      deps,
    )

    expect(deps.applyCallback).toHaveBeenCalledWith(
      expect.anything(),
      {
        outboxId: OUTBOX_ID,
        providerMessageId: 'wamid.failed-1',
        callbackStatus: 'failed',
        eventAt: CALLBACK_AT,
        metaCode: 131026,
        metaSubcode: 2494010,
        errorMessage: 'The recipient is unavailable.',
        payload: {
          ...rawStatus,
          raw_status: 'failed',
          phone_number_id: 'phone-number-1',
          business_account_id: 'waba-1',
          recipient_id: '5511999887766',
        },
      },
    )
  })

  it('rejects an invalid callback timestamp before touching the ledger', async () => {
    const deps = dependencies()

    const result = await projectOutboxCallback(
      {} as SupabaseClient,
      statusEvent({ timestamp: Number.MAX_SAFE_INTEGER }),
      deps,
    )

    expect(result).toEqual({
      ok: false,
      error: { message: 'Invalid outbox callback timestamp' },
    })
    expect(deps.applyCallback).not.toHaveBeenCalled()
  })

  it('maps an unknown Meta status to an appendable unknown callback', async () => {
    const deps = dependencies()

    await projectOutboxCallback(
      {} as SupabaseClient,
      statusEvent({ status: 'future_status' }),
      deps,
    )

    expect(deps.applyCallback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callbackStatus: 'unknown' }),
    )
  })

  it('acknowledges an orphan callback and emits a warning', async () => {
    const orphan = appliedResult({
      applied: false,
      outboxId: null,
      previousStatus: null,
      status: null,
      orphaned: true,
    })
    const deps = dependencies({
      applyCallback: vi.fn().mockResolvedValue(orphan),
    })

    const result = await projectOutboxCallback(
      {} as SupabaseClient,
      statusEvent({ opaqueCallbackData: undefined }),
      deps,
    )

    expect(result).toEqual({ ok: true, result: orphan })
    expect(deps.reportCritical).toHaveBeenCalledOnce()
    expect(deps.reportCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'outbox_callback_orphaned',
        providerMessageId: 'wamid.callback-1',
      }),
    )
  })

  it('returns a repository failure so the webhook route can retry', async () => {
    const repositoryFailure = {
      ok: false as const,
      error: { message: 'apply_outbox_callback failed', code: '08006' },
    }
    const deps = dependencies({
      applyCallback: vi.fn().mockResolvedValue(repositoryFailure),
    })

    const result = await projectOutboxCallback(
      {} as SupabaseClient,
      statusEvent(),
      deps,
    )

    expect(result).toEqual(repositoryFailure)
  })

  it('alerts once for an applied failed callback but not for its duplicate', async () => {
    const first = appliedResult({
      previousStatus: 'api_accepted',
      status: 'failed_terminal',
    })
    const duplicate = appliedResult({
      applied: false,
      previousStatus: 'failed_terminal',
      status: 'failed_terminal',
    })
    const applyCallback = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(duplicate)
    const deps = dependencies({ applyCallback })
    const event = statusEvent({ status: 'failed' })

    await projectOutboxCallback({} as SupabaseClient, event, deps)
    await projectOutboxCallback({} as SupabaseClient, event, deps)

    expect(deps.reportCritical).toHaveBeenCalledOnce()
    expect(deps.reportCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'outbox_callback_failed',
        outboxId: OUTBOX_ID,
        providerMessageId: 'wamid.callback-1',
      }),
    )
  })

  it('projects callbacks even while OUTBOX_MODE is off', async () => {
    const deps = dependencies({
      readEnv: () => ({ OUTBOX_MODE: 'off' }),
    })

    const result = await projectOutboxCallback(
      {} as SupabaseClient,
      statusEvent(),
      deps,
    )

    expect(result.ok).toBe(true)
    expect(deps.applyCallback).toHaveBeenCalledOnce()
  })
})
