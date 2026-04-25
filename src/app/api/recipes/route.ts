import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { createRecipe, getRecipesByUser } from '@/lib/db/queries/recipes'
import { lookupTacoById, type TacoFood } from '@/lib/db/queries/taco'
import { computeRecipeMacros } from '@/lib/recipes/compute'
import type { LabelOverride, RecipeIngredientInput } from '@/lib/recipes/types'
import { TacoNotFoundError, isDuplicateRecipeNameError } from '@/lib/recipes/errors'
import { RecipeBodySchema, areComputedMacrosPersistable } from '@/lib/recipes/validation'

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

  const parsedBody = RecipeBodySchema.safeParse(rawBody)
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

    if (isDuplicateRecipeNameError(error)) {
      return NextResponse.json({ error: 'duplicate_name' }, { status: 409 })
    }

    return NextResponse.json({ error: 'create_failed' }, { status: 500 })
  }
}
