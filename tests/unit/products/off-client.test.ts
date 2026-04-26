import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { getByBarcode, searchByName } from '@/lib/products/off-client'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const searchUrl = 'https://search.openfoodfacts.org/search'
const productUrl = 'https://world.openfoodfacts.org/api/v2/product/:code.json'

function validProduct(overrides: Record<string, unknown> = {}) {
  return {
    code: '7891000315507',
    product_name: 'Magic Toast Tradicional',
    brands: 'Marilan',
    nutriments: {
      'energy-kcal_100g': 420,
      proteins_100g: 9,
      carbohydrates_100g: 72,
      fat_100g: 10,
      fiber_100g: 3,
    },
    quantity: '150 g',
    serving_size: '30 g (4 unidades)',
    ...overrides,
  }
}

describe('searchByName', () => {
  it('calls OFF search with required fields, user-agent, and returns top candidates sorted by brand then shorter name', async () => {
    let capturedRequest: Request | null = null

    server.use(
      http.get(searchUrl, ({ request }) => {
        capturedRequest = request.clone()
        return HttpResponse.json({
          count: 7,
          hits: [
            validProduct({
              code: '1',
              product_name: 'Magic Toast Integral Longo',
              brands: null,
            }),
            validProduct({
              code: '2',
              product_name: 'Magic Toast Tradicional',
              brands: 'Marilan, Other',
            }),
            validProduct({
              code: '3',
              product_name: 'Magic Toast',
              brands: 'Bauducco',
            }),
            validProduct({ code: '4', product_name: 'Produto Quatro' }),
            validProduct({ code: '5', product_name: 'Produto Cinco' }),
            validProduct({ code: '6', product_name: 'Produto Seis' }),
            validProduct({ code: '7', product_name: 'Produto Sete' }),
          ],
        })
      }),
    )

    const result = await searchByName('magic toast')

    expect(result).toHaveLength(5)
    expect(result.map((item) => item.code)).toEqual(['3', '6', '7', '5', '4'])
    expect(result[0]).toMatchObject({
      code: '3',
      productName: 'Magic Toast',
      brand: 'Bauducco',
      caloriesPer100g: 420,
      proteinPer100g: 9,
      carbsPer100g: 72,
      fatPer100g: 10,
      fiberPer100g: 3,
      servingSizeG: 30,
      servingDisplay: '30 g (4 unidades)',
      sourceUrl: 'https://world.openfoodfacts.org/product/3',
    })

    expect(capturedRequest).not.toBeNull()
    const request = capturedRequest as unknown as Request
    const url = new URL(request.url)
    expect(url.searchParams.get('q')).toBe('magic toast')
    expect(url.searchParams.get('page_size')).toBe('10')
    expect(url.searchParams.get('fields')).toBe(
      'code,product_name,brands,nutriments,quantity,serving_size',
    )
    expect(request.headers.get('User-Agent')).toBe('CalorieBot/1.0 (otavioajr@gmail.com)')
  })

  it('converts energy-kj_100g when energy-kcal_100g is missing', async () => {
    server.use(
      http.get(searchUrl, () => {
        return HttpResponse.json({
          hits: [
            validProduct({
              code: 'kj-only',
              nutriments: {
                'energy-kj_100g': 1757,
                proteins_100g: 9,
                carbohydrates_100g: 72,
                fat_100g: 10,
              },
            }),
          ],
        })
      }),
    )

    const result = await searchByName('magic toast')

    expect(result).toHaveLength(1)
    expect(result[0].caloriesPer100g).toBe(420)
  })

  it('drops products with implausible kcal, macro ranges, or macro-calorie totals', async () => {
    server.use(
      http.get(searchUrl, () => {
        return HttpResponse.json({
          hits: [
            validProduct({
              code: 'too-low',
              nutriments: {
                'energy-kcal_100g': 10,
                proteins_100g: 1,
                carbohydrates_100g: 1,
                fat_100g: 0,
              },
            }),
            validProduct({
              code: 'macro-range',
              nutriments: {
                'energy-kcal_100g': 420,
                proteins_100g: 101,
                carbohydrates_100g: 72,
                fat_100g: 10,
              },
            }),
            validProduct({
              code: 'macro-total',
              nutriments: {
                'energy-kcal_100g': 100,
                proteins_100g: 50,
                carbohydrates_100g: 50,
                fat_100g: 50,
              },
            }),
            validProduct({ code: 'ok' }),
          ],
        })
      }),
    )

    const result = await searchByName('magic toast')

    expect(result.map((item) => item.code)).toEqual(['ok'])
  })

  it('retries once after a failed response and returns [] if both attempts fail', async () => {
    let attempts = 0
    server.use(
      http.get(searchUrl, () => {
        attempts++
        if (attempts === 1) {
          return HttpResponse.json({ error: 'temporarily unavailable' }, { status: 503 })
        }
        return HttpResponse.json({ hits: [validProduct({ code: 'retry-ok' })] })
      }),
    )

    await expect(searchByName('magic toast')).resolves.toMatchObject([{ code: 'retry-ok' }])
    expect(attempts).toBe(2)

    server.use(http.get(searchUrl, () => HttpResponse.json({}, { status: 500 })))

    await expect(searchByName('magic toast')).resolves.toEqual([])
  })

  it('returns [] on timeout', async () => {
    server.use(
      http.get(searchUrl, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        return HttpResponse.json({ hits: [validProduct()] })
      }),
    )

    await expect(searchByName('magic toast')).resolves.toEqual([])
  }, 8000)
})

