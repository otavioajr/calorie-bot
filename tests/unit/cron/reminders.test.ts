import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCleanupOldMessages,
  mockCreateServiceRoleClient,
  mockGetDailyCalories,
  mockSendTextMessage,
} = vi.hoisted(() => ({
  mockCleanupOldMessages: vi.fn(),
  mockCreateServiceRoleClient: vi.fn(),
  mockGetDailyCalories: vi.fn(),
  mockSendTextMessage: vi.fn(),
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}))

vi.mock('@/lib/whatsapp/client', () => ({
  sendTextMessage: mockSendTextMessage,
}))

vi.mock('@/lib/db/queries/meals', () => ({
  createMeal: vi.fn(),
  getDailyCalories: mockGetDailyCalories,
}))

vi.mock('@/lib/db/queries/bot-messages', () => ({
  cleanupOldMessages: mockCleanupOldMessages,
}))

vi.mock('@/lib/whatsapp/templates', () => ({
  buildDailyReminderMessage: () => 'daily reminder',
  buildDailySummaryMessage: () => 'daily summary',
  buildWeeklySummaryMessage: () => 'weekly summary',
}))

type UpdateRecord = {
  table: string
  payload: Record<string, unknown>
}

function createSupabaseFixture() {
  const updates: UpdateRecord[] = []
  const settings = [{
    user_id: 'user-1',
    reminders_enabled: true,
    reminder_time: '21:00',
    daily_summary_time: '21:00',
    last_reminder_sent_at: null,
    last_summary_sent_at: null,
    last_weekly_summary_sent_at: null,
  }]
  const users = [{
    id: 'user-1',
    phone: '5511999999999',
    timezone: 'UTC',
    daily_calorie_target: 2000,
  }]

  function from(table: string) {
    let selected = ''
    const query = {
      select: vi.fn((columns: string) => {
        selected = columns
        return query
      }),
      eq: vi.fn(() => query),
      in: vi.fn(() => query),
      gte: vi.fn(() => query),
      lte: vi.fn(() => query),
      lt: vi.fn(() => query),
      limit: vi.fn(() => query),
      update: vi.fn((payload: Record<string, unknown>) => {
        updates.push({ table, payload })
        return query
      }),
      delete: vi.fn(() => query),
      then: (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        let result: unknown = { data: null, error: null }
        if (table === 'user_settings' && selected === '*') {
          result = { data: settings, error: null }
        } else if (table === 'users') {
          result = { data: users, error: null }
        } else if (table === 'meals' && selected === 'id') {
          result = { data: [], error: null }
        } else if (table === 'meals') {
          result = {
            data: [{ total_calories: 1400, registered_at: '2026-07-11T12:00:00Z' }],
            error: null,
          }
        } else if (table === 'conversation_context') {
          result = { data: [], error: null }
        }
        return Promise.resolve(result).then(onFulfilled, onRejected)
      },
    }
    return query
  }

  return { client: { from }, updates }
}

type CronMethod = 'GET' | 'POST'

function request(
  method: CronMethod,
  secret: string = 'test-cron-secret',
) {
  return new Request('http://localhost/api/cron/reminders', {
    method,
    headers: { authorization: `Bearer ${secret}` },
  })
}

async function callReminders(method: CronMethod, secret?: string) {
  const { GET, POST } = await import('@/app/api/cron/reminders/route')
  const handler = method === 'GET' ? GET : POST
  return handler(request(method, secret))
}

describe('GET and POST /api/cron/reminders durable delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T21:00:00.000Z'))
    process.env.CRON_SECRET = 'test-cron-secret'
    const fixture = createSupabaseFixture()
    mockCreateServiceRoleClient.mockReturnValue(fixture.client)
    mockCreateServiceRoleClient.mockImplementation(() => fixture.client)
    mockGetDailyCalories.mockResolvedValue(1200)
    mockCleanupOldMessages.mockResolvedValue(0)
    mockSendTextMessage.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.CRON_SECRET
  })

  it('exports GET and POST as the same handler', async () => {
    const { GET, POST } = await import('@/app/api/cron/reminders/route')

    expect(GET).toBe(POST)
  })

  it.each<CronMethod>(['GET', 'POST'])(
    'rejects %s with an invalid secret before running effects',
    async (method) => {
      const response = await callReminders(method, 'wrong-secret')

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
      expect(mockSendTextMessage).not.toHaveBeenCalled()
    },
  )

  it.each<CronMethod>(['GET', 'POST'])(
    'runs %s with stable source identities and a 15-minute TTL for every reminder type',
    async (method) => {
      const fixture = createSupabaseFixture()
      mockCreateServiceRoleClient.mockReturnValue(fixture.client)

      const response = await callReminders(method)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        success: true,
        remindersSent: 1,
        summariesSent: 1,
        weeklySent: 1,
        autoConfirmed: 0,
      })
      expect(mockSendTextMessage).toHaveBeenCalledTimes(3)
      expect(mockSendTextMessage.mock.calls.map((call) => call[3])).toEqual([
        expect.objectContaining({
          source: 'reminder',
          messageKind: 'reminder',
          userId: 'user-1',
          idempotencyKey: 'reminder:user-1:daily-reminder:2026-07-12',
          expiresAt: new Date('2026-07-12T21:15:00.000Z'),
        }),
        expect.objectContaining({
          source: 'reminder',
          messageKind: 'reminder',
          userId: 'user-1',
          idempotencyKey: 'reminder:user-1:daily-summary:2026-07-12',
          expiresAt: new Date('2026-07-12T21:15:00.000Z'),
        }),
        expect.objectContaining({
          source: 'reminder',
          messageKind: 'reminder',
          userId: 'user-1',
          idempotencyKey: 'reminder:user-1:weekly-summary:2026-07-12',
          expiresAt: new Date('2026-07-12T21:15:00.000Z'),
        }),
      ])
      expect(fixture.updates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'user_settings',
          payload: expect.objectContaining({ last_reminder_sent_at: expect.any(String) }),
        }),
        expect.objectContaining({
          table: 'user_settings',
          payload: expect.objectContaining({ last_summary_sent_at: expect.any(String) }),
        }),
      ]))
    },
  )

  it('reuses the same three keys when the same local window is replayed', async () => {
    await callReminders('POST')
    await callReminders('POST')

    const keys = mockSendTextMessage.mock.calls.map((call) =>
      (call[3] as { idempotencyKey: string }).idempotencyKey,
    )
    expect(keys.slice(0, 3)).toEqual(keys.slice(3, 6))
    expect(new Set(keys).size).toBe(3)
  })

  it('does not mark source rows sent when delivery rejects', async () => {
    const fixture = createSupabaseFixture()
    mockCreateServiceRoleClient.mockReturnValue(fixture.client)
    mockSendTextMessage.mockRejectedValue(new Error('Meta rejected'))
    const response = await callReminders('POST')

    expect(response.status).toBe(200)
    expect(fixture.updates).toEqual([])
  })
})
