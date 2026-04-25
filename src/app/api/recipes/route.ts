import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { createRecipe, getRecipesByUser } from '@/lib/db/queries/recipes'
import type { TacoFood } from '@/lib/db/queries/taco'
import { computeRecipeMacros } from '@/lib/recipes/compute'
import type { ComputedRecipeMacros, LabelOverride, RecipeIngredientInput } from '@/lib/recipes/types'

const TACO_SELECT =
  'id, food_name, category, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, food_base, food_variant, is_default'

const NUMERIC_8_2_MAX = 999999.99
const NUMERIC_5_2_MAX = 999.99
const SMALLINT_MAX = 32767

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  if (!Number.isFinite(value)) return false

  const cents = value * 100
  return Math.abs(Math.round(cents) - cents) < 1e-9
}

const Decimal2Schema = z
  .number()
  .refine(hasAtMostTwoDecimalPlaces)

const LabelOverrideSchema = z.object({
  kcalPer100g: z.number().nonnegative().max(900),
  proteinPer100g: z.number().nonnegative().max(100),
  carbsPer100g: z.number().nonnegative().max(100),
  fatPer100g: z.number().nonnegative().max(100),
  fiberPer100g: z.number().nonnegative().max(100).optional(),
  sodiumPer100g: z.number().nonnegative().max(100000).optional(),
})

const TacoIngredientSchema = z.object({
  foodName: z.string().trim().min(1),
  quantityGrams: Decimal2Schema.min(0.01).max(NUMERIC_8_2_MAX),
  source: z.literal('taco'),
  tacoId: z.number().int().positive(),
  displayOrder: z.number().int().nonnegative().max(SMALLINT_MAX),
})

const UserLabelIngredientSchema = z.object({
  foodName: z.string().trim().min(1),
  quantityGrams: Decimal2Schema.min(0.01).max(NUMERIC_8_2_MAX),
  source: z.literal('user_label'),
  labelOverride: LabelOverrideSchema,
  displayOrder: z.number().int().nonnegative().max(SMALLINT_MAX),
})

const BodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  totalWeightGrams: Decimal2Schema.min(0.01).max(NUMERIC_8_2_MAX),
  servings: Decimal2Schema.min(0.01).max(NUMERIC_5_2_MAX),
  notes: z.string().trim().max(1000).optional(),
  ingredients: z
    .array(z.discriminatedUnion('source', [TacoIngredientSchema, UserLabelIngredientSchema]))
    .min(1)
    .max(50),
})

interface TacoRow {
  id: number
  food_name: string
  category?: string | null
  calories_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  fiber_per_100g: number
  food_base: string
  food_variant: string
  is_default: boolean
}

class TacoNotFoundError extends Error {
  constructor(readonly tacoId: number) {
    super('TACO row not found')
  }
}

function mapTacoRow(row: TacoRow): TacoFood {
  return {
    id: row.id,
    foodName: row.food_name,
    category: row.category ?? null,
    caloriesPer100g: row.calories_per_100g,
    proteinPer100g: row.protein_per_100g,
    carbsPer100g: row.carbs_per_100g,
    fatPer100g: row.fat_per_100g,
    fiberPer100g: row.fiber_per_100g,
    foodBase: row.food_base,
    foodVariant: row.food_variant,
    isDefault: row.is_default,
  }
}

async function lookupTacoById(supabase: SupabaseClient, tacoId: number): Promise<TacoFood> {
  const { data, error } = await supabase
    .from('taco_foods')
    .select(TACO_SELECT)
    .eq('id', tacoId)
    .single()

  if (error?.code === 'PGRST116' || (!error && !data)) {
    throw new TacoNotFoundError(tacoId)
  }

  if (error) {
    throw new Error('taco_lookup_failed')
  }

  return mapTacoRow(data as TacoRow)
}

function isDuplicateCreateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  return message.includes('duplicate') || message.includes('unique constraint')
}

function isPersistedNumericInRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= NUMERIC_8_2_MAX
}

