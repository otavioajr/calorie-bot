# Contextual Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After registering a meal, detect when the user's next message is correcting an item (e.g., "O magic toast é 93kcal") and route it to the edit flow with full meal context.

**Architecture:** New `recent_meal` context type saved after meal registration (TTL 5min). A LLM "gatekeeper" prompt checks if the next message is a correction. If yes, the reformulated message is passed to the existing edit flow. New `update_value` correction action supports direct nutritional value overrides.

**Tech Stack:** TypeScript, Zod, Supabase (conversation_context table), OpenRouter/Ollama LLM

---

### Task 1: Add `recent_meal` context type

**Files:**
- Modify: `src/lib/db/queries/context.ts:2-17` (CONTEXT_TTLS) and `:19-32` (ContextType)

- [ ] **Step 1: Add `recent_meal` to ContextType and CONTEXT_TTLS**

In `src/lib/db/queries/context.ts`, add `recent_meal` to both the TTL map and the type union:

```typescript
// In CONTEXT_TTLS, add:
  recent_meal: 5,

// In ContextType union, add:
  | 'recent_meal'
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/queries/context.ts
git commit -m "feat: add recent_meal context type with 5min TTL"
```

---

### Task 2: Add `update_value` to CorrectionSchema

**Files:**
- Modify: `src/lib/llm/schemas/correction.ts`
- Modify: `tests/unit/llm/correction-schema.test.ts`

- [ ] **Step 1: Write failing test for update_value action**

Add to `tests/unit/llm/correction-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CorrectionSchema } from '@/lib/llm/schemas/correction'

describe('CorrectionSchema update_value', () => {
  it('parses update_value action with new_value field', () => {
    const input = {
      action: 'update_value',
      target_food: 'Magic Toast',
      new_value: { field: 'calories', amount: 93 },
      confidence: 'high',
    }
    const result = CorrectionSchema.parse(input)
    expect(result.action).toBe('update_value')
    expect(result.new_value).toEqual({ field: 'calories', amount: 93 })
  })

  it('parses update_value for protein', () => {
    const input = {
      action: 'update_value',
      target_food: 'Arroz branco',
      new_value: { field: 'protein', amount: 5 },
      confidence: 'high',
    }
    const result = CorrectionSchema.parse(input)
    expect(result.new_value).toEqual({ field: 'protein', amount: 5 })
  })

  it('rejects update_value with invalid field', () => {
    const input = {
      action: 'update_value',
      target_food: 'Arroz',
      new_value: { field: 'fiber', amount: 5 },
      confidence: 'high',
    }
    expect(() => CorrectionSchema.parse(input)).toThrow()
  })

  it('allows new_value to be null for non-update_value actions', () => {
    const input = {
      action: 'remove_item',
      target_food: 'Queijo',
      confidence: 'high',
    }
    const result = CorrectionSchema.parse(input)
    expect(result.new_value).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/llm/correction-schema.test.ts`
Expected: FAIL — `update_value` not in enum, `new_value` not in schema

- [ ] **Step 3: Update CorrectionSchema**

In `src/lib/llm/schemas/correction.ts`:

```typescript
import { z } from 'zod'

export const CorrectionActionSchema = z.enum([
  'update_quantity',
  'update_value',
  'remove_item',
  'add_item',
  'replace_item',
  'delete_meal',
])

export const CorrectionSchema = z.object({
  action: CorrectionActionSchema,
  target_meal_type: z.string().nullable().default(null),
  target_food: z.string().nullable().default(null),
  new_quantity: z.string().nullable().default(null),
  new_food: z.string().nullable().default(null),
  new_value: z.object({
    field: z.enum(['calories', 'protein', 'carbs', 'fat']),
    amount: z.number(),
  }).nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
})

export type Correction = z.infer<typeof CorrectionSchema>
export type CorrectionAction = z.infer<typeof CorrectionActionSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/llm/correction-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/schemas/correction.ts tests/unit/llm/correction-schema.test.ts
git commit -m "feat: add update_value action to CorrectionSchema"
```

