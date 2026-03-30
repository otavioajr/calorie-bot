import { NextResponse } from 'next/server'
import { searchUSDAFood, translateFoodName } from '@/lib/usda/client'

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const food = searchParams.get('food') || 'Proteína de soro de leite'
  const grams = parseInt(searchParams.get('grams') || '30', 10)

  const result: Record<string, unknown> = {
    input: { food, grams },
    env: {
      USDA_API_KEY: process.env.USDA_API_KEY ? `set(${process.env.USDA_API_KEY.length}chars)` : 'NOT SET',
      LLM_MODEL_MEAL: process.env.LLM_MODEL_MEAL || 'default',
      LLM_API_KEY: process.env.LLM_API_KEY ? 'set' : 'NOT SET',
    },
  }

  // Test translation
  try {
    const translation = await translateFoodName(food)
    result.translation = translation
  } catch (err) {
    result.translation = { error: String(err) }
  }

  // Test raw USDA API directly
  try {
    const apiKey = process.env.USDA_API_KEY!
    const query = result.translation && typeof result.translation === 'object' && 'text' in result.translation
      ? (result.translation as { text: string }).text
      : food
    const params = new URLSearchParams({
      api_key: apiKey,
      query,
      dataType: 'SR Legacy,Branded',
      pageSize: '3',
    })
    const usdaUrl = `https://api.nal.usda.gov/fdc/v1/foods/search?${params}`
    const rawRes = await fetch(usdaUrl)
    const rawData = await rawRes.json()
    result.rawUsda = {
      status: rawRes.status,
      foodCount: rawData.foods?.length ?? 0,
      firstFood: rawData.foods?.[0] ? {
        description: rawData.foods[0].description,
        nutrients: rawData.foods[0].foodNutrients?.slice(0, 10).map((n: { nutrientId: number; nutrientName: string; value: number }) => ({
          id: n.nutrientId,
          name: n.nutrientName,
          value: n.value,
        })),
      } : null,
    }
  } catch (err) {
    result.rawUsda = { error: String(err) }
  }

  // Test full search
  try {
    const usda = await searchUSDAFood(food, grams)
    result.usda = usda
  } catch (err) {
    result.usda = { error: String(err) }
  }

  return NextResponse.json(result)
}
