import { getLLMProvider } from '@/lib/llm/index'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface USDAResult {
  food: string
  usdaFoodName: string
  fdcId: number
  calories: number
  protein: number
  carbs: number
  fat: number
}

// ---------------------------------------------------------------------------
// USDA nutrient IDs
// ---------------------------------------------------------------------------

const NUTRIENT_IDS = {
  ENERGY: 1008,
  PROTEIN: 1003,
  CARBS: 1005,
  FAT: 1004,
} as const

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

const TRANSLATE_PROMPT = `Translate the following Brazilian Portuguese food name to English.
Return ONLY the English name, nothing else. No quotes, no explanation.`

export async function translateFoodName(foodNamePtBr: string): Promise<string | null> {
  try {
    const llm = getLLMProvider()
    const translated = await llm.chat(foodNamePtBr, TRANSLATE_PROMPT)
    const trimmed = translated.trim()
    if (trimmed.toLowerCase() === foodNamePtBr.toLowerCase()) return null
    return trimmed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// USDA Search
// ---------------------------------------------------------------------------

const USDA_BASE_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search'
const USDA_TIMEOUT_MS = 5000

interface USDAFoodNutrient {
  nutrientId: number
  value: number
}

interface USDAFoodResult {
  fdcId: number
  description: string
  foodNutrients: USDAFoodNutrient[]
}

interface USDASearchResponse {
  foods: USDAFoodResult[]
}

function extractNutrient(nutrients: USDAFoodNutrient[], nutrientId: number): number | null {
  const found = nutrients.find(n => n.nutrientId === nutrientId)
  return found ? found.value : null
}

async function queryUSDA(
  query: string,
  apiKey: string,
  quantityGrams: number,
  originalName: string,
): Promise<USDAResult | null> {
  const params = new URLSearchParams({
    api_key: apiKey,
    query,
    dataType: 'SR Legacy,Branded',
    pageSize: '5',
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), USDA_TIMEOUT_MS)

  try {
    const response = await fetch(`${USDA_BASE_URL}?${params}`, {
      signal: controller.signal,
    })

    if (!response.ok) return null

    const data: USDASearchResponse = await response.json()

    if (!data.foods || data.foods.length === 0) return null

    for (const food of data.foods) {
      const cal = extractNutrient(food.foodNutrients, NUTRIENT_IDS.ENERGY)
      const prot = extractNutrient(food.foodNutrients, NUTRIENT_IDS.PROTEIN)
      const carbs = extractNutrient(food.foodNutrients, NUTRIENT_IDS.CARBS)
      const fat = extractNutrient(food.foodNutrients, NUTRIENT_IDS.FAT)

      if (cal !== null && prot !== null && carbs !== null && fat !== null) {
        const scale = quantityGrams / 100
        return {
          food: originalName,
          usdaFoodName: food.description,
          fdcId: food.fdcId,
          calories: Math.round(cal * scale),
          protein: Math.round(prot * scale * 10) / 10,
          carbs: Math.round(carbs * scale * 10) / 10,
          fat: Math.round(fat * scale * 10) / 10,
        }
      }
    }

    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function searchUSDAFood(
  foodNamePtBr: string,
  quantityGrams: number,
): Promise<USDAResult | null> {
  try {
    const apiKey = process.env.USDA_API_KEY
    if (!apiKey) {
      console.log('[USDA] No API key, skipping')
      return null
    }

    console.log('[USDA] Translating:', foodNamePtBr)
    const translatedName = await translateFoodName(foodNamePtBr)
    if (!translatedName) {
      console.log('[USDA] Translation failed, skipping')
      return null
    }
    console.log('[USDA] Translated to:', translatedName)

    console.log('[USDA] Querying API...')
    const result = await queryUSDA(translatedName, apiKey, quantityGrams, foodNamePtBr)
    console.log('[USDA] Result:', result ? `${result.usdaFoodName} (${result.calories} kcal)` : 'null')
    return result
  } catch (err) {
    console.error('[USDA] Error:', err)
    return null
  }
}