---

### Task 3: Update correction prompt with `update_value`

**Files:**
- Modify: `src/lib/llm/prompts/correction.ts`

- [ ] **Step 1: Update `buildCorrectionPrompt`**

In `src/lib/llm/prompts/correction.ts`, add `update_value` to the actions list and the JSON format:

```typescript
export function buildCorrectionPrompt(message: string): string {
  return `Analise a mensagem do usuário e extraia a intenção de CORREÇÃO de uma refeição já registrada.

MENSAGEM DO USUÁRIO: "${message}"

AÇÕES POSSÍVEIS:
- "update_quantity": mudar a quantidade de um item (ex: "o arroz era 2 escumadeiras", "era 200ml, não 100ml")
- "update_value": corrigir diretamente um valor nutricional (ex: "o magic toast é 93kcal", "o arroz tem 5g de proteína", "o leite tem 8g de gordura")
- "remove_item": remover um item (ex: "tira o queijo", "remove o suco")
- "add_item": adicionar um item que faltou (ex: "faltou o suco", "esqueci de colocar a salada")
- "replace_item": trocar um alimento por outro (ex: "era queijo cottage, não minas")
- "delete_meal": apagar a refeição inteira (ex: "apaga o almoço", "deleta tudo")

REGRAS:
- "target_meal_type": tipo da refeição alvo (breakfast, lunch, snack, dinner, supper). Se o usuário não especificou, deixe null.
- "target_food": nome do alimento alvo (o que está no registro atual). Para add_item, é o nome do item a adicionar.
- "new_quantity": nova quantidade descrita pelo usuário (texto livre, ex: "2 escumadeiras", "200ml"). Null se não aplicável.
- "new_food": novo alimento (para replace_item). Null se não aplicável.
- "new_value": para update_value, o campo e valor a corrigir. Null se não aplicável.
  - "field": "calories", "protein", "carbs" ou "fat"
  - "amount": valor numérico
- "confidence": "high" se a intenção é clara, "medium" se precisa confirmar, "low" se ambíguo.

Responda SOMENTE com JSON no formato:
{
  "action": "update_quantity|update_value|remove_item|add_item|replace_item|delete_meal",
  "target_meal_type": "breakfast|lunch|snack|dinner|supper|null",
  "target_food": "nome do alimento",
  "new_quantity": "quantidade nova ou null",
  "new_food": "novo alimento ou null",
  "new_value": {"field": "calories|protein|carbs|fat", "amount": number} ou null,
  "confidence": "high|medium|low"
}`
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/prompts/correction.ts
git commit -m "feat: add update_value to correction prompt"
```

---

### Task 4: Create gatekeeper prompt

**Files:**
- Create: `src/lib/llm/prompts/contextual-correction.ts`

- [ ] **Step 1: Create the gatekeeper prompt file**

Create `src/lib/llm/prompts/contextual-correction.ts`:

```typescript
export interface RecentMealItem {
  foodName: string
  quantityDisplay: string | null
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

export function buildContextualCorrectionPrompt(
  items: RecentMealItem[],
  message: string,
): string {
  const itemLines = items.map(i => {
    const display = i.quantityDisplay || '?'
    return `• ${i.foodName} (${display}) — ${i.calories} kcal | P:${i.proteinG}g C:${i.carbsG}g G:${i.fatG}g`
  }).join('\n')

  return `O usuário ACABOU de registrar uma refeição com estes itens:

${itemLines}

Agora ele enviou esta mensagem: "${message}"

Determine se o usuário está CORRIGINDO algum dado de um item da refeição acima.

Exemplos de CORREÇÃO:
- "O arroz é 200g" → corrigindo quantidade
- "O magic toast é 93kcal" → corrigindo calorias
- "O leite tem 8g de proteína" → corrigindo proteína
- "Era queijo cottage, não minas" → trocando alimento
- "Tira o queijo" → removendo item
- "Faltou o suco" → adicionando item

