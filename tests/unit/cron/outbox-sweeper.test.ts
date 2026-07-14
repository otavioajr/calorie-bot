import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  fakeSupabase,
  mockClaimOutboxMessages,
  mockCreateServiceRoleClient,
  mockDeliverClaimedOutboxMessage,
  mockRedactOutboxPayloads,
} = vi.hoisted(() => ({
  fakeSupabase: { kind: 'service-role' },
  mockClaimOutboxMessages: vi.fn(),
  mockCreateServiceRoleClient: vi.fn(),
  mockDeliverClaimedOutboxMessage: vi.fn(),
  mockRedactOutboxPayloads: vi.fn(),
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}))

vi.mock('@/lib/outbox/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/outbox/repository')>()
  return {
    ...actual,
    claimOutboxMessages: mockClaimOutboxMessages,
    redactOutboxPayloads: mockRedactOutboxPayloads,
  }
})

vi.mock('@/lib/outbox/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/outbox/service')>()
  return {
    ...actual,
    deliverClaimedOutboxMessage: mockDeliverClaimedOutboxMessage,
  }
})

function request(secret = 'test-cron-secret') {
  return new Request('http://localhost/api/cron/outbox-sweeper', {
    headers: { authorization: `Bearer ${secret}` },
  })
}

function claimedRow(outboxId: string, recipient: string) {
  return {
    outboxId,
    recipient,
    messageKind: 'terminal' as const,
    payload: { version: 1, type: 'text', text: `message ${outboxId}` },
    payloadHash: 'a'.repeat(64),
    replyToMessageId: null,
    sequenceNo: 1,
    attempt: 1,
    maxAttempts: 5,
    expiresAt: '2026-07-13T21:00:00.000Z',
    leaseToken: `lease-${outboxId}`,
    userId: null,
    workId: null,
    resourceType: null,
    resourceId: null,
    resourceMetadata: null,
  }
}