function areComputedMacrosPersistable(macros: ComputedRecipeMacros): boolean {
  const recipeMacroValues = [
    macros.totalProteinG,
    macros.totalCarbsG,
    macros.totalFatG,
    macros.totalCalories,
    macros.perServingCalories,
    macros.perServingProteinG,
    macros.perServingCarbsG,
    macros.perServingFatG,
  ]

  const ingredientValues = macros.ingredientMacros.flatMap((ingredient) => [
    ingredient.calories,
    ingredient.proteinG,
    ingredient.carbsG,
    ingredient.fatG,
  ])

  return (
    Number.isFinite(macros.weightPerServingGrams) &&
    macros.weightPerServingGrams > 0 &&
    macros.weightPerServingGrams <= NUMERIC_8_2_MAX &&
    [...recipeMacroValues, ...ingredientValues].every(isPersistedNumericInRange)
  )
}

export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceRoleClient()
    const recipes = await getRecipesByUser(supabase, userId)

    return NextResponse.json({ recipes })
  } catch {
    return NextResponse.json({ error: 'load_failed' }, { status: 500 })
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsedBody = BodySchema.safeParse(rawBody)
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const supabase = createServiceRoleClient()
  const { name, totalWeightGrams, servings, notes, ingredients } = parsedBody.data

  try {
    const tacoFoodsById = new Map<number, TacoFood>()

    for (const ingredient of ingredients) {
      if (ingredient.source === 'taco' && !tacoFoodsById.has(ingredient.tacoId)) {
        tacoFoodsById.set(ingredient.tacoId, await lookupTacoById(supabase, ingredient.tacoId))
      }
    }

    const recipeIngredients: RecipeIngredientInput[] = ingredients.map((ingredient) => {
      if (ingredient.source === 'taco') {
        const tacoFood = tacoFoodsById.get(ingredient.tacoId)
        if (!tacoFood) {
          throw new TacoNotFoundError(ingredient.tacoId)
        }

        return {
          foodName: ingredient.foodName,
          quantityGrams: ingredient.quantityGrams,
          source: 'taco',
          tacoId: ingredient.tacoId,
          tacoFoodBase: tacoFood.foodBase,
          tacoFoodVariant: tacoFood.foodVariant,
          displayOrder: ingredient.displayOrder,
        }
      }

      return {
        foodName: ingredient.foodName,
        quantityGrams: ingredient.quantityGrams,
        source: 'user_label',
        labelOverride: ingredient.labelOverride as LabelOverride,
        displayOrder: ingredient.displayOrder,
      }
    })

    const precomputedMacros = computeRecipeMacros({
      totalWeightGrams,
      servings,
      ingredients: ingredients.map((ingredient) => {
        if (ingredient.source === 'taco') {
          return {
            foodName: ingredient.foodName,
            quantityGrams: ingredient.quantityGrams,
            source: 'taco',
            tacoFood: tacoFoodsById.get(ingredient.tacoId),
            displayOrder: ingredient.displayOrder,
          }
        }

        return {
          foodName: ingredient.foodName,
          quantityGrams: ingredient.quantityGrams,
          source: 'user_label',
          labelOverride: ingredient.labelOverride,
          displayOrder: ingredient.displayOrder,
        }
      }),
    })

    if (!areComputedMacrosPersistable(precomputedMacros)) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }

    const id = await createRecipe(supabase, {
      userId,
      name,
      totalWeightGrams,
      servings,
      notes,
      ingredients: recipeIngredients,
      precomputedMacros,
    })

    return NextResponse.json({ id }, { status: 201 })
  } catch (error) {
    if (error instanceof TacoNotFoundError) {
      return NextResponse.json(
        { error: 'taco_not_found', tacoId: error.tacoId },
        { status: 422 },
      )
    }

    if (error instanceof Error && error.message === 'taco_lookup_failed') {
      return NextResponse.json({ error: 'taco_lookup_failed' }, { status: 502 })
    }

    if (isDuplicateCreateError(error)) {
      return NextResponse.json({ error: 'duplicate_name' }, { status: 409 })
    }

    return NextResponse.json({ error: 'create_failed' }, { status: 500 })
  }
}
