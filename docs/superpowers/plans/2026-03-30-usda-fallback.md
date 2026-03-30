# USDA FoodData Central Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add USDA FoodData Central as a fallback nutrition source between TACO matching and decomposition, so supplements and non-Brazilian foods get accurate macros instead of being incorrectly decomposed.

**Architecture:** New `src/lib/usda/client.ts` module handles USDA API search with PT-BR→EN translation. The enrichment pipeline in `meal-log.ts` gains a USDA step between fuzzy TACO matching and decomposition. The decomposition feedback message is replaced with a generic "Encontrando os alimentos..." message sent once at the start.

**Tech Stack:** USDA FoodData Central REST API, existing LLM `chat()` for translation, Vitest for tests, MSW-style manual mocks.

---

### Task 1: Create USDA client with translation and search

**Files:**
- Create: `src/lib/usda/client.ts`
- Test: `tests/unit/usda/client.test.ts`

- [ ] **Step 1: Write the failing tests for `translateFoodName`**

Create `tests/unit/usda/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockChat = vi.fn()

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: vi.fn(() => ({
    chat: mockChat,
    analyzeMeal: vi.fn(),
    classifyIntent: vi.fn(),
    decomposeMeal: vi.fn(),
    analyzeImage: vi.fn(),
  })),
}))

// Must import after mock
import { translateFoodName, searchUSDAFood } from '@/lib/usda/client'

describe('translateFoodName', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('translates PT-BR food name to English via LLM', async () => {
    mockChat.mockResolvedValue('whey protein')

    const result = await translateFoodName('Proteína de soro de leite')

    expect(mockChat).toHaveBeenCalledWith(
      'Proteína de soro de leite',
      expect.stringContaining('Translate'),
    )
    expect(result).toBe('whey protein')
  })

  it('trims whitespace from LLM response', async () => {
    mockChat.mockResolvedValue('  whey protein  \n')

    const result = await translateFoodName('Proteína de soro de leite')

    expect(result).toBe('whey protein')
  })

  it('returns original name if translation fails', async () => {
    mockChat.mockRejectedValue(new Error('LLM error'))

    const result = await translateFoodName('Creatina')

    expect(result).toBe('Creatina')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/usda/client.test.ts`
Expected: FAIL — module `@/lib/usda/client` does not exist.

- [ ] **Step 3: Implement `translateFoodName`**

Create `src/lib/usda/client.ts`:

```typescript
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

export async function translateFoodName(foodNamePtBr: string): Promise<string> {
  try {
    const llm = getLLMProvider()
    const translated = await llm.chat(foodNamePtBr, TRANSLATE_PROMPT)
    return translated.trim()
  } catch {
    return foodNamePtBr
  }
}
```

- [ ] **Step 4: Run tests for `translateFoodName`**

Run: `npx vitest run tests/unit/usda/client.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Write failing tests for `searchUSDAFood`**

Add to `tests/unit/usda/client.test.ts`:

```typescript
// Add at top level, after existing imports:
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// USDA API response fixture
const usdaWheyResponse = {
  foods: [
    {
      fdcId: 456789,
      description: 'Whey protein powder, vanilla',
      foodNutrients: [
        { nutrientId: 1008, value: 400 },
        { nutrientId: 1003, value: 80 },
        { nutrientId: 1005, value: 10 },
        { nutrientId: 1004, value: 5 },
      ],
    },
  ],
}

const usdaEmptyResponse = { foods: [] }

const usdaIncompleteNutrientsResponse = {
  foods: [
    {
      fdcId: 111,
      description: 'Some food',
      foodNutrients: [
        { nutrientId: 1008, value: 200 },
        // missing protein, carbs, fat
      ],
    },
  ],
}