describe('GET /api/cron/outbox-sweeper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'test-cron-secret'
    process.env.OUTBOX_MODE = 'active'
    process.env.OUTBOX_GENERATION = 'generation-1'
    process.env.OUTBOX_CANARY_PERCENT = '100'
    mockCreateServiceRoleClient.mockReturnValue(fakeSupabase)
    mockClaimOutboxMessages.mockResolvedValue({ ok: true, rows: [] })
    mockRedactOutboxPayloads.mockResolvedValue({
      ok: true,
      redactedCount: 0,
    })
    mockDeliverClaimedOutboxMessage.mockResolvedValue({
      providerMessageId: 'wamid.accepted',
      outboxId: 'outbox-1',
      status: 'api_accepted',
      route: 'active',
      durablyEnqueued: true,
      replayed: false,
      preventInboundReplay: false,
      attemptResultPersisted: true,
    })
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.OUTBOX_MODE
    delete process.env.OUTBOX_GENERATION
    delete process.env.OUTBOX_CANARY_PERCENT
  })

  it('returns 401 without cron authorization and touches no outbox state', async () => {
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(new Request('http://localhost/api/cron/outbox-sweeper'))

    expect(response.status).toBe(401)
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
    expect(mockClaimOutboxMessages).not.toHaveBeenCalled()
  })

  it('does no database work or delivery while rollout mode is off', async () => {
    process.env.OUTBOX_MODE = 'off'
    delete process.env.OUTBOX_GENERATION
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'off', claimed: 0 })
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
    expect(mockClaimOutboxMessages).not.toHaveBeenCalled()
    expect(mockRedactOutboxPayloads).not.toHaveBeenCalled()
    expect(mockDeliverClaimedOutboxMessage).not.toHaveBeenCalled()
  })

  it('keeps retention running after rollback off with a known generation', async () => {
    process.env.OUTBOX_MODE = 'off'
    process.env.OUTBOX_GENERATION = 'rolled-back-generation'
    mockRedactOutboxPayloads.mockResolvedValue({ ok: true, redactedCount: 4 })
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      mode: 'off',
      generation: 'rolled-back-generation',
      claimed: 0,
      redacted: 4,
    })
    expect(mockRedactOutboxPayloads).toHaveBeenCalledWith(fakeSupabase, 100)
    expect(mockClaimOutboxMessages).not.toHaveBeenCalled()
    expect(mockDeliverClaimedOutboxMessage).not.toHaveBeenCalled()
  })

  it('redacts but never claims or delivers shadow rows', async () => {
    process.env.OUTBOX_MODE = 'shadow'
    mockRedactOutboxPayloads.mockResolvedValue({ ok: true, redactedCount: 3 })
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      mode: 'shadow',
      claimed: 0,
      redacted: 3,
    })
    expect(mockClaimOutboxMessages).not.toHaveBeenCalled()
    expect(mockDeliverClaimedOutboxMessage).not.toHaveBeenCalled()
  })

  it('fails closed when active mode has no generation', async () => {
    delete process.env.OUTBOX_GENERATION
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(503)
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
    expect(mockClaimOutboxMessages).not.toHaveBeenCalled()
  })

  it('makes one bounded claim and delivers each recipient head once', async () => {
    const rows = [
      claimedRow('outbox-1', '5511999999991'),
      claimedRow('outbox-2', '5511999999992'),
    ]
    mockClaimOutboxMessages.mockResolvedValue({ ok: true, rows })
    mockRedactOutboxPayloads.mockResolvedValue({ ok: true, redactedCount: 2 })
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(mockClaimOutboxMessages).toHaveBeenCalledOnce()
    expect(mockClaimOutboxMessages).toHaveBeenCalledWith(
      fakeSupabase,
      expect.stringMatching(/^sweeper:/),
      'generation-1',
      { limit: 5, leaseSeconds: 90 },
    )
    expect(mockDeliverClaimedOutboxMessage).toHaveBeenCalledTimes(2)
    expect(mockDeliverClaimedOutboxMessage).toHaveBeenNthCalledWith(
      1,
      fakeSupabase,
      rows[0],
    )
    expect(mockDeliverClaimedOutboxMessage).toHaveBeenNthCalledWith(
      2,
      fakeSupabase,
      rows[1],
    )
    expect(mockRedactOutboxPayloads).toHaveBeenCalledWith(fakeSupabase, 100)
    expect(await response.json()).toMatchObject({
      mode: 'active',
      generation: 'generation-1',
      claimed: 2,
      processed: 2,
      errors: 0,
      redacted: 2,
    })
  })

  it('isolates a failed lease without preventing other claimed rows', async () => {
    const rows = [
      claimedRow('outbox-1', '5511999999991'),
      claimedRow('outbox-2', '5511999999992'),
    ]
    mockClaimOutboxMessages.mockResolvedValue({ ok: true, rows })
    mockDeliverClaimedOutboxMessage
      .mockRejectedValueOnce(new Error('unexpected persistence failure'))
      .mockResolvedValueOnce({
        status: 'api_accepted',
        attemptResultPersisted: true,
      })
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(mockDeliverClaimedOutboxMessage).toHaveBeenCalledTimes(2)
    expect(await response.json()).toMatchObject({
      claimed: 2,
      processed: 1,
      errors: 1,
    })
  })

  it('counts a fulfilled delivery with an unpersisted attempt result as an error', async () => {
    mockClaimOutboxMessages.mockResolvedValue({
      ok: true,
      rows: [claimedRow('outbox-1', '5511999999991')],
    })
    mockDeliverClaimedOutboxMessage.mockResolvedValueOnce({
      providerMessageId: 'wamid.accepted',
      outboxId: 'outbox-1',
      status: 'api_accepted',
      route: 'active',
      durablyEnqueued: true,
      replayed: false,
      preventInboundReplay: false,
      attemptResultPersisted: false,
    })
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      claimed: 1,
      processed: 0,
      errors: 1,
    })
  })

  it('returns 503 when the atomic claim fails', async () => {
    mockClaimOutboxMessages.mockResolvedValue({
      ok: false,
      error: { message: 'generation unavailable' },
    })
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(503)
    expect(mockDeliverClaimedOutboxMessage).not.toHaveBeenCalled()
  })

  it('reports redaction failure without discarding successful deliveries', async () => {
    mockClaimOutboxMessages.mockResolvedValue({
      ok: true,
      rows: [claimedRow('outbox-1', '5511999999991')],
    })
    mockRedactOutboxPayloads.mockResolvedValue({
      ok: false,
      error: { message: 'redaction busy' },
    })
    const { GET } = await import('@/app/api/cron/outbox-sweeper/route')

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      processed: 1,
      errors: 0,
      redacted: 0,
      redactionErrors: 1,
    })
  })
})
