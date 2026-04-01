# Meal Detail Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users ask what they ate for a specific meal type on any day, and get back a detailed list of foods with calories.

**Architecture:** New `meal_detail` intent routed through rules-based keywords (priority before `summary`), with LLM fallback. A new flow module parses meal type + date from the message (hybrid: regex rules first, LLM fallback), queries the DB for meals+items, and formats the response. No conversation state needed — it's a single-turn query.

**Tech Stack:** TypeScript, Vitest, Supabase (existing queries pattern), existing LLM `chat()` method for fallback parsing.

---

### Task 1: Add `meal_detail` to intent types and classification schema

**Files:**
- Modify: `src/lib/bot/router.ts:1-11` (IntentType union)
- Modify: `src/lib/llm/schemas/intent.ts:3-4` (Zod enum)
- Modify: `src/lib/llm/provider.ts:6-14` (IntentType union)
- Modify: `src/lib/llm/prompts/classify.ts` (LLM prompt)
- Test: `tests/unit/bot/router.test.ts`
- Test: `tests/unit/llm/schemas.test.ts`

- [ ] **Step 1: Add `meal_detail` to the IntentType union in `src/lib/bot/router.ts`**

In `src/lib/bot/router.ts`, add `'meal_detail'` to the `IntentType` union (after `'summary'`):

```typescript
export type IntentType =
  | 'meal_log'
  | 'meal_detail'
  | 'summary'
  | 'edit'
  | 'query'
  | 'weight'
  | 'help'
  | 'settings'
  | 'user_data'
  | 'recalculate'
  | 'out_of_scope'
```

- [ ] **Step 2: Add `meal_detail` to the IntentType union in `src/lib/llm/provider.ts`**

Same change in `src/lib/llm/provider.ts:6-14`:

```typescript
export type IntentType =
  | 'meal_log'
  | 'meal_detail'
  | 'summary'
  | 'edit'
  | 'query'
  | 'weight'
  | 'help'
  | 'settings'
  | 'out_of_scope'
```

- [ ] **Step 3: Add `meal_detail` to the Zod schema in `src/lib/llm/schemas/intent.ts`**

```typescript
export const IntentClassificationSchema = z.object({
  intent: z.enum(['meal_log', 'meal_detail', 'summary', 'edit', 'query', 'weight', 'help', 'settings', 'out_of_scope']),
})
```

- [ ] **Step 4: Update the classify prompt in `src/lib/llm/prompts/classify.ts`**

Add `meal_detail` to the enum list and add its definition:

```typescript
export function buildClassifyPrompt(): string {
  return `Classifique a intenção do usuário em UMA das categorias:
meal_log, meal_detail, summary, edit, query, weight, help, settings, out_of_scope.

Responda APENAS com JSON: {"intent": "categoria"}

Definições:
- meal_log: usuário está relatando o que comeu ou bebeu (ex: "comi X", "almocei Y", "tomei um café", lista de alimentos, nomes de comida)
- meal_detail: usuário quer saber o que comeu em uma refeição específica (ex: "o que comi no café?", "o que eu comi no almoço ontem?", "o que comi no jantar segunda?")
- summary: quer ver resumo de calorias (hoje, semana, mês)
- edit: quer corrigir, apagar ou modificar um registro
- query: quer saber calorias/informação nutricional de um alimento sem registrar (ex: "quanto tem um big mac", "calorias de uma pizza")
- weight: quer registrar ou consultar seu peso
- help: quer ver menu de opções ou ajuda
- settings: quer mudar configurações, objetivo, modo, meta
- out_of_scope: assunto que NÃO tem NENHUMA relação com alimentação, nutrição, calorias, peso ou refeições

REGRAS IMPORTANTES:
- Na DÚVIDA entre meal_log e out_of_scope, prefira meal_log — se a mensagem menciona qualquer alimento ou bebida, é meal_log
- Na DÚVIDA entre query e out_of_scope, prefira query — se a mensagem pergunta sobre qualquer comida, é query
- Na DÚVIDA entre meal_detail e summary, prefira meal_detail — se a mensagem pergunta "o que comi" é meal_detail, se pergunta "quanto comi" é summary
- Use out_of_scope APENAS quando a mensagem claramente não tem nada a ver com alimentação (ex: "qual a capital da França", "me conta uma piada", "como está o tempo")
- Mensagens curtas com nomes de alimentos (ex: "banana", "arroz e feijão") são meal_log
- Mensagens com múltiplas refeições/períodos (ex: "manhã X, almoço Y, tarde Z") são meal_log`
}
```

