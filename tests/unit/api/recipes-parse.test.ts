import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCookies,
  mockCreateServiceRoleClient,
  mockParseRecipeIngredients,
  mockFuzzyMatchTaco,
  mockCalculateMacros,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockCreateServiceRoleClient: vi.fn(),
  mockParseRecipeIngredients: vi.fn(),
  mockFuzzyMatchTaco: vi.fn(),
  mockCalculateMacros: vi.fn(),
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
  fuzzyMatchTaco: mockFuzzyMatchTaco,
  calculateMacros: mockCalculateMacros,
}))

import { POST } from '@/app/api/recipes/parse-ingredients/route'

const supabase = { rpc: vi.fn() }

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
    mockParseRecipeIngredients.mockResolvedValue([
      { food: 'arroz branco', quantityGrams: 150 },
    ])
    mockFuzzyMatchTaco.mockResolvedValue({
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
    expect(mockParseRecipeIngredients).toHaveBeenCalledWith('150g arroz branco')
    expect(mockFuzzyMatchTaco).toHaveBeenCalledWith(supabase, 'arroz branco')
    expect(mockCalculateMacros).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }), 150)
    expect(body).toEqual({
      ingredients: [
        {
          food: 'arroz branco',
          quantityGrams: 150,
          source: 'taco',
          tacoId: 10,
          tacoBase: 'arroz',
          tacoVariant: 'branco cozido',
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
    mockFuzzyMatchTaco.mockResolvedValue(null)

    const response = await POST(makeRequest({ text: '100g ingrediente raro' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockFuzzyMatchTaco).toHaveBeenCalledWith(supabase, 'ingrediente raro')
    expect(mockCalculateMacros).not.toHaveBeenCalled()
    expect(body).toEqual({
      ingredients: [
        {
          food: 'ingrediente raro',
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
    expect(body).toEqual({ error: 'parse_failed', detail: 'LLM unavailable' })
    expect(mockFuzzyMatchTaco).not.toHaveBeenCalled()
  })
})
