import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { parseRecipeIngredients } from '@/lib/llm/parsers/recipe-ingredients'
import { calculateMacros, fuzzyMatchTaco } from '@/lib/db/queries/taco'

const BodySchema = z.object({
  text: z.string().trim().min(3).max(2000),
})

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  let parsedIngredients: Awaited<ReturnType<typeof parseRecipeIngredients>>
  try {
    parsedIngredients = await parseRecipeIngredients(parsedBody.data.text)
  } catch (error) {
    return NextResponse.json(
      { error: 'parse_failed', detail: errorDetail(error) },
      { status: 502 },
    )
  }

  const enriched = await Promise.all(
    parsedIngredients.map(async (ingredient) => {
      const taco = await fuzzyMatchTaco(supabase, ingredient.food)

      if (!taco) {
        return {
          food: ingredient.food,
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
        food: ingredient.food,
        quantityGrams: ingredient.quantityGrams,
        source: 'taco' as const,
        tacoId: taco.id,
        tacoBase: taco.foodBase,
        tacoVariant: taco.foodVariant,
        calories: macros.calories,
        proteinG: macros.protein,
        carbsG: macros.carbs,
        fatG: macros.fat,
      }
    }),
  )

  return NextResponse.json({ ingredients: enriched })
}