Exemplos que NÃO são correção:
- "Almocei arroz e feijão" → nova refeição
- "Quantas calorias tem uma pizza?" → consulta
- "Como estou hoje?" → resumo
- "Obrigado" → agradecimento

Se for correção, reformule a mensagem como uma instrução explícita de correção.
Se NÃO for correção, retorne is_correction: false.

Responda APENAS com JSON:
{"is_correction": true, "corrected_message": "mensagem reformulada"} ou {"is_correction": false}`
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/prompts/contextual-correction.ts
git commit -m "feat: add contextual correction gatekeeper prompt"
```

---

### Task 5: Add `update_value` handler to edit flow

**Files:**
- Modify: `src/lib/bot/flows/edit.ts:310-383` (handleNaturalLanguageCorrectionWithMeal)
- Modify: `tests/unit/bot/edit.test.ts`

- [ ] **Step 1: Write failing test for update_value**

Add to `tests/unit/bot/edit.test.ts`. First, add the needed mock functions to the hoisted block and mock setup:

```typescript
// Add to the hoisted block:
  mockGetMealWithItems: vi.fn(),
  mockUpdateMealItem: vi.fn().mockResolvedValue(undefined),
  mockRemoveMealItem: vi.fn().mockResolvedValue(undefined),
  mockRecalculateMealTotal: vi.fn().mockResolvedValue(500),
  mockGetDailyCalories: vi.fn().mockResolvedValue(1200),
  mockLLMChat: vi.fn(),

// Add to vi.mock('@/lib/db/queries/meals'):
  getMealWithItems: mockGetMealWithItems,
  updateMealItem: mockUpdateMealItem,
  removeMealItem: mockRemoveMealItem,
  recalculateMealTotal: mockRecalculateMealTotal,
  getDailyCalories: mockGetDailyCalories,

// Add vi.mock for LLM:
vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: () => ({ chat: mockLLMChat }),
}))

// Add vi.mock for formatters:
vi.mock('@/lib/utils/formatters', () => ({
  formatProgress: vi.fn().mockReturnValue('📊 Hoje: 1200 / 2000 kcal'),
}))
```

Then add the test:

```typescript
describe('handleEdit — update_value via natural language', () => {
  it('updates calories directly when LLM returns update_value', async () => {
    // LLM returns update_value correction
    mockLLMChat.mockResolvedValue(JSON.stringify({
      action: 'update_value',
      target_food: 'Magic Toast',
      new_value: { field: 'calories', amount: 93 },
      confidence: 'high',
      target_meal_type: null,
      new_quantity: null,
      new_food: null,
    }))

    mockGetRecentMeals.mockResolvedValue([
      { id: 'meal-1', mealType: 'breakfast', totalCalories: 290, registeredAt: '2024-03-21T08:00:00Z' },
    ])

    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1',
      mealType: 'breakfast',
      totalCalories: 290,
      registeredAt: '2024-03-21T08:00:00Z',
      items: [
        { id: 'item-1', foodName: 'Magic Toast', quantityGrams: 30, calories: 120, proteinG: 3, carbsG: 20, fatG: 3 },
        { id: 'item-2', foodName: 'Queijo cottage', quantityGrams: 25, calories: 9, proteinG: 1.5, carbsG: 0.3, fatG: 0.2 },
      ],
    })

    const result = await handleEdit(
      buildSupabase(),
      USER_ID,
      'O magic toast é 93kcal',
      null,
      { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
    )

    expect(mockUpdateMealItem).toHaveBeenCalledWith(
      expect.anything(),
      'item-1',
      expect.objectContaining({ calories: 93 }),
    )
    expect(result).toContain('Magic Toast')
    expect(result).toContain('93')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/edit.test.ts`
