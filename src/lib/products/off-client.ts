import type { OffProduct } from './types'

const SEARCH_URL = 'https://search.openfoodfacts.org/search'
const PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product'
const USER_AGENT = `CalorieBot/1.0 (${process.env.OFF_USER_AGENT_CONTACT ?? 'caloriebot@example.com'})`
const TIMEOUT_MS = 3000
const RETRY_BACKOFF_MS = 500
const FIELDS = 'code,product_name,brands,nutriments,quantity,serving_size'

interface RawOffProduct {
  code?: string | number | null
  product_name?: string | null
  brands?: string | string[] | null
  nutriments?: Record<string, number | string | null | undefined> | null
  quantity?: string | null
  serving_size?: string | null
}

interface SearchResponse {
  hits?: RawOffProduct[]
}

interface ProductResponse {
  status?: number
  product?: RawOffProduct
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeCalories(nutriments: RawOffProduct['nutriments']): number | null {
  const kcal = toNumber(nutriments?.['energy-kcal_100g'])
  if (kcal !== null) return kcal

  const kj = toNumber(nutriments?.['energy-kj_100g'])
  return kj === null ? null : Math.round(kj / 4.184)
}

function normalizeBrand(brands: RawOffProduct['brands']): string | null {
  if (!brands) return null
  if (Array.isArray(brands)) {
    return brands.find((brand) => brand.trim().length > 0)?.trim() ?? null
  }

  const firstBrand = brands.split(',')[0]?.trim()
  return firstBrand ? firstBrand : null
}

function parseServingSizeG(servingSize: string | null | undefined): number | null {
  if (!servingSize) return null

  const match = servingSize.match(/(\d+(?:[,.]\d+)?)\s*g\b/i)
  if (!match) return null

  const grams = Number(match[1].replace(',', '.'))
  return Number.isFinite(grams) && grams > 0 ? grams : null
}

function isPlausibleNutrition(
  calories: number,
  protein: number,
  carbs: number,
  fat: number,
): boolean {
  if (calories < 20 || calories > 900) return false
  if (protein < 0 || protein > 100) return false
  if (carbs < 0 || carbs > 100) return false
  if (fat < 0 || fat > 100) return false

  const macroCalories = protein * 4 + carbs * 4 + fat * 9
  return Math.abs(macroCalories - calories) / calories <= 0.3
}

function mapProduct(product: RawOffProduct): OffProduct | null {
  const code = product.code?.toString().trim()
  const productName = product.product_name?.trim()
  if (!code || !productName) return null

  const caloriesPer100g = normalizeCalories(product.nutriments)
  const proteinPer100g = toNumber(product.nutriments?.proteins_100g)
  const carbsPer100g = toNumber(product.nutriments?.carbohydrates_100g)
  const fatPer100g = toNumber(product.nutriments?.fat_100g)

  if (
    caloriesPer100g === null ||
    proteinPer100g === null ||
    carbsPer100g === null ||
    fatPer100g === null
  ) {
    return null
  }

  if (!isPlausibleNutrition(caloriesPer100g, proteinPer100g, carbsPer100g, fatPer100g)) {
    return null
  }

  return {
    code,
    productName,
    brand: normalizeBrand(product.brands),
    caloriesPer100g,
    proteinPer100g,
    carbsPer100g,
    fatPer100g,
    fiberPer100g: toNumber(product.nutriments?.fiber_100g),
    servingSizeG: parseServingSizeG(product.serving_size),
    servingDisplay: product.serving_size ?? null,
    sourceUrl: `https://world.openfoodfacts.org/product/${code}`,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })

      if (response.ok) {
        return (await response.json()) as T
      }
    } catch {
      // Retry once, then return the caller's empty fallback.
    }

    if (attempt === 0) {
      await delay(RETRY_BACKOFF_MS)
    }
  }

  return null
}

export async function searchByName(query: string): Promise<OffProduct[]> {
  const params = new URLSearchParams({
    q: query,
    page_size: '10',
    fields: FIELDS,
  })
  const data = await fetchJson<SearchResponse>(`${SEARCH_URL}?${params.toString()}`)
  if (!data?.hits) return []

  return data.hits
    .map(mapProduct)
    .filter((product): product is OffProduct => product !== null)
    .sort((a, b) => {
      if (a.brand && !b.brand) return -1
      if (!a.brand && b.brand) return 1
      return a.productName.length - b.productName.length
    })
    .slice(0, 5)
}

export async function getByBarcode(barcode: string): Promise<OffProduct | null> {
  const url = `${PRODUCT_URL}/${encodeURIComponent(barcode)}.json`
  const data = await fetchJson<ProductResponse>(url)
  if (data?.status !== 1 || !data.product) return null

  return mapProduct(data.product)
}