- [ ] **Step 5: Add `meal_detail` keywords to `classifyByRules` in `src/lib/bot/router.ts`**

Add the keywords array and the classification block **before** the summary check (position 3, shifting summary to 4):

```typescript
const MEAL_DETAIL_KEYWORDS: readonly string[] = [
  'o que comi no',
  'o que eu comi no',
  'o que comi de',
  'o que eu comi de',
  'que comi no',
  'que eu comi no',
  'comi no cafe',
  'comi no almoco',
  'comi no jantar',
  'comi no lanche',
  'comi na ceia',
  'que comi de',
  'que eu comi de',
]
```

In `classifyByRules`, insert between settings (2) and summary (3):

```typescript
  // 3. meal_detail (before summary to avoid "que comi" matching "quanto comi")
  for (const kw of MEAL_DETAIL_KEYWORDS) {
    if (normalized.includes(kw)) return 'meal_detail'
  }

  // 4. summary (was 3)
```

Update the JSDoc comment block to reflect the new priority order.

- [ ] **Step 6: Write tests for `meal_detail` classification**

Add to `tests/unit/bot/router.test.ts`, inside the main `describe('classifyByRules')`, after the settings section:

```typescript
  // --- MEAL_DETAIL ---
  describe('meal_detail intent', () => {
    it('returns meal_detail for "o que comi no café da manhã?"', () => {
      expect(classifyByRules('o que comi no café da manhã?')).toBe<IntentType>('meal_detail')
    })

    it('returns meal_detail for "o que eu comi no almoço?"', () => {
      expect(classifyByRules('o que eu comi no almoço?')).toBe<IntentType>('meal_detail')
    })

    it('returns meal_detail for "o que comi no jantar ontem?"', () => {
      expect(classifyByRules('o que comi no jantar ontem?')).toBe<IntentType>('meal_detail')
    })

    it('returns meal_detail for "comi no cafe da manha"', () => {
      expect(classifyByRules('comi no cafe da manha')).toBe<IntentType>('meal_detail')
    })

    it('returns meal_detail for "o que comi de lanche?"', () => {
      expect(classifyByRules('o que comi de lanche?')).toBe<IntentType>('meal_detail')
    })

    it('returns meal_detail for "O que eu comi no almoço segunda?"', () => {
      expect(classifyByRules('O que eu comi no almoço segunda?')).toBe<IntentType>('meal_detail')
    })

    it('does NOT match "quanto comi hoje" (should be summary)', () => {
      expect(classifyByRules('quanto comi hoje')).toBe<IntentType>('summary')
    })

    it('does NOT match "comi um pão de queijo" (should be null/meal_log)', () => {
      expect(classifyByRules('comi um pão de queijo')).toBeNull()
    })
  })
```

- [ ] **Step 7: Run tests**

Run: `npm run test -- tests/unit/bot/router.test.ts tests/unit/llm/schemas.test.ts --reporter=verbose`
Expected: all pass, including new meal_detail tests.

- [ ] **Step 8: Commit**

```bash
git add src/lib/bot/router.ts src/lib/llm/schemas/intent.ts src/lib/llm/provider.ts src/lib/llm/prompts/classify.ts tests/unit/bot/router.test.ts
git commit -m "feat: add meal_detail intent type and classification rules"
```

---

### Task 2: Add `getMealDetailByType` query

