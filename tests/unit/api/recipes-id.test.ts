import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCookies,
  mockCreateServiceRoleClient,
  mockDeleteRecipe,
  mockGetRecipeWithIngredients,
  mockUpdateRecipe,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockCreateServiceRoleClient: vi.fn(),
  mockDeleteRecipe: vi.fn(),
  mockGetRecipeWithIngredients: vi.fn(),
  mockUpdateRecipe: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: mockCookies,
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}))

vi.mock('@/lib/db/queries/recipes', () => ({
  deleteRecipe: mockDeleteRecipe,
  getRecipeWithIngredients: mockGetRecipeWithIngredients,
  updateRecipe: mockUpdateRecipe,
}))

import { DELETE, GET, PUT } from '@/app/api/recipes/[id]/route'

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
  ingredients: [],
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

function routeContext(id = 'recipe-1') {
  return { params: Promise.resolve({ id }) }
}

function makePutRequest(body: unknown): Request {
  return new Request('http://localhost/api/recipes/recipe-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeRawPutRequest(body: string): Request {
  return new Request('http://localhost/api/recipes/recipe-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

describe('/api/recipes/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCookie('user-123')
    mockCreateServiceRoleClient.mockReturnValue(supabase)
    mockGetRecipeWithIngredients.mockResolvedValue(recipe)
    mockDeleteRecipe.mockResolvedValue(undefined)
    mockUpdateRecipe.mockResolvedValue(undefined)
    tacoSingle.mockResolvedValue({ data: tacoRow, error: null })
  })

  describe('GET', () => {
    it('returns recipe for the authenticated user', async () => {
      const response = await GET(new Request('http://localhost/api/recipes/recipe-1'), routeContext())
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(mockCreateServiceRoleClient).toHaveBeenCalledOnce()
      expect(mockGetRecipeWithIngredients).toHaveBeenCalledWith(supabase, 'recipe-1', 'user-123')
      expect(body).toEqual({ recipe })
    })

    it('returns 401 when auth cookie is missing', async () => {
      setCookie()

      const response = await GET(new Request('http://localhost/api/recipes/recipe-1'), routeContext())
      const body = await response.json()

      expect(response.status).toBe(401)
      expect(body).toEqual({ error: 'Unauthorized' })
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
      expect(mockGetRecipeWithIngredients).not.toHaveBeenCalled()
    })

    it('returns 404 when recipe is not found', async () => {
      mockGetRecipeWithIngredients.mockRejectedValue(new Error('Recipe not found: no row returned'))

      const response = await GET(new Request('http://localhost/api/recipes/recipe-1'), routeContext())
      const body = await response.json()

      expect(response.status).toBe(404)
      expect(body).toEqual({ error: 'not_found' })
    })

    it('returns sanitized 500 when recipe loading fails unexpectedly', async () => {
      mockGetRecipeWithIngredients.mockRejectedValue(new Error('permission denied for table recipe_ingredients'))

      const response = await GET(new Request('http://localhost/api/recipes/recipe-1'), routeContext())
      const body = await response.json()

      expect(response.status).toBe(500)
      expect(body).toEqual({ error: 'internal_error' })
    })
  })

  describe('DELETE', () => {
    it('deletes recipe for the authenticated user', async () => {
      const response = await DELETE(
        new Request('http://localhost/api/recipes/recipe-1', { method: 'DELETE' }),
        routeContext(),
      )

      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect(mockCreateServiceRoleClient).toHaveBeenCalledOnce()
      expect(mockDeleteRecipe).toHaveBeenCalledWith(supabase, 'recipe-1', 'user-123')
    })

    it('returns 401 when auth cookie is missing', async () => {
      setCookie()

      const response = await DELETE(
        new Request('http://localhost/api/recipes/recipe-1', { method: 'DELETE' }),
        routeContext(),
      )
      const body = await response.json()

      expect(response.status).toBe(401)
      expect(body).toEqual({ error: 'Unauthorized' })
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled()
      expect(mockDeleteRecipe).not.toHaveBeenCalled()
    })

    it('returns sanitized 500 when delete fails', async () => {
      mockDeleteRecipe.mockRejectedValue(new Error('permission denied for table user_recipes'))

      const response = await DELETE(
        new Request('http://localhost/api/recipes/recipe-1', { method: 'DELETE' }),
        routeContext(),
      )
      const body = await response.json()

      expect(response.status).toBe(500)
      expect(body).toEqual({ error: 'delete_failed' })
    })

    it('returns 404 when delete reports recipe not found or not owned', async () => {
      mockDeleteRecipe.mockRejectedValue(new Error('Recipe not found or not owned by user'))

      const response = await DELETE(
        new Request('http://localhost/api/recipes/recipe-1', { method: 'DELETE' }),
        routeContext(),
      )
      const body = await response.json()

      expect(response.status).toBe(404)
      expect(body).toEqual({ error: 'not_found' })
    })
  })

  describe('PUT', () => {
    it('returns 400 when JSON is invalid', async () => {
      const response = await PUT(makeRawPutRequest('{invalid'), routeContext())
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_json' })
      expect(mockUpdateRecipe).not.toHaveBeenCalled()
    })

    it('returns 400 when body is invalid', async () => {
      const response = await PUT(makePutRequest({ ...validTacoBody(), name: '   ' }), routeContext())
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_body' })
      expect(mockUpdateRecipe).not.toHaveBeenCalled()
    })

    it('updates a TACO recipe using exact tacoId lookup and precomputed macros', async () => {
      const response = await PUT(makePutRequest(validTacoBody()), routeContext())
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ ok: true })
      expect(supabase.from).toHaveBeenCalledWith('taco_foods')
      expect(tacoSelect).toHaveBeenCalledWith(
        'id, food_name, category, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, food_base, food_variant, is_default',
      )
      expect(tacoEq).toHaveBeenCalledWith('id', 42)
      expect(tacoSingle).toHaveBeenCalledOnce()
      expect(mockUpdateRecipe).toHaveBeenCalledWith(
        supabase,
        'recipe-1',
        'user-123',
        expect.objectContaining({
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

    it('updates a user_label recipe without TACO lookup', async () => {
      const response = await PUT(makePutRequest(validUserLabelBody()), routeContext())
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ ok: true })
      expect(supabase.from).not.toHaveBeenCalled()
      expect(mockUpdateRecipe).toHaveBeenCalledWith(
        supabase,
        'recipe-1',
        'user-123',
        expect.objectContaining({
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

    it('returns 400 when computed values cannot fit persisted DB bounds', async () => {
      const response = await PUT(
        makePutRequest({
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
        routeContext(),
      )
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_body' })
      expect(mockUpdateRecipe).not.toHaveBeenCalled()
    })

    it('returns 422 when taco id is not found', async () => {
      tacoSingle.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'No rows found' },
      })

      const response = await PUT(makePutRequest(validTacoBody()), routeContext())
      const body = await response.json()

      expect(response.status).toBe(422)
      expect(body).toEqual({ error: 'taco_not_found', tacoId: 42 })
      expect(mockUpdateRecipe).not.toHaveBeenCalled()
    })

    it('returns 404 when update reports recipe not found or not owned', async () => {
      mockUpdateRecipe.mockRejectedValue(
        new Error('Failed to update recipe: Recipe not found or not owned by user'),
      )

      const response = await PUT(makePutRequest(validTacoBody()), routeContext())
      const body = await response.json()

      expect(response.status).toBe(404)
      expect(body).toEqual({ error: 'not_found' })
    })

    it('returns 409 when update fails because the name is duplicated', async () => {
      mockUpdateRecipe.mockRejectedValue(
        new Error('duplicate key value violates unique constraint'),
      )

      const response = await PUT(makePutRequest(validTacoBody()), routeContext())
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
