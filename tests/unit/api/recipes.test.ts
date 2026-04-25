import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCookies,
  mockCreateServiceRoleClient,
  mockCreateRecipe,
  mockGetRecipesByUser,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockCreateServiceRoleClient: vi.fn(),
  mockCreateRecipe: vi.fn(),
  mockGetRecipesByUser: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: mockCookies,
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}))

vi.mock('@/lib/db/queries/recipes', () => ({
  createRecipe: mockCreateRecipe,
  getRecipesByUser: mockGetRecipesByUser,
}))

import { GET, POST } from '@/app/api/recipes/route'

const tacoSingle = vi.fn()
const tacoEq = vi.fn(() => ({ single: tacoSingle }))
const tacoSelect = vi.fn(() => ({ eq: tacoEq }))

const supabase = {
  from: vi.fn((table: string) => {
    if (table === 'taco_foods') {
      return { select: tacoSelect }
    }
    throw new Error(`Unexpected table: ${table}`)
  }),
}

const recipe = {
  id: 'recipe-1',
  userId: 'user-123',
  name: 'Bolo de banana',
  totalWeightGrams: 600,
  servings: 6,
  weightPerServingGrams: 100,
  totalCalories: 585,
  totalProteinG: 19.5,
  totalCarbsG: 118,
  totalFatG: 7.2,
  perServingCalories: 97.5,
  perServingProteinG: 3.3,
  perServingCarbsG: 19.7,
  perServingFatG: 1.2,
  notes: null,
  createdAt: '2026-04-25T12:00:00Z',
  updatedAt: '2026-04-25T12:00:00Z',
}

const tacoRow = {
  id: 42,
  food_name: 'Aveia, flocos, crua',
  category: 'Cereais',
  calories_per_100g: 389,
  protein_per_100g: 16.9,
  carbs_per_100g: 66,
  fat_per_100g: 7,
  fiber_per_100g: 9.1,
  food_base: 'aveia',
  food_variant: 'flocos crua',
  is_default: false,
}