Expected: FAIL — `update_value` case not handled in switch

- [ ] **Step 3: Implement update_value handler**

In `src/lib/bot/flows/edit.ts`, add the `update_value` case inside `handleNaturalLanguageCorrectionWithMeal`, in the switch statement at line ~337, before the `default` case:

```typescript
    case 'update_value': {
      if (!targetItem || !correction.new_value) {
        await clearState(userId)
        return 'Não entendi qual item corrigir ou o novo valor. Tenta "corrigir" pro menu guiado.'
      }
      const { field, amount } = correction.new_value
      const updateData = {
        quantityGrams: targetItem.quantityGrams,
        calories: targetItem.calories,
        proteinG: targetItem.proteinG ?? 0,
        carbsG: targetItem.carbsG ?? 0,
        fatG: targetItem.fatG ?? 0,
      }
      const fieldMap: Record<string, string> = {
        calories: 'calories',
        protein: 'proteinG',
        carbs: 'carbsG',
        fat: 'fatG',
      }
      const fieldLabels: Record<string, string> = {
        calories: 'kcal',
        protein: 'g proteína',
        carbs: 'g carboidratos',
        fat: 'g gordura',
      }
      const key = fieldMap[field] as keyof typeof updateData
      const oldValue = updateData[key]
      updateData[key] = amount

      await updateMealItem(supabase, targetItem.id, updateData)
      await recalculateMealTotal(supabase, mealId)
      await clearState(userId)

      const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
      const target = user?.dailyCalorieTarget ?? 2000
      return `✅ ${targetItem.foodName}: ${oldValue} → ${amount} ${fieldLabels[field]}\n${formatProgress(dailyConsumed, target)}`
    }
```

Also add `updateMealItem`, `recalculateMealTotal`, and `getDailyCalories` to the imports from `@/lib/db/queries/meals` if not already there (check existing imports at line 6-13 — they are already imported).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bot/edit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/flows/edit.ts tests/unit/bot/edit.test.ts
git commit -m "feat: add update_value handler for direct nutritional corrections"
```

---

### Task 6: Save `recent_meal` state after meal registration

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts` (~lines 572-577, 700-706, 990-995)
- Modify: `src/lib/bot/handler.ts` (~lines 390-424, 468-485)

- [ ] **Step 1: Modify `saveMeals` to return meal IDs**

In `src/lib/bot/flows/meal-log.ts`, change `saveMeals` return type from `Promise<void>` to `Promise<string[]>`:

```typescript
async function saveMeals(
  supabase: SupabaseClient,
  userId: string,
  meals: MealAnalysis[],
  enrichedMeals: EnrichedItem[][],
  originalMessage: string,
): Promise<string[]> {
  const mealIds: string[] = []
  for (let i = 0; i < meals.length; i++) {
    const analysis = meals[i]
    const items = enrichedMeals[i] ?? []

    const mealId = await createMeal(supabase, {
      userId,
      mealType: analysis.meal_type,
      totalCalories: totalCaloriesFromEnriched(items),
      originalMessage,
      llmResponse: analysis as unknown as Record<string, unknown>,
      items: items.map((item) => ({
        foodName: item.food,
        quantityGrams: item.quantityGrams,
        calories: item.calories,
        proteinG: item.protein,
        carbsG: item.carbs,
        fatG: item.fat,
        source: item.source,
        tacoId: item.tacoId,
        confidence: item.source === 'approximate' ? 'low' : 'high',
        quantityDisplay: item.quantityDisplay ?? undefined,
      })),
    })
    mealIds.push(mealId)
  }

  // Record TACO usage for default learning
  for (const items of enrichedMeals) {
    for (const item of items) {
      if (item.tacoId && item.source === 'taco') {
        const foodBase = item.defaultFoodBase ?? item.food
        await recordTacoUsage(supabase, foodBase, item.tacoId, userId)
      }
    }
  }

  return mealIds
}
```

