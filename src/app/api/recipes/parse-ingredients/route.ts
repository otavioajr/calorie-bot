import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { parseRecipeIngredients } from '@/lib/llm/parsers/recipe-ingredients'
import { calculateMacros, fuzzyMatchTaco } from '@/lib/db/queries/taco'
import { verifyUserExists } from '@/lib/db/queries/users'

const BodySchema = z.object({
  text: z.string().trim().min(3).max(2000),
})

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

  let userExists: boolean
  try {
    userExists = await verifyUserExists(supabase, userId)
  } catch (error) {
    console.error('[recipes parse-ingredients] auth lookup failed:', error)
    return NextResponse.json({ error: 'auth_lookup_failed' }, { status: 503 })
  }

  if (!userExists) {
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
        const taco = await fuzzyMatchTaco(supabase, ingredient.food, { throwOnError: true })

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