function setCookie(value?: string) {
  mockCookies.mockResolvedValue({
    get: vi.fn(() => (value ? { value } : undefined)),
  })
}

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeRawPostRequest(body: string): Request {
  return new Request('http://localhost/api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

describe('/api/recipes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCookie('user-123')
    mockCreateServiceRoleClient.mockReturnValue(supabase)
    mockGetRecipesByUser.mockResolvedValue([recipe])
    mockCreateRecipe.mockResolvedValue('recipe-1')
    tacoSingle.mockResolvedValue({ data: tacoRow, error: null })
  })

  describe('GET', () => {
    it('returns 401 when auth cookie is missing', async () => {
      setCookie()

      const response = await GET()
      const body = await response.json()

      expect(response.status).toBe(401)
      expect(body).toEqual({ error: 'Unauthorized' })
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
      expect(mockGetRecipesByUser).not.toHaveBeenCalled()
    })

    it('returns recipes for the authenticated user', async () => {
      const response = await GET()
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(mockCreateServiceRoleClient).toHaveBeenCalledOnce()
      expect(mockGetRecipesByUser).toHaveBeenCalledWith(supabase, 'user-123')
      expect(body).toEqual({ recipes: [recipe] })
    })

    it('returns 500 when recipe loading fails', async () => {
      mockGetRecipesByUser.mockRejectedValue(new Error('database unavailable'))

      const response = await GET()
      const body = await response.json()

      expect(response.status).toBe(500)
      expect(body).toEqual({ error: 'load_failed' })
    })
  })

  describe('POST', () => {
    it('returns 401 when auth cookie is missing', async () => {
      setCookie()

      const response = await POST(makePostRequest(validTacoBody()))
      const body = await response.json()

      expect(response.status).toBe(401)
      expect(body).toEqual({ error: 'Unauthorized' })
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
      expect(mockCreateRecipe).not.toHaveBeenCalled()
    })

    it('returns 400 when JSON is invalid', async () => {
      const response = await POST(makeRawPostRequest('{invalid'))
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_json' })
      expect(mockCreateRecipe).not.toHaveBeenCalled()
    })

    it('returns 400 when body is invalid', async () => {
      const response = await POST(makePostRequest({ ...validTacoBody(), name: '   ' }))
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_body' })
      expect(mockCreateRecipe).not.toHaveBeenCalled()
    })

    it.each([
      ['oversized totalWeightGrams', { totalWeightGrams: 1_000_000 }],
      ['tiny totalWeightGrams', { totalWeightGrams: 0.001 }],
      ['too many totalWeightGrams decimals', { totalWeightGrams: 1.001 }],
      ['oversized servings', { servings: 1_000 }],
      ['tiny servings', { servings: 0.001 }],
      ['too many servings decimals', { servings: 1.001 }],
      [
        'oversized quantityGrams',
        { ingredients: [{ ...validTacoBody().ingredients[0], quantityGrams: 1_000_000 }] },
      ],
      [
        'tiny quantityGrams',
        { ingredients: [{ ...validTacoBody().ingredients[0], quantityGrams: 0.001 }] },
      ],
      [
        'too many quantityGrams decimals',
        { ingredients: [{ ...validTacoBody().ingredients[0], quantityGrams: 1.001 }] },
      ],
      [
        'oversized displayOrder',
        { ingredients: [{ ...validTacoBody().ingredients[0], displayOrder: 32_768 }] },
      ],
      [
        'excessive label macro value',
        {
          ingredients: [
            {
              ...validUserLabelBody().ingredients[0],
              labelOverride: {
                ...validUserLabelBody().ingredients[0].labelOverride,
                kcalPer100g: 901,
              },
            },
          ],
        },
      ],
    ])('returns 400 when body has %s', async (_caseName, override) => {
      const baseBody = 'totalWeightGrams' in override || 'servings' in override
        ? validTacoBody()
        : validUserLabelBody()

      const response = await POST(makePostRequest({ ...baseBody, ...override }))
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_body' })
      expect(mockCreateRecipe).not.toHaveBeenCalled()
    })

    it('returns 400 when computed serving weight rounds to zero', async () => {
      const response = await POST(
        makePostRequest({
          ...validUserLabelBody(),
          totalWeightGrams: 1,
          servings: 999.99,
          ingredients: [
            {
              ...validUserLabelBody().ingredients[0],
              quantityGrams: 1,
            },
          ],
        }),
      )
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_body' })
      expect(mockCreateRecipe).not.toHaveBeenCalled()
    })

    it('returns 400 when computed macros exceed persisted numeric range', async () => {
      const response = await POST(
        makePostRequest({
          ...validUserLabelBody(),
          totalWeightGrams: 999999.99,
          ingredients: [
            {
              ...validUserLabelBody().ingredients[0],
              quantityGrams: 999999.99,
              labelOverride: {
                ...validUserLabelBody().ingredients[0].labelOverride,
                kcalPer100g: 900,
              },
            },
          ],
        }),
      )
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_body' })
      expect(mockCreateRecipe).not.toHaveBeenCalled()
    })

    it('creates a TACO recipe using exact tacoId lookup', async () => {
      const response = await POST(makePostRequest(validTacoBody()))
      const body = await response.json()

      expect(response.status).toBe(201)
      expect(body).toEqual({ id: 'recipe-1' })
      expect(supabase.from).toHaveBeenCalledWith('taco_foods')
      expect(tacoSelect).toHaveBeenCalledWith(
        'id, food_name, category, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, food_base, food_variant, is_default',
      )
      expect(tacoEq).toHaveBeenCalledWith('id', 42)
      expect(tacoSingle).toHaveBeenCalledOnce()
      expect(mockCreateRecipe).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({
          userId: 'user-123',
          name: 'Overnight oats',
          totalWeightGrams: 300,
          servings: 2,
          notes: 'gelado',
          ingredients: [
            {
              foodName: 'Aveia escolhida pelo usuario',
              quantityGrams: 100,
              source: 'taco',
              tacoId: 42,
              tacoFoodBase: 'aveia',
              tacoFoodVariant: 'flocos crua',
              displayOrder: 0,
            },
          ],
          precomputedMacros: expect.objectContaining({
            totalCalories: 389,
            totalProteinG: 16.9,
            totalCarbsG: 66,
            totalFatG: 7,
            perServingCalories: 194.5,
          }),
        }),
      )
    })

    it('creates a user_label recipe without TACO lookup', async () => {
      const response = await POST(makePostRequest(validUserLabelBody()))
      const body = await response.json()

      expect(response.status).toBe(201)
      expect(body).toEqual({ id: 'recipe-1' })
      expect(supabase.from).not.toHaveBeenCalled()
      expect(mockCreateRecipe).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({
          userId: 'user-123',
          name: 'Molho caseiro',
          notes: undefined,
          ingredients: [
            {
              foodName: 'Molho',
              quantityGrams: 50,
              source: 'user_label',
              labelOverride: {
                kcalPer100g: 80,
                proteinPer100g: 1,
                carbsPer100g: 10,
                fatPer100g: 4,
                fiberPer100g: 2,
              },
              displayOrder: 0,
            },
          ],
          precomputedMacros: expect.objectContaining({
            totalCalories: 40,
            totalProteinG: 0.5,
            totalCarbsG: 5,
            totalFatG: 2,
          }),
        }),
      )
    })

    it('returns 422 when taco id is not found', async () => {
      tacoSingle.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'No rows found' },
      })

      const response = await POST(makePostRequest(validTacoBody()))
      const body = await response.json()

      expect(response.status).toBe(422)
      expect(body).toEqual({ error: 'taco_not_found', tacoId: 42 })
      expect(mockCreateRecipe).not.toHaveBeenCalled()
    })

    it('returns 502 when taco lookup fails', async () => {
      tacoSingle.mockResolvedValue({
        data: null,
        error: { code: '08006', message: 'connection failure' },
      })

      const response = await POST(makePostRequest(validTacoBody()))
      const body = await response.json()

      expect(response.status).toBe(502)
      expect(body).toEqual({ error: 'taco_lookup_failed' })
      expect(mockCreateRecipe).not.toHaveBeenCalled()
    })

    it('returns 409 when recipe creation fails because the name is duplicated', async () => {
      mockCreateRecipe.mockRejectedValue(new Error('duplicate key value violates unique constraint'))

      const response = await POST(makePostRequest(validTacoBody()))
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body).toEqual({ error: 'duplicate_name' })
    })
  })
})

function validTacoBody() {
  return {
    name: '  Overnight oats  ',
    totalWeightGrams: 300,
    servings: 2,
    notes: '  gelado  ',
    ingredients: [
      {
        foodName: '  Aveia escolhida pelo usuario  ',
        quantityGrams: 100,
        source: 'taco',
        tacoId: 42,
        labelOverride: {
          kcalPer100g: 1,
          proteinPer100g: 1,
          carbsPer100g: 1,
          fatPer100g: 1,
        },
        displayOrder: 0,
      },
    ],
  }
}

function validUserLabelBody() {
  return {
    name: 'Molho caseiro',
    totalWeightGrams: 50,
    servings: 1,
    ingredients: [
      {
        foodName: 'Molho',
        quantityGrams: 50,
        source: 'user_label',
        labelOverride: {
          kcalPer100g: 80,
          proteinPer100g: 1,
          carbsPer100g: 10,
          fatPer100g: 4,
          fiberPer100g: 2,
        },
        displayOrder: 0,
      },
    ],
  }
}