- [ ] **Step 2: Add helper to save recent_meal state after registration**

Add a helper function in `src/lib/bot/flows/meal-log.ts` (after `saveMeals`):

```typescript
async function saveRecentMealState(
  supabase: SupabaseClient,
  userId: string,
  mealId: string,
): Promise<void> {
  const mealWithItems = await getMealWithItems(supabase, mealId)
  if (!mealWithItems || mealWithItems.items.length === 0) return

  await setState(userId, 'recent_meal', {
    mealId,
    mealType: mealWithItems.mealType,
    items: mealWithItems.items.map(i => ({
      id: i.id,
      foodName: i.foodName,
      quantityGrams: i.quantityGrams,
      quantityDisplay: i.quantityDisplay,
      calories: i.calories,
      proteinG: i.proteinG,
      carbsG: i.carbsG,
      fatG: i.fatG,
    })),
  })
}
```

Note: `getMealWithItems` is already imported at line 6.

- [ ] **Step 3: Insert `saveRecentMealState` at all meal registration points**

There are multiple places where meals get saved in `meal-log.ts`. At each one, replace `await clearState(userId)` after `saveMeals()` with `saveRecentMealState`. The key call sites:

**Site 1 (~line 572):** Direct registration after `saveMeals`:
```typescript
  const mealIds = await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage)
  // Replace: await clearState(userId)
  await saveRecentMealState(supabase, userId, mealIds[mealIds.length - 1])
```

**Site 2 (~line 700-704):** Bulk quantities handler after `saveMeals`:
```typescript
  // After clearState at line 704, replace with:
  await saveRecentMealState(supabase, userId, mealIds[mealIds.length - 1])
```
Note: this also requires changing the bulk quantities `saveMeals` call to capture `mealIds`.

**Site 3 (~line 903):** Another `saveMeals` call:
```typescript
  const mealIds = await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage)
  await saveRecentMealState(supabase, userId, mealIds[mealIds.length - 1])
```

**Site 4 (~line 955):** Partial analysis save:
```typescript
  const mealIds = await saveMeals(supabase, userId, [partialAnalysis], [enriched], originalMessage)
  await saveRecentMealState(supabase, userId, mealIds[0])
```

**Site 5 (~line 990):** Final `saveMeals` call:
```typescript
  const mealIds = await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage)
  await saveRecentMealState(supabase, userId, mealIds[mealIds.length - 1])
```

- [ ] **Step 4: Insert `setState('recent_meal')` in handler.ts image flows**

In `src/lib/bot/handler.ts`, after `createMeal()` in the image flow (~line 391-424):

After `createMeal` at ~line 391, capture the mealId and save state. The `createMeal` already returns a mealId — capture it:

```typescript
  const mealId = await createMeal(supabase, { ... })

  // After createMeal and before formatMealBreakdown, add:
  const mealWithItems = await getMealWithItems(supabase, mealId)
  if (mealWithItems && mealWithItems.items.length > 0) {
    await setState(user.id, 'recent_meal', {
      mealId,
      mealType: mealWithItems.mealType,
      items: mealWithItems.items.map(i => ({
        id: i.id,
        foodName: i.foodName,
        quantityGrams: i.quantityGrams,
        quantityDisplay: i.quantityDisplay,
        calories: i.calories,
        proteinG: i.proteinG,
        carbsG: i.carbsG,
        fatG: i.fatG,
      })),
    })
  }
```

Add `getMealWithItems` to the imports from `@/lib/db/queries/meals` in handler.ts.

Similarly, in the `handleLabelPortions` function (~line 468), after `createMeal` and `clearState`:

