import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCookies,
  mockCreateServiceRoleClient,
  mockLogMealFromRecipe,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockCreateServiceRoleClient: vi.fn(),
  mockLogMealFromRecipe: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: mockCookies,
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}))

vi.mock('@/lib/recipes/log-meal', () => ({
  logMealFromRecipe: mockLogMealFromRecipe,
}))

import { POST } from '@/app/api/recipes/[id]/log/route'

const supabase = {}

function setCookie(value?: string) {
  mockCookies.mockResolvedValue({
    get: vi.fn(() => (value ? { value } : undefined)),
  })
}

function routeContext(id = 'recipe-1') {
  return { params: Promise.resolve({ id }) }
}

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/api/recipes/recipe-1/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeRawPostRequest(body: string): Request {
  return new Request('http://localhost/api/recipes/recipe-1/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

function validBody() {
  return {
    servingsConsumed: 1.5,
    mealType: 'lunch',
    registeredAt: '2026-04-25T12:30:00.000Z',
  }
}

describe('POST /api/recipes/[id]/log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCookie('user-123')
    mockCreateServiceRoleClient.mockReturnValue(supabase)
    mockLogMealFromRecipe.mockResolvedValue('meal-1')
  })

  it('returns 401 when auth cookie is missing', async () => {
    setCookie()

    const response = await POST(makePostRequest(validBody()), routeContext())
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
    expect(mockLogMealFromRecipe).not.toHaveBeenCalled()
  })

  it('returns 400 when JSON is invalid', async () => {
    const response = await POST(makeRawPostRequest('{invalid'), routeContext())
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: 'invalid_json' })
    expect(mockLogMealFromRecipe).not.toHaveBeenCalled()
  })

  it.each([
    ['missing servingsConsumed', { servingsConsumed: undefined }],
    ['zero servingsConsumed', { servingsConsumed: 0 }],
    ['non-finite servingsConsumed', { servingsConsumed: Number.POSITIVE_INFINITY }],
    ['oversized servingsConsumed', { servingsConsumed: 1000 }],
    ['invalid mealType', { mealType: 'brunch' }],
    ['invalid registeredAt', { registeredAt: 'not-a-date' }],
  ])('returns 400 when body has %s', async (_caseName, override) => {
    const response = await POST(
      makePostRequest({ ...validBody(), ...override }),
      routeContext(),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: 'invalid_body' })
    expect(mockLogMealFromRecipe).not.toHaveBeenCalled()
  })

  it('logs a recipe meal for the authenticated user', async () => {
    const response = await POST(makePostRequest(validBody()), routeContext('recipe-abc'))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body).toEqual({ mealId: 'meal-1' })
    expect(mockCreateServiceRoleClient).toHaveBeenCalledOnce()
    expect(mockLogMealFromRecipe).toHaveBeenCalledWith(supabase, {
      userId: 'user-123',
      recipeId: 'recipe-abc',
      portionsConsumed: 1.5,
      mealType: 'lunch',
      registeredAt: new Date('2026-04-25T12:30:00.000Z'),
      sourceMessage: 'log via web',
    })
  })

  it('returns sanitized 500 when meal logging fails', async () => {
    mockLogMealFromRecipe.mockRejectedValue(new Error('permission denied for table meals'))

    const response = await POST(makePostRequest(validBody()), routeContext())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: 'log_failed' })
  })

  it('returns 404 when recipe is missing or not owned', async () => {
    mockLogMealFromRecipe.mockRejectedValue(new Error('Recipe not found: no row returned'))

    const response = await POST(makePostRequest(validBody()), routeContext())
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: 'not_found' })
  })
})