describe('searchUSDAFood', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChat.mockResolvedValue('whey protein')
    process.env.USDA_API_KEY = 'test-key'
  })

  it('returns macros scaled to quantity when USDA finds a match', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaWheyResponse,
    })

    const result = await searchUSDAFood('Proteína de soro de leite', 30)

    expect(result).not.toBeNull()
    expect(result!.fdcId).toBe(456789)
    expect(result!.calories).toBe(120) // 400 * 30/100
    expect(result!.protein).toBe(24)   // 80 * 30/100
    expect(result!.carbs).toBe(3)      // 10 * 30/100
    expect(result!.fat).toBe(1.5)      // 5 * 30/100
    expect(result!.food).toBe('Proteína de soro de leite')
    expect(result!.usdaFoodName).toBe('Whey protein powder, vanilla')
  })

  it('calls USDA API with translated name and correct params', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaWheyResponse,
    })

    await searchUSDAFood('Proteína de soro de leite', 30)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.nal.usda.gov/fdc/v1/foods/search'),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    )
    const calledUrl = mockFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain('query=whey+protein')
    expect(calledUrl).toContain('api_key=test-key')
    expect(calledUrl).toContain('pageSize=5')
  })

  it('returns null when USDA returns no results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaEmptyResponse,
    })

    const result = await searchUSDAFood('Comida inventada', 100)

    expect(result).toBeNull()
  })

  it('returns null when USDA results lack complete nutrients', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => usdaIncompleteNutrientsResponse,
    })

    const result = await searchUSDAFood('Some food', 100)

    expect(result).toBeNull()
  })

  it('returns null when API call fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const result = await searchUSDAFood('Whey protein', 30)

    expect(result).toBeNull()
  })

  it('returns null when API returns non-OK status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
    })

    const result = await searchUSDAFood('Whey protein', 30)

    expect(result).toBeNull()
  })

  it('returns null when USDA_API_KEY is not set', async () => {
    delete process.env.USDA_API_KEY

    const result = await searchUSDAFood('Whey protein', 30)

    expect(result).toBeNull()
  })
})
```

- [ ] **Step 6: Run tests to verify the new ones fail**

Run: `npx vitest run tests/unit/usda/client.test.ts`
Expected: `searchUSDAFood` tests FAIL — function not exported yet.

- [ ] **Step 7: Implement `searchUSDAFood`**

Add to `src/lib/usda/client.ts`:

```typescript
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

