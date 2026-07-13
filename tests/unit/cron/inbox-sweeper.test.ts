import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockListStaleInboundWork } = vi.hoisted(() => ({
  mockListStaleInboundWork: vi.fn().mockResolvedValue([]),
}))

const { mockProcessInboundWork } = vi.hoisted(() => ({
  mockProcessInboundWork: vi.fn().mockResolvedValue('committed'),
}))

vi.mock('@/lib/db/queries/inbound-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries/inbound-work')>()
  return {
    ...actual,
    listStaleInboundWork: mockListStaleInboundWork,
  }
})

vi.mock('@/lib/bot/inbound-processor', () => ({
  processInboundWork: mockProcessInboundWork,
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: () => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { payload_json: { type: 'text' } }, error: null }),
        }),
      }),
    })),
  }),
}))

import { GET } from '@/app/api/cron/inbox-sweeper/route'

describe('GET /api/cron/inbox-sweeper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'test-cron-secret'
    mockListStaleInboundWork.mockResolvedValue([])
  })

  it('returns 401 without authorization', async () => {
    const response = await GET(new Request('http://localhost/api/cron/inbox-sweeper'))
    expect(response.status).toBe(401)
  })

  it('returns 401 when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET
    const response = await GET(
      new Request('http://localhost/api/cron/inbox-sweeper', {
        headers: { authorization: 'Bearer anything' },
      }),
    )
    expect(response.status).toBe(401)
  })

  it('processes stale inbound work when authorized', async () => {
    mockListStaleInboundWork.mockResolvedValue([
      { workId: '11111111-1111-1111-1111-111111111111', status: 'accepted', attempt: 0 },
    ])

    const response = await GET(
      new Request('http://localhost/api/cron/inbox-sweeper', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.candidates).toBe(1)
    expect(mockProcessInboundWork).toHaveBeenCalledTimes(1)
    expect(mockProcessInboundWork.mock.calls[0]).toHaveLength(3)
  })
})
