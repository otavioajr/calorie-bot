import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { getUserWithSettings } from '@/lib/db/queries/users'
import { parseRecipeIngredients } from '@/lib/llm/parsers/recipe-ingredients'
import { calculateMacros, SIMILARITY_THRESHOLD, type TacoFood } from '@/lib/db/queries/taco'

const BodySchema = z.object({
  text: z.string().trim().min(3).max(2000),
})

interface TacoRpcRow {
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

function mapTacoRow(row: TacoRpcRow): TacoFood {
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

async function lookupTacoFood(
  supabase: SupabaseClient,
  foodName: string,
): Promise<TacoFood | null> {
  const { data, error } = await supabase.rpc('match_taco_food', {
    query_name: foodName.toLowerCase(),
    threshold: SIMILARITY_THRESHOLD,
  })

  if (error) {
    throw new Error(error.message)
  }

  const rows = data as TacoRpcRow[] | null
  if (!rows || rows.length === 0) {
    return null
  }

  return mapTacoRow(rows[0])
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

  try {
    await getUserWithSettings(supabase, userId)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let parsedIngredients: Awaited<ReturnType<typeof parseRecipeIngredients>>
  try {
    parsedIngredients = await parseRecipeIngredients(parsedBody.data.text)
  } catch (error) {
    console.error('[recipes parse-ingredients] parser failed:', error)
    return NextResponse.json({ error: 'parse_failed' }, { status: 502 })
  }

  try {
    const enriched = await Promise.all(
      parsedIngredients.map(async (ingredient) => {
        const taco = await lookupTacoFood(supabase, ingredient.food)

        if (!taco) {
          return {
            foodName: ingredient.food,
            quantityGrams: ingredient.quantityGrams,
            source: 'unknown' as const,
            calories: 0,
            proteinG: 0,
            carbsG: 0,
            fatG: 0,
          }
        }

        const macros = calculateMacros(taco, ingredient.quantityGrams)

        return {
          foodName: ingredient.food,
          quantityGrams: ingredient.quantityGrams,
          source: 'taco' as const,
          tacoId: taco.id,
          tacoFoodBase: taco.foodBase,
          tacoFoodVariant: taco.foodVariant,
          calories: macros.calories,
          proteinG: macros.protein,
          carbsG: macros.carbs,
          fatG: macros.fat,
        }
      }),
    )

    return NextResponse.json({ ingredients: enriched })
  } catch (error) {
    console.error('[recipes parse-ingredients] TACO lookup failed:', error)
    return NextResponse.json({ error: 'taco_lookup_failed' }, { status: 502 })
  }
}