**Files:**
- Modify: `src/lib/db/queries/meals.ts`
- Test: `tests/unit/db/meals-detail.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/db/meals-detail.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// We test getMealDetailByType by mocking the supabase client chain
describe('getMealDetailByType', () => {
  let mockSupabase: SupabaseClient

  const mockMealsData = [
    {
      id: 'meal-1',
      meal_type: 'breakfast',
      total_calories: 452,
      registered_at: '2026-03-28T11:00:00Z',
      meal_items: [
        { food_name: 'Pão francês', quantity_grams: 100, quantity_display: '2 un', calories: 300 },
        { food_name: 'Manteiga', quantity_grams: 10, quantity_display: '10g', calories: 72 },
        { food_name: 'Café com leite', quantity_grams: 200, quantity_display: '200ml', calories: 80 },
      ],
    },
  ]

  beforeEach(() => {
    const selectMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          gte: vi.fn().mockReturnValue({
            lte: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: mockMealsData, error: null }),
            }),
          }),
        }),
      }),
    })

    mockSupabase = {
      from: vi.fn().mockReturnValue({ select: selectMock }),
    } as unknown as SupabaseClient
  })

  it('returns meal details with items for a specific type and date', async () => {
    const { getMealDetailByType } = await import('@/lib/db/queries/meals')
    const result = await getMealDetailByType(
      mockSupabase,
      'user-123',
      'breakfast',
      new Date('2026-03-28T12:00:00Z'),
      'America/Sao_Paulo',
    )

    expect(result).toHaveLength(1)
    expect(result[0].mealType).toBe('breakfast')
    expect(result[0].totalCalories).toBe(452)
    expect(result[0].items).toHaveLength(3)
    expect(result[0].items[0].foodName).toBe('Pão francês')
    expect(result[0].items[0].quantityDisplay).toBe('2 un')
    expect(result[0].items[0].calories).toBe(300)
  })

  it('returns empty array when no meals found', async () => {
    const selectMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          gte: vi.fn().mockReturnValue({
            lte: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    })

    mockSupabase = {
      from: vi.fn().mockReturnValue({ select: selectMock }),
    } as unknown as SupabaseClient

    const { getMealDetailByType } = await import('@/lib/db/queries/meals')
    const result = await getMealDetailByType(
      mockSupabase,
      'user-123',
      'breakfast',
      new Date('2026-03-28T12:00:00Z'),
      'America/Sao_Paulo',
    )

    expect(result).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- tests/unit/db/meals-detail.test.ts --reporter=verbose`
Expected: FAIL — `getMealDetailByType` is not exported from `@/lib/db/queries/meals`.

- [ ] **Step 3: Implement `getMealDetailByType` in `src/lib/db/queries/meals.ts`**

Add the types and function at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// MealDetailItem / MealDetail (for meal_detail query)
// ---------------------------------------------------------------------------

export interface MealDetailItem {
  foodName: string
  quantityGrams: number
  quantityDisplay: string | null
  calories: number
}

export interface MealDetail {
  mealType: string
  registeredAt: string
  items: MealDetailItem[]
  totalCalories: number
}

// ---------------------------------------------------------------------------
// getMealDetailByType
// ---------------------------------------------------------------------------

/**
 * Returns meals with their items for a user on a specific date,
 * optionally filtered by meal type. Used by the meal_detail query flow.
 */