```typescript
  const mealId = await createMeal(supabase, { ... })
  // Replace: await clearState(userId)
  const mealWithItems = await getMealWithItems(supabase, mealId)
  if (mealWithItems && mealWithItems.items.length > 0) {
    await setState(userId, 'recent_meal', {
      mealId,
      mealType: mealWithItems.mealType,
      items: mealWithItems.items.map(i => ({
        id: i.id,
        foodName: i.foodName,
        quantityGrams: i.quantityGrams,
        quantityDisplay: i.quantityDisplay,
        calories: i.calories,
        proteinG: i.proteinG,
        carbsG: i.carbsG,
        fatG: i.fatG,
      })),
    })
  }
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run existing tests**

Run: `npx vitest run tests/unit/bot/meal-log.test.ts tests/unit/bot/handler.test.ts`
Expected: PASS (may need mock adjustments for new `saveMeals` return value)

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts src/lib/bot/handler.ts
git commit -m "feat: save recent_meal state after meal registration"
```

---

### Task 7: Handle `recent_meal` context in handler with LLM gatekeeper

**Files:**
- Modify: `src/lib/bot/handler.ts` (~line 83, the context switch)
- Modify: `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/unit/bot/handler.test.ts`:

```typescript
// Add mockIsCancelCommand to hoisted mocks:
  mockIsCancelCommand: vi.fn().mockReturnValue(false),

// Update vi.mock('@/lib/bot/router') to include:
  isCancelCommand: mockIsCancelCommand,

// Add the test:
describe('handleIncomingMessage — recent_meal context', () => {
  const onboardedUser = {
    id: 'user-123',
    phone: '+5511999999999',
    onboardingComplete: true,
    onboardingStep: 8,
    calorieMode: 'approximate',
    dailyCalorieTarget: 2000,
    dailyProteinG: null,
    dailyFatG: null,
    dailyCarbsG: null,
    timezone: 'America/Sao_Paulo',
  }

  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(onboardedUser)
    mockCreateServiceRoleClient.mockReturnValue({})
    mockIsCancelCommand.mockReturnValue(false)
  })

  it('routes to edit when gatekeeper detects correction', async () => {
    mockGetState.mockResolvedValue({
      id: 'ctx-1',
      userId: 'user-123',
      contextType: 'recent_meal',
      contextData: {
        mealId: 'meal-1',
        mealType: 'breakfast',
        items: [
          { id: 'item-1', foodName: 'Magic Toast', quantityGrams: 30, quantityDisplay: '1 pacote', calories: 120, proteinG: 3, carbsG: 20, fatG: 3 },
        ],
      },
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      createdAt: new Date().toISOString(),
    })

    // Gatekeeper says it's a correction
    mockClassifyIntent.mockResolvedValue('edit') // not used in this path
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      chat: vi.fn().mockResolvedValue(JSON.stringify({
        is_correction: true,
        corrected_message: 'corrigir o magic toast para 93kcal',
      })),
    })

    mockHandleEdit.mockResolvedValue('✅ Magic Toast: 120 → 93 kcal')

    await handleIncomingMessage('+5511999999999', 'msg-1', 'O magic toast é 93kcal')

    expect(mockHandleEdit).toHaveBeenCalledWith(
      expect.anything(),
      'user-123',
      'corrigir o magic toast para 93kcal',
      null,
      expect.objectContaining({ timezone: 'America/Sao_Paulo' }),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith('+5511999999999', '✅ Magic Toast: 120 → 93 kcal')
  })

  it('falls through to normal classification when gatekeeper says not a correction', async () => {
    mockGetState.mockResolvedValue({
      id: 'ctx-1',
      userId: 'user-123',
      contextType: 'recent_meal',
      contextData: {
        mealId: 'meal-1',
        mealType: 'breakfast',
        items: [
          { id: 'item-1', foodName: 'Magic Toast', quantityGrams: 30, quantityDisplay: '1 pacote', calories: 120, proteinG: 3, carbsG: 20, fatG: 3 },
        ],
      },
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      createdAt: new Date().toISOString(),
    })

    // Gatekeeper says NOT a correction
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      chat: vi.fn().mockResolvedValue(JSON.stringify({ is_correction: false })),
    })

    mockClassifyByRules.mockReturnValue('meal_log')
    mockHandleMealLog.mockResolvedValue({ response: 'Refeição registrada!', completed: true })

    await handleIncomingMessage('+5511999999999', 'msg-1', 'Almocei arroz e feijão')

    expect(mockHandleMealLog).toHaveBeenCalled()
    expect(mockHandleEdit).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/handler.test.ts`
