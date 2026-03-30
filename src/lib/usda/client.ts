import { getLLMProvider } from '@/lib/llm/index'
import type { SupabaseClient } from '@supabase/supabase-js'

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
// Debug logging helper (uses caller-provided supabase client)
// ---------------------------------------------------------------------------

function debugLog(supabase: SupabaseClient | undefined, data: Record<string, unknown>) {
  if (!supabase) return
  try {
    supabase.from?.('llm_usage_log')?.insert?.({
      provider: 'debug',
      model: JSON.stringify(data).substring(0, 255),
      function_type: 'debug_usda',
      latency_ms: 0,
      success: !!data.ok,
    })?.then?.(() => {}, () => {})
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

const TRANSLATE_PROMPT = `Translate the following Brazilian Portuguese food name to English.
Return ONLY the English name, nothing else. No quotes, no explanation.`

export async function translateFoodName(foodNamePtBr: string): Promise<{ text: string; alreadyEnglish: boolean } | null> {
  try {
    const llm = getLLMProvider()
    const translated = await llm.chat(foodNamePtBr, TRANSLATE_PROMPT)
    const trimmed = translated.trim()
    // Same text = already in English (e.g., LLM returned "Whey protein" for input "Whey protein")
    if (trimmed.toLowerCase() === foodNamePtBr.toLowerCase()) {
      return { text: foodNamePtBr, alreadyEnglish: true }
    }
    return { text: trimmed, alreadyEnglish: false }
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
  dbClient?: SupabaseClient,
): Promise<USDAResult | null> {
  try {
    const apiKey = process.env.USDA_API_KEY
    if (!apiKey) {
      debugLog(dbClient, { step: 'no_api_key', food: foodNamePtBr })
      return null
    }

    const translation = await translateFoodName(foodNamePtBr)
    if (!translation) {
      debugLog(dbClient, { step: 'translation_failed', food: foodNamePtBr })
      return null
    }
    const translatedName = translation.text
    debugLog(dbClient, { step: 'translated', food: foodNamePtBr, to: translatedName, eng: translation.alreadyEnglish, ok: true })

    const result = await queryUSDA(translatedName, apiKey, quantityGrams, foodNamePtBr)
    debugLog(dbClient, { step: 'usda_result', food: foodNamePtBr, q: translatedName, found: !!result, cal: result?.calories, ok: !!result })
    return result
  } catch (err) {
    debugLog(dbClient, { step: 'exception', food: foodNamePtBr, err: String(err).substring(0, 100) })
    return null
  }
}
