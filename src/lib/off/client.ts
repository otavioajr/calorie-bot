// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OFFResult {
  food: string        // nome original PT-BR passado pelo caller
  offFoodName: string // nome retornado pelo OFF
  offId: string       // id do produto no OFF
  calories: number    // kcal escaladas para quantityGrams
  protein: number     // gramas escaladas
  carbs: number       // gramas escaladas
  fat: number         // gramas escaladas
}

// ---------------------------------------------------------------------------
// OFF API types
// ---------------------------------------------------------------------------

interface OFFNutriments {
  'energy-kcal_100g'?: number
  proteins_100g?: number
  carbohydrates_100g?: number
  fat_100g?: number
}

interface OFFProduct {
  id: string
  product_name: string
  completeness: number
  nutriments: OFFNutriments
}

interface OFFSearchResponse {
  products: OFFProduct[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OFF_BASE_URL = 'https://world.openfoodfacts.org/cgi/search.pl'
const OFF_TIMEOUT_MS = 5000
const OFF_USER_AGENT = 'CalorieBot/1.0 (contato@caloriebot.app)'
const OFF_MIN_COMPLETENESS = 0.5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidProduct(product: OFFProduct): boolean {
  const n = product.nutriments
  return (
    product.completeness >= OFF_MIN_COMPLETENESS &&
    typeof n['energy-kcal_100g'] === 'number' &&
    n['energy-kcal_100g'] > 0 &&
    typeof n.proteins_100g === 'number' &&
    typeof n.carbohydrates_100g === 'number' &&
    typeof n.fat_100g === 'number'
  )
}

function scaleResult(product: OFFProduct, originalName: string, quantityGrams: number): OFFResult {
  const n = product.nutriments
  const scale = quantityGrams / 100
  return {
    food: originalName,
    offFoodName: product.product_name,
    offId: product.id,
    calories: Math.round(n['energy-kcal_100g']! * scale),
    protein: Math.round(n.proteins_100g! * scale * 10) / 10,
    carbs: Math.round(n.carbohydrates_100g! * scale * 10) / 10,
    fat: Math.round(n.fat_100g! * scale * 10) / 10,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function searchOFFFood(
  foodNamePtBr: string,
  quantityGrams: number,
): Promise<OFFResult | null> {
  const params = new URLSearchParams({
    search_terms: foodNamePtBr,
    search_simple: '1',
    action: 'process',
    json: '1',
    fields: 'product_name,nutriments,completeness,id',
    page_size: '5',
    cc: 'br',
    lc: 'pt',
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OFF_TIMEOUT_MS)

  try {
    const response = await fetch(`${OFF_BASE_URL}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': OFF_USER_AGENT },
    })

    if (!response.ok) return null

    const data: OFFSearchResponse = await response.json()

    if (!data.products || data.products.length === 0) return null

    for (const product of data.products) {
      if (isValidProduct(product)) {
        return scaleResult(product, foodNamePtBr, quantityGrams)
      }
    }

    return null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