Expected: FAIL — `recent_meal` case not handled

- [ ] **Step 3: Implement `recent_meal` handler in handler.ts**

In `src/lib/bot/handler.ts`, add the import for the gatekeeper prompt:

```typescript
import { buildContextualCorrectionPrompt } from '@/lib/llm/prompts/contextual-correction'
import type { RecentMealItem } from '@/lib/llm/prompts/contextual-correction'
```

Then, in the context switch block (~line 83), add the `recent_meal` case. It should go BEFORE the `awaiting_confirmation` case:

```typescript
        case 'recent_meal': {
          // LLM gatekeeper: is this a correction of the recent meal?
          const recentItems = context.contextData.items as unknown as RecentMealItem[]
          const recentMealId = context.contextData.mealId as string
          try {
            const llm = getLLMProvider()
            const gatekeeperRaw = await llm.chat(
              buildContextualCorrectionPrompt(recentItems, text),
              'Você detecta correções de refeições. Responda APENAS com JSON válido.',
              true,
            )
            const gatekeeper = JSON.parse(gatekeeperRaw.trim()) as { is_correction: boolean; corrected_message?: string }

            if (gatekeeper.is_correction && gatekeeper.corrected_message) {
              const editResponse = await handleEdit(supabase, user.id, gatekeeper.corrected_message, null, {
                timezone: user.timezone,
                dailyCalorieTarget: user.dailyCalorieTarget,
              })

              // After correction, refresh recent_meal state with updated items
              const updatedMeal = await getMealWithItems(supabase, recentMealId)
              if (updatedMeal && updatedMeal.items.length > 0) {
                await setState(user.id, 'recent_meal', {
                  mealId: recentMealId,
                  mealType: updatedMeal.mealType,
                  items: updatedMeal.items.map(i => ({
                    id: i.id,
                    foodName: i.foodName,
                    quantityGrams: i.quantityGrams,
                    quantityDisplay: i.quantityDisplay,
                    calories: i.calories,
                    proteinG: i.proteinG,
                    carbsG: i.carbsG,
                    fatG: i.fatG,
                  })),
                })
              }

              await sendTextMessage(from, editResponse)
              saveHistory(supabase, user.id, text, editResponse)
              return
            }
          } catch {
            // Gatekeeper failed — fall through to normal classification
          }
          // Not a correction — clear state and continue to intent classification
          await clearState(user.id)
          break
        }
```

Add `getMealWithItems` to the import from `@/lib/db/queries/meals` if not already added in Task 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bot/handler.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts
git commit -m "feat: handle recent_meal context with LLM gatekeeper for corrections"
```

---

### Task 8: Manual end-to-end verification

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Test correction flow via WhatsApp**

1. Send a meal message (e.g., "café da manhã: magic toast com queijo cottage e leite")
2. Wait for registration confirmation
3. Send "O magic toast é 93kcal"
4. Verify the bot updates Magic Toast to 93kcal (not asking for quantities)

- [ ] **Step 3: Test non-correction after meal**

1. After registering a meal, send "almocei arroz e feijão"
2. Verify the bot treats it as a new meal (not a correction)

- [ ] **Step 4: Test multiple corrections in sequence**

1. Register a meal
2. Correct one item ("o magic toast é 93kcal")
3. Correct another item ("o leite tem 8g de proteína")
4. Verify both corrections work

- [ ] **Step 5: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: adjustments from manual testing"
```
