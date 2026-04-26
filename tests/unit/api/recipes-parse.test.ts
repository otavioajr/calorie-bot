import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCookies,
  mockCreateServiceRoleClient,
  mockParseRecipeIngredients,
  mockCalculateMacros,
  mockResolveTacoFood,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockCreateServiceRoleClient: vi.fn(),
  mockParseRecipeIngredients: vi.fn(),
  mockCalculateMacros: vi.fn(),
  mockResolveTacoFood: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: mockCookies,
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}))

vi.mock('@/lib/llm/parsers/recipe-ingredients', () => ({
  parseRecipeIngredients: mockParseRecipeIngredients,
}))

vi.mock('@/lib/db/queries/taco', () => ({
  calculateMacros: mockCalculateMacros,
  resolveTacoFood: mockResolveTacoFood,
}))

import { POST } from '@/app/api/recipes/parse-ingredients/route'

const mockAuthSingle = vi.fn()
const mockAuthEq = vi.fn(() => ({ single: mockAuthSingle }))
const mockAuthSelect = vi.fn(() => ({ eq: mockAuthEq }))
const supabase = {
  from: vi.fn(() => ({ select: mockAuthSelect })),
}

function mockAuthLookup(data: unknown, error: unknown = null) {
  mockAuthSingle.mockResolvedValue({ data, error })
}

function setCookie(value?: string) {
  mockCookies.mockResolvedValue({
    get: vi.fn(() => (value ? { value } : undefined)),
  })
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/recipes/parse-ingredients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeRawRequest(body: string): Request {
  return new Request('http://localhost/api/recipes/parse-ingredients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

describe('POST /api/recipes/parse-ingredients', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCookie('user-123')
    mockCreateServiceRoleClient.mockReturnValue(supabase)
    mockAuthLookup({ id: 'user-123' })
    mockParseRecipeIngredients.mockResolvedValue([
      { food: 'arroz branco', quantityGrams: 150 },
    ])
    mockResolveTacoFood.mockResolvedValue({
      id: 10,
      foodName: 'Arroz, branco, cozido',
      category: 'Cereais',
      caloriesPer100g: 128,
      proteinPer100g: 2.5,
      carbsPer100g: 28.1,
      fatPer100g: 0.2,
      fiberPer100g: 1.6,
      foodBase: 'arroz',
      foodVariant: 'branco cozido',
      isDefault: true,
    })
    mockCalculateMacros.mockReturnValue({
      calories: 192,
      protein: 3.8,
      carbs: 42.2,
      fat: 0.3,
    })
  })

  it('returns 401 when auth cookie is missing', async () => {
    setCookie()

    const response = await POST(makeRequest({ text: '150g arroz branco' }))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
  })

  it('returns 401 when auth cookie points to a missing user', async () => {
    mockAuthLookup(null, { code: 'PGRST116', message: 'No rows found' })

    const response = await POST(makeRequest({ text: '150g arroz branco' }))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(supabase.from).toHaveBeenCalledWith('users')
    expect(mockAuthSelect).toHaveBeenCalledWith('id')
    expect(mockAuthEq).toHaveBeenCalledWith('id', 'user-123')
    expect(mockAuthSingle).toHaveBeenCalledOnce()
    expect(mockParseRecipeIngredients).not.toHaveBeenCalled()
  })

  it('returns 503 when user validation query fails', async () => {
    mockAuthLookup(null, { code: '08006', message: 'connection failure' })

    const response = await POST(makeRequest({ text: '150g arroz branco' }))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({ error: 'auth_lookup_failed' })
    expect(mockParseRecipeIngredients).not.toHaveBeenCalled()
  })

  it('returns 400 when body is invalid', async () => {
    const response = await POST(makeRequest({ text: 'ab' }))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: 'invalid_body' })
    expect(mockParseRecipeIngredients).not.toHaveBeenCalled()
  })

  it('returns 400 when JSON is invalid', async () => {
    const response = await POST(makeRawRequest('{invalid'))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: 'invalid_json' })
    expect(mockParseRecipeIngredients).not.toHaveBeenCalled()
  })

  it('returns parsed ingredients enriched with TACO macros', async () => {
    const response = await POST(makeRequest({ text: '150g arroz branco' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockCreateServiceRoleClient).toHaveBeenCalledOnce()
    expect(supabase.from).toHaveBeenCalledWith('users')
    expect(mockParseRecipeIngredients).toHaveBeenCalledWith('150g arroz branco')
    expect(mockResolveTacoFood).toHaveBeenCalledWith(supabase, 'arroz branco', {
      throwOnError: true,
    })
    expect(mockCalculateMacros).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }), 150)
    expect(body).toEqual({
      ingredients: [
        {
          foodName: 'arroz branco',
          quantityGrams: 150,
          source: 'taco',
          tacoId: 10,
          tacoFoodBase: 'arroz',
          tacoFoodVariant: 'branco cozido',
          calories: 192,
          proteinG: 3.8,
          carbsG: 42.2,
          fatG: 0.3,
        },
      ],
    })
  })

  it('returns unknown source with zero macros when TACO has no match', async () => {
    mockParseRecipeIngredients.mockResolvedValue([
      { food: 'ingrediente raro', quantityGrams: 100 },
    ])
    mockResolveTacoFood.mockResolvedValue(null)

    const response = await POST(makeRequest({ text: '100g ingrediente raro' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockResolveTacoFood).toHaveBeenCalledWith(supabase, 'ingrediente raro', {
      throwOnError: true,
    })
    expect(mockCalculateMacros).not.toHaveBeenCalled()
    expect(body).toEqual({
      ingredients: [
        {
          foodName: 'ingrediente raro',
          quantityGrams: 100,
          source: 'unknown',
          calories: 0,
          proteinG: 0,
          carbsG: 0,
          fatG: 0,
        },
      ],
    })
  })

  it('returns 502 when ingredient parser fails', async () => {
    mockParseRecipeIngredients.mockRejectedValue(new Error('LLM unavailable'))

    const response = await POST(makeRequest({ text: '150g arroz branco' }))
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toEqual({ error: 'parse_failed' })
    expect(mockResolveTacoFood).not.toHaveBeenCalled()
  })

  it('returns 502 when TACO lookup RPC fails', async () => {
    mockResolveTacoFood.mockRejectedValue(new Error('RPC unavailable'))

    const response = await POST(makeRequest({ text: '150g arroz branco' }))
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toEqual({ error: 'taco_lookup_failed' })
    expect(mockCalculateMacros).not.toHaveBeenCalled()
  })
})