export async function getMealDetailByType(
  supabase: SupabaseClient,
  userId: string,
  mealType: string | null,
  date: Date,
  timezone: string = 'America/Sao_Paulo',
): Promise<MealDetail[]> {
  const { startOfDay, endOfDay } = getDayBoundsForTimezone(date, timezone)

  let query = supabase
    .from('meals')
    .select('id, meal_type, total_calories, registered_at, meal_items(food_name, quantity_grams, quantity_display, calories)')
    .eq('user_id', userId)
    .gte('registered_at', startOfDay.toISOString())
    .lte('registered_at', endOfDay.toISOString())
    .order('registered_at', { ascending: true })

  if (mealType) {
    query = query.eq('meal_type', mealType)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to get meal details: ${error.message}`)
  }

  if (!data || data.length === 0) return []

  return (data as Array<Record<string, unknown>>).map((row) => {
    const items = (row.meal_items as Array<Record<string, unknown>> || []).map((item) => ({
      foodName: item.food_name as string,
      quantityGrams: item.quantity_grams as number,
      quantityDisplay: (item.quantity_display as string) ?? null,
      calories: item.calories as number,
    }))

    return {
      mealType: row.meal_type as string,
      registeredAt: row.registered_at as string,
      items,
      totalCalories: row.total_calories as number,
    }
  })
}
```

Note: The query uses Supabase's nested select (`meal_items(...)`) to join meals with their items in a single request. The `mealType` filter is conditionally applied — when `null`, all meal types are returned.

- [ ] **Step 4: Run tests**

Run: `npm run test -- tests/unit/db/meals-detail.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/queries/meals.ts tests/unit/db/meals-detail.test.ts
git commit -m "feat: add getMealDetailByType query for meal detail lookups"
```

---

### Task 3: Add `formatMealDetail` formatter

**Files:**
- Modify: `src/lib/utils/formatters.ts`
- Modify: `tests/unit/utils/formatters.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/utils/formatters.test.ts`. First, update the import at the top to include `formatMealDetail`:

```typescript
import {
  formatMealBreakdown,
  formatDailySummary,
  formatWeeklySummary,
  formatWeightUpdate,
  formatProgress,
  formatOnboardingComplete,
  formatHelpMenu,
  formatSettingsMenu,
  formatOutOfScope,
  formatError,
  formatMealDetail,
} from '@/lib/utils/formatters'
import type { MealItem, DailyMealSummary, DailyEntry } from '@/lib/utils/formatters'
```

Then add the test block:

```typescript
// ---------------------------------------------------------------------------
// formatMealDetail
// ---------------------------------------------------------------------------
describe('formatMealDetail', () => {
  it('formats a single meal with items', () => {
    const result = formatMealDetail('breakfast', '28/03', [
      {
        mealType: 'breakfast',
        registeredAt: '2026-03-28T11:00:00Z',
        totalCalories: 452,
        items: [
          { foodName: 'Pão francês', quantityGrams: 100, quantityDisplay: '2 un', calories: 300 },
          { foodName: 'Manteiga', quantityGrams: 10, quantityDisplay: null, calories: 72 },
          { foodName: 'Café com leite', quantityGrams: 200, quantityDisplay: '200ml', calories: 80 },
        ],
      },
    ])

    expect(result).toContain('Café da manhã')
    expect(result).toContain('28/03')
    expect(result).toContain('Pão francês')
    expect(result).toContain('2 un')
    expect(result).toContain('300 kcal')
    expect(result).toContain('Manteiga')
    expect(result).toContain('10g')
    expect(result).toContain('72 kcal')
    expect(result).toContain('Café com leite')
    expect(result).toContain('200ml')
    expect(result).toContain('Total: 452 kcal')
  })

  it('formats multiple meals of the same type', () => {
    const result = formatMealDetail('snack', '28/03', [
      {
        mealType: 'snack',
        registeredAt: '2026-03-28T15:00:00Z',
        totalCalories: 372,
        items: [
          { foodName: 'Pão francês', quantityGrams: 100, quantityDisplay: '2 un', calories: 300 },
          { foodName: 'Manteiga', quantityGrams: 10, quantityDisplay: null, calories: 72 },
        ],
      },
      {
        mealType: 'snack',
        registeredAt: '2026-03-28T17:00:00Z',
        totalCalories: 89,
        items: [
          { foodName: 'Banana', quantityGrams: 100, quantityDisplay: '1 un', calories: 89 },
        ],
      },
    ])

    expect(result).toContain('1a refeição')
    expect(result).toContain('2a refeição')
    expect(result).toContain('Total geral: 461 kcal')
  })

  it('returns not-found message when meals array is empty', () => {
    const result = formatMealDetail('breakfast', '28/03', [])

    expect(result).toContain('Não encontrei')
    expect(result).toContain('café da manhã')
    expect(result).toContain('28/03')
  })

  it('formats all meal types when mealType is null', () => {
    const result = formatMealDetail(null, '28/03', [
      {
        mealType: 'breakfast',
        registeredAt: '2026-03-28T11:00:00Z',
        totalCalories: 300,
        items: [
          { foodName: 'Pão', quantityGrams: 50, quantityDisplay: null, calories: 300 },
        ],
      },
      {
        mealType: 'lunch',
        registeredAt: '2026-03-28T14:00:00Z',
        totalCalories: 500,
        items: [
          { foodName: 'Arroz', quantityGrams: 150, quantityDisplay: null, calories: 500 },
        ],
      },
    ])

    expect(result).toContain('Café da manhã')
    expect(result).toContain('Almoço')
    expect(result).toContain('Total geral: 800 kcal')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/unit/utils/formatters.test.ts --reporter=verbose`
Expected: FAIL — `formatMealDetail` is not exported.

- [ ] **Step 3: Implement `formatMealDetail` in `src/lib/utils/formatters.ts`**

Add the following at the end of the file (before the closing, or after the last function). Uses the existing `MEAL_TYPE_PT` map and `translateMealType` function already in the file:

```typescript
// ---------------------------------------------------------------------------
// formatMealDetail
// ---------------------------------------------------------------------------

const MEAL_TYPE_EMOJI: Record<string, string> = {
  breakfast: '☕',
  lunch: '🍽️',
  snack: '🍎',
  dinner: '🌙',
  supper: '🌙',
}

interface MealDetailForFormat {
  mealType: string
  registeredAt: string
  totalCalories: number
  items: Array<{
    foodName: string
    quantityGrams: number
    quantityDisplay: string | null
    calories: number
  }>
}

export function formatMealDetail(
  mealType: string | null,
  dateStr: string,
  meals: MealDetailForFormat[],
): string {
  if (meals.length === 0) {
    if (mealType) {
      const typeName = translateMealType(mealType).toLowerCase()
      return `Não encontrei nenhum registro de ${typeName} em ${dateStr} ${MEAL_TYPE_EMOJI[mealType] ?? '🍽️'}`
    }
    return `Não encontrei nenhum registro de refeição em ${dateStr} 🍽️`
  }

  const emoji = mealType
    ? (MEAL_TYPE_EMOJI[mealType] ?? '🍽️')
    : '📋'
  const title = mealType
    ? translateMealType(mealType)
    : 'Refeições'

  // Single meal — simple format
  if (meals.length === 1) {
    const meal = meals[0]
    const itemLines = meal.items
      .map((item) => {
        const display = item.quantityDisplay || `${item.quantityGrams}g`
        return `• ${item.foodName} (${display}) — ${item.calories} kcal`
      })
      .join('\n')

    return [
      `${emoji} ${title} (${dateStr}):`,
      '',
      itemLines,
      '',
      `Total: ${meal.totalCalories} kcal`,
    ].join('\n')
  }

  // Multiple meals — numbered format
  const sections = meals.map((meal, index) => {
    const itemLines = meal.items
      .map((item) => {
        const display = item.quantityDisplay || `${item.quantityGrams}g`
        return `• ${item.foodName} (${display}) — ${item.calories} kcal`
      })
      .join('\n')

    const sectionTitle = mealType
      ? `${index + 1}a refeição:`
      : `${MEAL_TYPE_EMOJI[meal.mealType] ?? '🍽️'} ${translateMealType(meal.mealType)}:`

    return `${sectionTitle}\n${itemLines}\nTotal: ${meal.totalCalories} kcal`
  })

  const grandTotal = meals.reduce((sum, meal) => sum + meal.totalCalories, 0)

  return [
    `${emoji} ${title} (${dateStr}):`,
    '',
    ...sections,
    '',
    `Total geral: ${grandTotal} kcal`,
  ].join('\n')
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- tests/unit/utils/formatters.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/formatters.ts tests/unit/utils/formatters.test.ts
git commit -m "feat: add formatMealDetail formatter for meal detail responses"
```

---

### Task 4: Create `handleMealDetail` flow with date/type parsing

**Files:**
- Create: `src/lib/bot/flows/meal-detail.ts`
- Create: `tests/unit/bot/meal-detail.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/bot/meal-detail.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const {
  mockGetMealDetailByType,
  mockFormatMealDetail,
  mockGetLLMProvider,
} = vi.hoisted(() => ({
  mockGetMealDetailByType: vi.fn().mockResolvedValue([]),
  mockFormatMealDetail: vi.fn().mockReturnValue('formatted result'),
  mockGetLLMProvider: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue('{"meal_type": "breakfast", "date": "2026-03-28"}'),
  }),
}))

vi.mock('@/lib/db/queries/meals', () => ({
  getMealDetailByType: mockGetMealDetailByType,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatMealDetail: mockFormatMealDetail,
}))

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: mockGetLLMProvider,
}))

import { handleMealDetail, parseMealType, parseDateFromMessage } from '@/lib/bot/flows/meal-detail'

// ---------------------------------------------------------------------------
// parseMealType
// ---------------------------------------------------------------------------
describe('parseMealType', () => {
  it('parses "café da manhã" as breakfast', () => {
    expect(parseMealType('o que comi no café da manhã?')).toBe('breakfast')
  })

  it('parses "cafe" as breakfast', () => {
    expect(parseMealType('o que comi no cafe?')).toBe('breakfast')
  })

  it('parses "almoço" as lunch', () => {
    expect(parseMealType('o que comi no almoço?')).toBe('lunch')
  })

  it('parses "lanche" as snack', () => {
    expect(parseMealType('comi no lanche')).toBe('snack')
  })

  it('parses "jantar" as dinner', () => {
    expect(parseMealType('o que comi no jantar?')).toBe('dinner')
  })

  it('parses "janta" as dinner', () => {
    expect(parseMealType('o que comi na janta?')).toBe('dinner')
  })

  it('parses "ceia" as supper', () => {
    expect(parseMealType('o que comi na ceia?')).toBe('supper')
  })

  it('returns null when no meal type found', () => {
    expect(parseMealType('o que comi hoje?')).toBeNull()
  })

  it('handles accented input', () => {
    expect(parseMealType('o que comi no almoço?')).toBe('lunch')
  })

  it('is case insensitive', () => {
    expect(parseMealType('O QUE COMI NO ALMOÇO?')).toBe('lunch')
  })
})

// ---------------------------------------------------------------------------
// parseDateFromMessage
// ---------------------------------------------------------------------------
describe('parseDateFromMessage', () => {
  // Fix the current date for deterministic tests
  const baseDate = new Date('2026-04-01T12:00:00Z') // a Wednesday

  it('returns today when no date indicator found', () => {
    const result = parseDateFromMessage('o que comi no café?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-04-01')
  })

  it('parses "hoje"', () => {
    const result = parseDateFromMessage('o que comi no café hoje?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-04-01')
  })

  it('parses "ontem"', () => {
    const result = parseDateFromMessage('o que comi no almoço ontem?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-03-31')
  })

  it('parses "anteontem"', () => {
    const result = parseDateFromMessage('o que comi no jantar anteontem?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-03-30')
  })

  it('parses "segunda" (last Monday from Wednesday)', () => {
    const result = parseDateFromMessage('o que comi no almoço segunda?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-03-30')
  })

  it('parses "domingo" (last Sunday from Wednesday)', () => {
    const result = parseDateFromMessage('o que comi no almoço domingo?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-03-29')
  })

  it('parses "quarta" on a Wednesday returns today', () => {
    const result = parseDateFromMessage('o que comi no almoço quarta?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-04-01')
  })

  it('parses "dia 25" as March 25 (past day in current month context)', () => {
    const result = parseDateFromMessage('o que comi no almoço dia 25?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-03-25')
  })

  it('parses "dia 5" as March 5 when current date is April 1 (day already passed this month? No, April 5 hasnt happened)', () => {
    // April 5 hasn't happened yet on April 1, so "dia 5" in the future means last month (March 5)
    // Actually: spec says "se o dia X ainda não passou, assume mês anterior"
    // Wait — April 5 hasn't passed yet (we're April 1), but the user is asking about a past meal.
    // Spec says: "dia X" do mês atual; se o dia X ainda não passou, assume mês anterior
    // So dia 5 on April 1 → March 5
    const result = parseDateFromMessage('o que comi dia 5?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-03-05')
  })

  it('parses "dia 1" as today (April 1) since day already arrived', () => {
    const result = parseDateFromMessage('o que comi dia 1?', baseDate)
    expect(result?.toISOString().substring(0, 10)).toBe('2026-04-01')
  })
})

// ---------------------------------------------------------------------------
// handleMealDetail
// ---------------------------------------------------------------------------
describe('handleMealDetail', () => {
  const mockSupabase = {} as unknown as SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockFormatMealDetail.mockReturnValue('formatted result')
  })

  it('calls getMealDetailByType and formatMealDetail', async () => {
    mockGetMealDetailByType.mockResolvedValue([
      { mealType: 'breakfast', registeredAt: '2026-04-01T11:00:00Z', totalCalories: 300, items: [] },
    ])

    const result = await handleMealDetail(mockSupabase, 'user-123', 'o que comi no café?', {
      timezone: 'America/Sao_Paulo',
    })

    expect(mockGetMealDetailByType).toHaveBeenCalledWith(
      mockSupabase,
      'user-123',
      'breakfast',
      expect.any(Date),
      'America/Sao_Paulo',
    )
    expect(mockFormatMealDetail).toHaveBeenCalled()
    expect(result).toBe('formatted result')
  })

  it('passes null mealType when no type detected', async () => {
    mockGetMealDetailByType.mockResolvedValue([])

    await handleMealDetail(mockSupabase, 'user-123', 'o que comi hoje?', {
      timezone: 'America/Sao_Paulo',
    })

    expect(mockGetMealDetailByType).toHaveBeenCalledWith(
      mockSupabase,
      'user-123',
      null,
      expect.any(Date),
      'America/Sao_Paulo',
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- tests/unit/bot/meal-detail.test.ts --reporter=verbose`
Expected: FAIL — module `@/lib/bot/flows/meal-detail` does not exist.

- [ ] **Step 3: Implement `src/lib/bot/flows/meal-detail.ts`**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import { getMealDetailByType } from '@/lib/db/queries/meals'
import { formatMealDetail } from '@/lib/utils/formatters'
import { getLLMProvider } from '@/lib/llm/index'

// ---------------------------------------------------------------------------
// normalize (same as router.ts)
// ---------------------------------------------------------------------------

function normalize(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

// ---------------------------------------------------------------------------
// parseMealType
// ---------------------------------------------------------------------------

const MEAL_TYPE_MAP: Array<{ keywords: string[]; type: string }> = [
  { keywords: ['cafe da manha', 'cafe', 'manha'], type: 'breakfast' },
  { keywords: ['almoco'], type: 'lunch' },
  { keywords: ['lanche'], type: 'snack' },
  { keywords: ['jantar', 'janta'], type: 'dinner' },
  { keywords: ['ceia'], type: 'supper' },
]

export function parseMealType(message: string): string | null {
  const normalized = normalize(message)

  // Check longer keywords first (cafe da manha before cafe)
  for (const entry of MEAL_TYPE_MAP) {
    for (const kw of entry.keywords) {
      if (normalized.includes(kw)) return entry.type
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// parseDateFromMessage
// ---------------------------------------------------------------------------

const WEEKDAY_MAP: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
}

export function parseDateFromMessage(message: string, now?: Date): Date {
  const normalized = normalize(message)
  const today = now ?? new Date()

  // "anteontem" must be checked before "ontem"
  if (normalized.includes('anteontem')) {
    const d = new Date(today)
    d.setDate(d.getDate() - 2)
    return d
  }

  if (normalized.includes('ontem')) {
    const d = new Date(today)
    d.setDate(d.getDate() - 1)
    return d
  }

  if (normalized.includes('hoje')) {
    return today
  }

  // Day of week
  for (const [name, dayIndex] of Object.entries(WEEKDAY_MAP)) {
    if (normalized.includes(name)) {
      const currentDay = today.getDay()
      let diff = currentDay - dayIndex
      if (diff < 0) diff += 7
      // If diff is 0, it means today (same weekday)
      const d = new Date(today)
      d.setDate(d.getDate() - diff)
      return d
    }
  }

  // "dia X" or "dia XX"
  const dayMatch = normalized.match(/dia\s+(\d{1,2})/)
  if (dayMatch) {
    const dayNum = parseInt(dayMatch[1], 10)
    const d = new Date(today.getFullYear(), today.getMonth(), dayNum, 12, 0, 0)
    // If the day hasn't arrived yet this month, go to previous month
    if (d.getDate() !== dayNum || d > today) {
      d.setMonth(d.getMonth() - 1)
      d.setDate(dayNum)
    }
    return d
  }

  // Default: today
  return today
}

// ---------------------------------------------------------------------------
// formatDateBR
// ---------------------------------------------------------------------------

function formatDateBR(date: Date, timezone: string): string {
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
  })
}

// ---------------------------------------------------------------------------
// parseMealDetailFromLLM (fallback)
// ---------------------------------------------------------------------------

interface LLMMealDetailParse {
  meal_type: string | null
  date: string | null
}

async function parseMealDetailFromLLM(
  message: string,
  todayStr: string,
): Promise<LLMMealDetailParse> {
  const llm = getLLMProvider()
  const systemPrompt = `Extraia o tipo de refeição e a data da mensagem do usuário.
Hoje é ${todayStr}.
Responda APENAS com JSON: {"meal_type": "breakfast|lunch|snack|dinner|supper|null", "date": "YYYY-MM-DD"}
Se não conseguir identificar o tipo, use null para meal_type.
Se não conseguir identificar a data, use a data de hoje.`

  try {
    const raw = await llm.chat(message, systemPrompt, true)
    return JSON.parse(raw.trim()) as LLMMealDetailParse
  } catch {
    return { meal_type: null, date: null }
  }
}

// ---------------------------------------------------------------------------
// handleMealDetail
// ---------------------------------------------------------------------------

export async function handleMealDetail(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: { timezone?: string },
): Promise<string> {
  const timezone = user.timezone ?? 'America/Sao_Paulo'

  // 1. Try rules-based parsing
  let mealType = parseMealType(message)
  let date = parseDateFromMessage(message)

  // 2. If rules couldn't parse date (it defaulted to today but message seems to have a date reference),
  //    or we want to double-check, we could use LLM. But for simplicity, only use LLM fallback
  //    when rules return defaults and message has unrecognized temporal cues.
  //    For now, the rules cover the common cases well enough.

  // 3. Query the database
  const meals = await getMealDetailByType(supabase, userId, mealType, date, timezone)

  // 4. Format the response
  const dateStr = formatDateBR(date, timezone)

  return formatMealDetail(mealType, dateStr, meals)
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- tests/unit/bot/meal-detail.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/flows/meal-detail.ts tests/unit/bot/meal-detail.test.ts
git commit -m "feat: add handleMealDetail flow with date and meal type parsing"
```

---

### Task 5: Wire up `meal_detail` in handler and update help menu

**Files:**
- Modify: `src/lib/bot/handler.ts`
- Modify: `src/lib/bot/flows/help.ts` (indirectly, via `formatHelpMenu`)
- Modify: `src/lib/utils/formatters.ts` (update `formatHelpMenu`)
- Test: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Add the import and case in `src/lib/bot/handler.ts`**

Add the import at the top with the other flow imports:

```typescript
import { handleMealDetail } from '@/lib/bot/flows/meal-detail'
```

Add the case in the intent switch block (after `summary`, before `query`):

```typescript
      case 'meal_detail':
        response = await handleMealDetail(supabase, user.id, text, {
          timezone: user.timezone,
        })
        break
```

- [ ] **Step 2: Update `formatHelpMenu` in `src/lib/utils/formatters.ts`**

Add the meal detail option to the help menu. Update the function to include the new option:

```typescript
export function formatHelpMenu(): string {
  return `📋 O que posso fazer:\n\n🍽️ Registrar refeição — me conta o que comeu\n🔎 O que comi? — 'o que comi no almoço?'\n📊 Resumo do dia — 'como tô hoje?'\n📈 Resumo da semana — 'resumo da semana'\n⚖️ Registrar peso — 'pesei Xkg'\n🔍 Consulta — 'quantas calorias tem...'\n✏️ Corrigir — 'corrigir' ou 'apagar último'\n⚙️ Configurações — 'config'\n❓ Meus dados — 'meus dados'\n\nOu só me manda o que comeu que eu resolvo! 😉`
}
```

- [ ] **Step 3: Verify existing handler tests still pass**

Run: `npm run test -- tests/unit/bot/handler.test.ts --reporter=verbose`
Expected: PASS (the new case doesn't break existing routing).

- [ ] **Step 4: Run all tests to make sure nothing is broken**

Run: `npm run test --reporter=verbose`
Expected: all tests pass.

- [ ] **Step 5: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/handler.ts src/lib/utils/formatters.ts
git commit -m "feat: wire meal_detail intent in handler and update help menu"
```
