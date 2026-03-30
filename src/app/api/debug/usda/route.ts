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

  // Test full search
  try {
    const usda = await searchUSDAFood(food, grams)
    result.usda = usda
  } catch (err) {
    result.usda = { error: String(err) }
  }

  return NextResponse.json(result)
}