describe('getByBarcode', () => {
  it('fetches OFF product by barcode and maps a valid response', async () => {
    let capturedRequest: Request | null = null

    server.use(
      http.get(productUrl, ({ request }) => {
        capturedRequest = request.clone()
        return HttpResponse.json({
          status: 1,
          product: validProduct({ code: '7891000315507' }),
        })
      }),
    )

    const result = await getByBarcode('7891000315507')

    expect(result).toMatchObject({
      code: '7891000315507',
      productName: 'Magic Toast Tradicional',
      brand: 'Marilan',
      caloriesPer100g: 420,
    })

    expect(capturedRequest).not.toBeNull()
    const request = capturedRequest as unknown as Request
    expect(request.url).toBe(
      'https://world.openfoodfacts.org/api/v2/product/7891000315507.json',
    )
    expect(request.headers.get('User-Agent')).toBe('CalorieBot/1.0 (otavioajr@gmail.com)')
  })

  it('returns null when barcode is not found or the product is implausible', async () => {
    server.use(
      http.get(productUrl, () => {
        return HttpResponse.json({ status: 0 })
      }),
    )

    await expect(getByBarcode('000')).resolves.toBeNull()

    server.use(
      http.get(productUrl, () => {
        return HttpResponse.json({
          status: 1,
          product: validProduct({
            nutriments: {
              'energy-kcal_100g': 1000,
              proteins_100g: 9,
              carbohydrates_100g: 72,
              fat_100g: 10,
            },
          }),
        })
      }),
    )

    await expect(getByBarcode('789')).resolves.toBeNull()
  })

  it('retries once and returns null on repeated failure', async () => {
    let attempts = 0
    server.use(
      http.get(productUrl, () => {
        attempts++
        if (attempts === 1) {
          return HttpResponse.error()
        }
        return HttpResponse.json({
          status: 1,
          product: validProduct({ code: 'after-retry' }),
        })
      }),
    )

    await expect(getByBarcode('789')).resolves.toMatchObject({ code: 'after-retry' })
    expect(attempts).toBe(2)

    server.use(http.get(productUrl, () => HttpResponse.error()))

    await expect(getByBarcode('789')).resolves.toBeNull()
  })
})