export async function searchUSDAFood(
  foodNamePtBr: string,
  quantityGrams: number,
): Promise<USDAResult | null> {
  try {
    const apiKey = process.env.USDA_API_KEY
    if (!apiKey) return null

    const translatedName = await translateFoodName(foodNamePtBr)

    const params = new URLSearchParams({
      api_key: apiKey,
      query: translatedName,
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

      // Find first result with all four required nutrients
      for (const food of data.foods) {
        const cal = extractNutrient(food.foodNutrients, NUTRIENT_IDS.ENERGY)
        const prot = extractNutrient(food.foodNutrients, NUTRIENT_IDS.PROTEIN)
        const carbs = extractNutrient(food.foodNutrients, NUTRIENT_IDS.CARBS)
        const fat = extractNutrient(food.foodNutrients, NUTRIENT_IDS.FAT)

        if (cal !== null && prot !== null && carbs !== null && fat !== null) {
          const scale = quantityGrams / 100
          return {
            food: foodNamePtBr,
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
  } catch {
    return null
  }
}
```

- [ ] **Step 8: Run all tests to verify they pass**

Run: `npx vitest run tests/unit/usda/client.test.ts`
Expected: All 10 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/usda/client.ts tests/unit/usda/client.test.ts
git commit -m "feat: add USDA FoodData Central client with translation and search"
```

---

### Task 2: Add feedback message formatter

**Files:**
- Modify: `src/lib/utils/formatters.ts`
- Modify: `tests/unit/utils/formatters.test.ts` (if exists, otherwise skip test — function is trivial)

- [ ] **Step 1: Add `formatSearchFeedback` to formatters**

Add to `src/lib/utils/formatters.ts`, after the `formatDecompositionFeedback` function:

```typescript
// ---------------------------------------------------------------------------
// formatSearchFeedback
// ---------------------------------------------------------------------------
export function formatSearchFeedback(): string {
  return 'Encontrando os alimentos... 🔍'
}
```

- [ ] **Step 2: Run existing tests to verify nothing broke**

Run: `npx vitest run tests/unit/utils/`
Expected: All existing tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/utils/formatters.ts
git commit -m "feat: add formatSearchFeedback formatter for generic enrichment feedback"
```

---

### Task 3: Integrate USDA into enrichment pipeline

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`
- Modify: `tests/unit/bot/meal-log.test.ts`

- [ ] **Step 1: Write failing test for USDA fallback in pipeline**

Add to `tests/unit/bot/meal-log.test.ts`. First, add the USDA mock at the top alongside the existing hoisted mocks:

Inside `vi.hoisted()`, add:
```typescript
mockSearchUSDAFood: vi.fn().mockResolvedValue(null),
```

Add the mock module after the existing `vi.mock` blocks:
```typescript
vi.mock('@/lib/usda/client', () => ({
  searchUSDAFood: mockSearchUSDAFood,
}))
```

Add the mock to the formatter mock — add `formatSearchFeedback`:
```typescript
// Inside the vi.mock('@/lib/utils/formatters', ...) block, add:
formatSearchFeedback: vi.fn().mockReturnValue('Encontrando os alimentos... 🔍'),
```

Also hoist `mockFormatSearchFeedback` inside `vi.hoisted()`:
```typescript
mockFormatSearchFeedback: vi.fn().mockReturnValue('Encontrando os alimentos... 🔍'),
```

Then add the test inside `describe('handleMealLog', () => {`:

```typescript
  // -------------------------------------------------------------------------
  // USDA fallback
  // -------------------------------------------------------------------------

  describe('USDA fallback', () => {
    it('uses USDA when TACO base and fuzzy both miss', async () => {
      // Setup: whey protein not in TACO
      mockMatchTacoByBase.mockResolvedValue([])
      mockFuzzyMatchTacoMultiple.mockResolvedValue(new Map())

      // USDA returns a match
      mockSearchUSDAFood.mockResolvedValue({
        food: 'Proteína de soro de leite',
        usdaFoodName: 'Whey protein powder',
        fdcId: 456789,
        calories: 120,
        protein: 24,
        carbs: 3,
        fat: 1.5,
      })

      const wheyAnalysis: MealAnalysis = {
        meal_type: 'breakfast',
        confidence: 'high',
        references_previous: false,
        reference_query: null,
        items: [{
          food: 'Proteína de soro de leite',
          quantity_grams: 30,
          quantity_display: '30g',
          quantity_source: 'user_provided',
          calories: null,
          protein: null,
          carbs: null,
          fat: null,
          confidence: 'high',
        }],
        unknown_items: [],
        needs_clarification: false,
        clarification_question: undefined,
      }
      mockAnalyzeMeal.mockResolvedValue([wheyAnalysis])

      const result = await handleMealLog(
        supabase,
        USER_ID,
        '30g whey protein',
        { ...mockUser, phone: '5511999999999' },
        null,
      )

      expect(result.completed).toBe(true)
      expect(mockSearchUSDAFood).toHaveBeenCalledWith('Proteína de soro de leite', 30)
      // Should NOT attempt decomposition
      expect(mockDecomposeMeal).not.toHaveBeenCalled()
    })

    it('falls through to decomposition when USDA returns null', async () => {
      mockMatchTacoByBase.mockResolvedValue([])
      mockFuzzyMatchTacoMultiple.mockResolvedValue(new Map())
      mockSearchUSDAFood.mockResolvedValue(null)

      // Decompose returns ingredients that match TACO
      mockDecomposeMeal.mockResolvedValue([
        { food: 'Farinha de trigo', quantity_grams: 50 },
      ])
      mockFuzzyMatchTacoMultiple
        .mockResolvedValueOnce(new Map()) // first call for main items
        .mockResolvedValueOnce(new Map([  // second call for decomposed ingredients
          ['farinha de trigo', { id: 10, foodName: 'Farinha, de trigo', category: null, caloriesPer100g: 360, proteinPer100g: 9.8, carbsPer100g: 75.1, fatPer100g: 1.4, fiberPer100g: 2.3, foodBase: 'Farinha', foodVariant: 'de trigo', isDefault: true }],
        ]))

      const compositeAnalysis: MealAnalysis = {
        meal_type: 'lunch',
        confidence: 'high',
        references_previous: false,
        reference_query: null,
        items: [{
          food: 'Pão caseiro',
          quantity_grams: 100,
          quantity_display: null,
          quantity_source: 'estimated',
          calories: null,
          protein: null,
          carbs: null,
          fat: null,
          confidence: 'medium',
        }],
        unknown_items: [],
        needs_clarification: false,
        clarification_question: undefined,
      }
      mockAnalyzeMeal.mockResolvedValue([compositeAnalysis])

      const result = await handleMealLog(
        supabase,
        USER_ID,
        'comi pão caseiro',
        { ...mockUser, phone: '5511999999999' },
        null,
      )

      expect(mockSearchUSDAFood).toHaveBeenCalledWith('Pão caseiro', 100)
      expect(mockDecomposeMeal).toHaveBeenCalled()
    })
  })
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/unit/bot/meal-log.test.ts`
Expected: FAIL — `mockSearchUSDAFood` not defined / USDA mock not wired.

- [ ] **Step 3: Implement USDA step in `enrichItemsWithTaco`**

Modify `src/lib/bot/flows/meal-log.ts`:

**Add import at the top:**
```typescript
import { searchUSDAFood } from '@/lib/usda/client'
import { formatSearchFeedback } from '@/lib/utils/formatters'
// (formatSearchFeedback replaces formatDecompositionFeedback in the import)
```

Update the import from formatters — replace `formatDecompositionFeedback` with `formatSearchFeedback`:
```typescript
import { formatMealBreakdown, formatMultiMealBreakdown, formatProgress, formatSearchFeedback, formatDefaultNotice } from '@/lib/utils/formatters'
```

**Modify `enrichItemsWithTaco` function.** Replace the section from Step 2 (fuzzy match) through Step 3 (decomposition) with:

After Step 1 (base matching), the current code collects `needsFuzzy` items. Keep that. After the fuzzy loop that populates `needsDecomposition`, add a new USDA step:

Replace lines 207-211 (the decomposition feedback message block):
```typescript
  // Step 3: Try USDA for items that didn't match TACO
  const needsDecompositionAfterUSDA: { item: MealItem; index: number }[] = []

  for (const { item, index } of needsDecomposition) {
    const usdaResult = await searchUSDAFood(item.food, item.quantity_grams)
    if (usdaResult) {
      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        quantityDisplay: item.quantity_display,
        calories: usdaResult.calories,
        protein: usdaResult.protein,
        carbs: usdaResult.carbs,
        fat: usdaResult.fat,
        source: 'usda',
      }
    } else {
      needsDecompositionAfterUSDA.push({ item, index })
    }
  }

  // Step 4: Decompose composite foods that didn't match TACO or USDA
  for (const { item, index } of needsDecompositionAfterUSDA) {
```

And update all references from `needsDecomposition` to `needsDecompositionAfterUSDA` in the decomposition loop that follows.

**Add generic feedback message** at the start of `enrichItemsWithTaco`, right after the function signature:

```typescript
  // Send generic feedback while enrichment runs
  if (phone) {
    await sendTextMessage(phone, formatSearchFeedback())
  }
```

**Remove the decomposition-specific feedback** (the block at lines 208-211 that sends `formatDecompositionFeedback`).

The full modified `enrichItemsWithTaco` function should look like:

```typescript
async function enrichItemsWithTaco(
  supabase: SupabaseClient,
  items: MealItem[],
  llm: ReturnType<typeof getLLMProvider>,
  userId: string,
  phone?: string,
): Promise<EnrichedItem[]> {
  const enriched: EnrichedItem[] = []
  const needsFuzzy: { item: MealItem; index: number }[] = []

  // Send generic feedback while enrichment runs
  if (phone) {
    await sendTextMessage(phone, formatSearchFeedback())
  }

  // Step 1: Try base-name matching first (most precise for generic names)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]

    if (item.calories !== null && item.calories !== undefined && item.calories > 0) {
      enriched.push({
        food: item.food,
        quantityGrams: item.quantity_grams,
        quantityDisplay: item.quantity_display,
        calories: item.calories,
        protein: item.protein ?? 0,
        carbs: item.carbs ?? 0,
        fat: item.fat ?? 0,
        source: 'user_provided',
      })
      continue
    }

    const baseResult = await resolveByBase(supabase, item.food)
    if (baseResult) {
      const macros = calculateMacros(baseResult.match, item.quantity_grams)
      enriched.push({
        food: item.food,
        quantityGrams: item.quantity_grams,
        quantityDisplay: item.quantity_display,
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        source: 'taco',
        tacoId: baseResult.match.id,
        usedDefault: baseResult.usedDefault,
        defaultFoodBase: baseResult.usedDefault ? baseResult.match.foodBase : undefined,
        defaultFoodVariant: baseResult.usedDefault ? baseResult.match.foodVariant : undefined,
      })
    } else {
      needsFuzzy.push({ item, index: i })
      enriched.push(null as unknown as EnrichedItem) // placeholder
    }
  }

  // Step 2: Fuzzy match for items that didn't match any base
  const needsUSDA: { item: MealItem; index: number }[] = []

  if (needsFuzzy.length > 0) {
    const fuzzyNames = needsFuzzy.map(d => d.item.food)
    const tacoMatches = await fuzzyMatchTacoMultiple(supabase, fuzzyNames)

    for (const { item, index } of needsFuzzy) {
      const tacoMatch = tacoMatches.get(item.food.toLowerCase())
      if (tacoMatch) {
        const macros = calculateMacros(tacoMatch, item.quantity_grams)
        enriched[index] = {
          food: item.food,
          quantityGrams: item.quantity_grams,
          quantityDisplay: item.quantity_display,
          calories: macros.calories,
          protein: macros.protein,
          carbs: macros.carbs,
          fat: macros.fat,
          source: 'taco',
          tacoId: tacoMatch.id,
        }
      } else {
        needsUSDA.push({ item, index })
      }
    }
  }

  // Step 3: Try USDA for items that didn't match TACO
  const needsDecomposition: { item: MealItem; index: number }[] = []

  for (const { item, index } of needsUSDA) {
    const usdaResult = await searchUSDAFood(item.food, item.quantity_grams)
    if (usdaResult) {
      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        quantityDisplay: item.quantity_display,
        calories: usdaResult.calories,
        protein: usdaResult.protein,
        carbs: usdaResult.carbs,
        fat: usdaResult.fat,
        source: 'usda',
      }
    } else {
      needsDecomposition.push({ item, index })
    }
  }

  // Step 4: Decompose composite foods that didn't match TACO or USDA
  for (const { item, index } of needsDecomposition) {
    try {
      const ingredients = await llm.decomposeMeal(item.food, item.quantity_grams)

      let totalCal = 0, totalProt = 0, totalCarbs = 0, totalFat = 0
      const unmatchedIngredients: typeof ingredients = []

      for (const ig of ingredients) {
        const baseResult = await resolveByBase(supabase, ig.food)
        if (baseResult) {
          const macros = calculateMacros(baseResult.match, ig.quantity_grams)
          totalCal += macros.calories
          totalProt += macros.protein
          totalCarbs += macros.carbs
          totalFat += macros.fat
        } else {
          unmatchedIngredients.push(ig)
        }
      }

      if (unmatchedIngredients.length > 0) {
        const ingredientNames = unmatchedIngredients.map(ig => ig.food)
        const ingredientMatches = await fuzzyMatchTacoMultiple(supabase, ingredientNames)

        for (const ig of unmatchedIngredients) {
          const match = ingredientMatches.get(ig.food.toLowerCase())

          if (match) {
            const macros = calculateMacros(match, ig.quantity_grams)
            totalCal += macros.calories
            totalProt += macros.protein
            totalCarbs += macros.carbs
            totalFat += macros.fat
          } else {
            try {
              const fallbackMeals = await llm.analyzeMeal(`${ig.quantity_grams}g de ${ig.food}`)
              const fallbackItem = fallbackMeals[0]?.items[0]
              if (fallbackItem) {
                totalCal += fallbackItem.calories ?? 0
                totalProt += fallbackItem.protein ?? 0
                totalCarbs += fallbackItem.carbs ?? 0
                totalFat += fallbackItem.fat ?? 0
              }
            } catch {
              // Silently skip
            }
          }
        }
      }

      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        quantityDisplay: item.quantity_display,
        calories: Math.round(totalCal),
        protein: Math.round(totalProt * 10) / 10,
        carbs: Math.round(totalCarbs * 10) / 10,
        fat: Math.round(totalFat * 10) / 10,
        source: totalCal > 0 ? 'taco_decomposed' : 'approximate',
      }
    } catch {
      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        quantityDisplay: item.quantity_display,
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        source: 'approximate',
      }
    }
  }

  return enriched
}
```

- [ ] **Step 4: Run all meal-log tests**

Run: `npx vitest run tests/unit/bot/meal-log.test.ts`
Expected: All tests PASS (existing + 2 new USDA tests).

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts tests/unit/bot/meal-log.test.ts
git commit -m "feat: integrate USDA fallback into enrichment pipeline

TACO base → TACO fuzzy → USDA search → Decompose → LLM fallback.
Replaces decomposition feedback with generic 'Encontrando os alimentos...' message."
```

---

### Task 4: Update environment config

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add USDA_API_KEY to `.env.example`**

Add at the end of `.env.example`:

```
# USDA FoodData Central (free — get key at https://fdc.nal.usda.gov/api-key-signup/)
USDA_API_KEY=
```

- [ ] **Step 2: Add actual USDA API key to `.env.local`**

Add to `.env.local`:
```
USDA_API_KEY=<actual-key>
```

Note: The user needs to sign up at https://fdc.nal.usda.gov/api-key-signup/ to get a key. The `DEMO_KEY` can be used for initial testing but has lower rate limits.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore: add USDA_API_KEY to .env.example"
```

---

### Task 5: TypeScript check and final verification

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 3: Verify the import chain is correct**

Check that `src/lib/usda/client.ts` is properly imported by `src/lib/bot/flows/meal-log.ts` and that no circular dependencies exist.

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Clean output, no errors.
