# Macros in Daily Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show macronutrient progress (P/G/C) alongside calorie progress after meal registration and in daily summary.

**Architecture:** Connect existing `getDailyMacros()` query and `formatProgress()` macro support to the meal-log and summary flows. Propagate an optional `macros` param through 3 formatter functions. No new files, no new DB queries.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-04-01-macros-daily-flow-design.md`

---

### Task 1: Add macros param to `formatMealBreakdown` and `formatMultiMealBreakdown`

**Files:**
- Modify: `src/lib/utils/formatters.ts:45-119`
- Test: `tests/unit/utils/formatters.test.ts`

- [ ] **Step 1: Write failing tests for `formatMealBreakdown` with macros**

Add to the existing `formatMealBreakdown` describe block in `tests/unit/utils/formatters.test.ts`:

```typescript
it('includes macro progress line when macros provided', () => {
  const macros = {
    consumed: { proteinG: 80, fatG: 40, carbsG: 150 },
    target: { proteinG: 120, fatG: 65, carbsG: 250 },
  }
  const result = formatMealBreakdown('lunch', items, 470, 1230, 2000, macros)
  expect(result).toContain('P: 80/120g')
  expect(result).toContain('G: 40/65g')
  expect(result).toContain('C: 150/250g')
})

it('does not include macro line when macros not provided', () => {
  const result = formatMealBreakdown('lunch', items, 470, 1230, 2000)
  expect(result).not.toContain('P:')
  expect(result).not.toContain('G:')
  expect(result).not.toContain('C:')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/utils/formatters.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `formatMealBreakdown` doesn't accept 6th argument yet

- [ ] **Step 3: Write failing tests for `formatMultiMealBreakdown` with macros**

Add to the existing `formatMultiMealBreakdown` describe block (if it exists) or create one:

```typescript
describe('formatMultiMealBreakdown', () => {
  it('includes macro progress line when macros provided', () => {
    const meals = [
      { mealType: 'lunch', items: [{ food: 'Arroz', quantityGrams: 150, calories: 195 }], total: 195 },
      { mealType: 'dinner', items: [{ food: 'Salada', quantityGrams: 100, calories: 25 }], total: 25 },
    ]
    const macros = {
      consumed: { proteinG: 60, fatG: 30, carbsG: 100 },
      target: { proteinG: 120, fatG: 65, carbsG: 250 },
    }
    const result = formatMultiMealBreakdown(meals, 800, 2000, macros)
    expect(result).toContain('P: 60/120g')
    expect(result).toContain('G: 30/65g')
    expect(result).toContain('C: 100/250g')
  })

  it('does not include macro line when macros not provided', () => {
    const meals = [
      { mealType: 'lunch', items: [{ food: 'Arroz', quantityGrams: 150, calories: 195 }], total: 195 },
    ]
    const result = formatMultiMealBreakdown(meals, 800, 2000)
    expect(result).not.toContain('P:')
  })
})
```

- [ ] **Step 4: Implement — add macros param to both functions**

In `src/lib/utils/formatters.ts`, modify `formatMealBreakdown` (line 45):

```typescript
export function formatMealBreakdown(
  mealType: string,
  items: MealItem[],
  total: number,
  dailyConsumed: number,
  dailyTarget: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
```

Change line 61 from:
```typescript
const progressLine = formatProgress(dailyConsumed, dailyTarget)
```
to:
```typescript
const progressLine = formatProgress(dailyConsumed, dailyTarget, macros)
```

Modify `formatMultiMealBreakdown` (line 85):

```typescript
export function formatMultiMealBreakdown(
  meals: Array<{
    mealType: string
    items: MealItem[]
    total: number
  }>,
  dailyConsumed: number,
  dailyTarget: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
```

Change line 108 from:
```typescript
const progressLine = formatProgress(dailyConsumed, dailyTarget)
```
to:
```typescript
const progressLine = formatProgress(dailyConsumed, dailyTarget, macros)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/utils/formatters.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/utils/formatters.ts tests/unit/utils/formatters.test.ts
git commit -m "feat: propagate macros param through meal breakdown formatters"
```

---

### Task 2: Add macros to `formatDailySummary`

**Files:**
- Modify: `src/lib/utils/formatters.ts:124-159`
- Test: `tests/unit/utils/formatters.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the existing `formatDailySummary` describe block:

```typescript
it('includes macro progress line when macros provided', () => {
  const meals: DailyMealSummary = { breakfast: 350, lunch: 480 }
  const macros = {
    consumed: { proteinG: 80, fatG: 40, carbsG: 150 },
    target: { proteinG: 120, fatG: 65, carbsG: 250 },
  }
  const result = formatDailySummary('01/04', meals, 830, 2000, macros)
  expect(result).toContain('P: 80/120g')
  expect(result).toContain('G: 40/65g')
  expect(result).toContain('C: 150/250g')
})

it('does not include macro line when macros not provided', () => {
  const meals: DailyMealSummary = { breakfast: 350 }
  const result = formatDailySummary('01/04', meals, 350, 2000)
  expect(result).not.toContain('P:')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/utils/formatters.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL

- [ ] **Step 3: Implement — add macros param to `formatDailySummary`**

In `src/lib/utils/formatters.ts`, modify `formatDailySummary` (line 124):

```typescript
export function formatDailySummary(
  date: string,
  meals: DailyMealSummary,
  consumed: number,
  target: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
```

Replace the return block (lines 148-159) with:

```typescript
  const remaining = target - consumed

  const lines = [
    `📊 Resumo de hoje (${date}):`,
    '',
    breakfastLine,
    lunchLine,
    snackLine,
    dinnerLine,
    '',
    `Total: ${consumed} / ${target} kcal`,
    `Restam: ${remaining} kcal`,
  ]

  if (macros) {
    lines.push(`P: ${macros.consumed.proteinG}/${macros.target.proteinG}g | G: ${macros.consumed.fatG}/${macros.target.fatG}g | C: ${macros.consumed.carbsG}/${macros.target.carbsG}g`)
  }

  return lines.join('\n')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/utils/formatters.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/formatters.ts tests/unit/utils/formatters.test.ts
git commit -m "feat: add macros param to formatDailySummary"
```

---

### Task 3: Pass macros through `buildReceiptResponse` in meal-log flow

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts:149-188` (buildReceiptResponse)
- Modify: `src/lib/bot/flows/meal-log.ts` (3 call sites: ~578, ~946, ~1036)

- [ ] **Step 1: Add macros param to `buildReceiptResponse`**

In `src/lib/bot/flows/meal-log.ts`, modify `buildReceiptResponse` (line 149):

```typescript
function buildReceiptResponse(
  meals: MealAnalysis[],
  enrichedMeals: EnrichedItem[][],
  dailyConsumedSoFar: number,
  dailyTarget: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
```

Pass `macros` to `formatMealBreakdown` (inside the `if (meals.length === 1)` block, line ~168):

```typescript
    const breakdown = formatMealBreakdown(
      analysis.meal_type,
      items.map(i => ({ food: i.food, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories })),
      total,
      dailyConsumedSoFar,
      dailyTarget,
      macros,
    )
```

Pass `macros` to `formatMultiMealBreakdown` (line ~185):

```typescript
  const multiBreakdown = formatMultiMealBreakdown(mealSections, dailyConsumedSoFar, dailyTarget, macros)
```

- [ ] **Step 2: Update call site ~line 576-578 (history selection flow)**

Replace:
```typescript
  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000
  const response = buildReceiptResponse(meals, enrichedMeals, dailyConsumed, target)
```

With:
```typescript
  const dailyMacros = await getDailyMacros(supabase, userId, undefined, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000
  const macros = (user.dailyProteinG && user.dailyFatG && user.dailyCarbsG)
    ? {
        consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
        target: { proteinG: user.dailyProteinG, fatG: user.dailyFatG, carbsG: user.dailyCarbsG },
      }
    : undefined
  const response = buildReceiptResponse(meals, enrichedMeals, dailyMacros.calories, target, macros)
```

Note: `getDailyMacros` already returns `calories` so we use `dailyMacros.calories` instead of calling `getDailyCalories` separately. The import for `getDailyCalories` is already alongside `getDailyMacros` on line 6.

- [ ] **Step 3: Update call site ~line 944-946 (single history match)**

Same pattern — replace `getDailyCalories` with `getDailyMacros` and build the macros object:

```typescript
        const dailyMacros = await getDailyMacros(supabase, userId, undefined, user.timezone)
        const target = user.dailyCalorieTarget ?? 2000
        const macros = (user.dailyProteinG && user.dailyFatG && user.dailyCarbsG)
          ? {
              consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
              target: { proteinG: user.dailyProteinG, fatG: user.dailyFatG, carbsG: user.dailyCarbsG },
            }
          : undefined
        const response = buildReceiptResponse(meals, enrichedMeals, dailyMacros.calories, target, macros)
```

- [ ] **Step 4: Update call site ~line 1033-1036 (main TACO pipeline)**

Same pattern:

```typescript
  const dailyMacros = await getDailyMacros(supabase, userId, undefined, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000

  const macros = (user.dailyProteinG && user.dailyFatG && user.dailyCarbsG)
    ? {
        consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
        target: { proteinG: user.dailyProteinG, fatG: user.dailyFatG, carbsG: user.dailyCarbsG },
      }
    : undefined

  const response = buildReceiptResponse(meals, enrichedMeals, dailyMacros.calories, target, macros)
```

- [ ] **Step 5: Remove unused `getDailyCalories` import if no longer used**

Check if `getDailyCalories` is still used elsewhere in the file. If not, remove it from the import on line 6. `getDailyMacros` is already imported there.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts
git commit -m "feat: pass daily macros to receipt response in meal-log flow"
```

---

### Task 4: Pass macros through `handleDailySummary` in summary flow

**Files:**
- Modify: `src/lib/bot/flows/summary.ts:1-2,75-108`
- Test: `tests/unit/bot/summary.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/unit/bot/summary.test.ts`, add `getDailyMacros` to the mocked module and update the mock user. First, update the hoisted mocks:

```typescript
const {
  mockGetDailyCalories,
  mockGetDailyMeals,
  mockGetDailyMacros,
  mockFormatDailySummary,
  mockFormatWeeklySummary,
} = vi.hoisted(() => {
  return {
    mockGetDailyCalories: vi.fn().mockResolvedValue(1200),
    mockGetDailyMeals: vi.fn().mockResolvedValue([]),
    mockGetDailyMacros: vi.fn().mockResolvedValue({ calories: 1200, proteinG: 80, carbsG: 150, fatG: 40 }),
    mockFormatDailySummary: vi.fn().mockReturnValue('📊 Resumo de hoje...'),
    mockFormatWeeklySummary: vi.fn().mockReturnValue('Resumo da semana...'),
  }
})

vi.mock('@/lib/db/queries/meals', () => ({
  getDailyCalories: mockGetDailyCalories,
  getDailyMeals: mockGetDailyMeals,
  getDailyMacros: mockGetDailyMacros,
}))
```

Update `mockUser`:

```typescript
const mockUser = {
  dailyCalorieTarget: 2000,
  dailyProteinG: 120,
  dailyFatG: 65,
  dailyCarbsG: 250,
}
```

Add test:

```typescript
it('passes macros to formatDailySummary when user has macro targets', async () => {
  await handleSummary(supabase, USER_ID, 'hoje', mockUser)

  expect(mockGetDailyMacros).toHaveBeenCalled()
  expect(mockFormatDailySummary).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(Object),
    expect.any(Number),
    2000,
    {
      consumed: { proteinG: 80, fatG: 40, carbsG: 150 },
      target: { proteinG: 120, fatG: 65, carbsG: 250 },
    },
  )
})

it('does not pass macros when user has no macro targets', async () => {
  await handleSummary(supabase, USER_ID, 'hoje', { dailyCalorieTarget: 2000 })

  expect(mockFormatDailySummary).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(Object),
    expect.any(Number),
    2000,
    undefined,
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/bot/summary.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL

- [ ] **Step 3: Implement — update summary.ts**

In `src/lib/bot/flows/summary.ts`:

Update import (line 2):
```typescript
import { getDailyCalories, getDailyMeals, getDailyMacros } from '@/lib/db/queries/meals'
```

Update `handleSummary` user type (line 79):
```typescript
  user: {
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    timezone?: string
  },
```

Pass user to `handleDailySummary` (line 89):
```typescript
  return handleDailySummary(supabase, userId, target, timezone, user)
```

Update `handleDailySummary` (lines 96-108):
```typescript
async function handleDailySummary(
  supabase: SupabaseClient,
  userId: string,
  target: number,
  timezone: string,
  user?: {
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
  },
): Promise<string> {
  const today = new Date()
  const [rows, dailyMacros] = await Promise.all([
    getDailyMeals(supabase, userId, today, timezone),
    getDailyMacros(supabase, userId, today, timezone),
  ])
  const { meals, totalCalories } = buildDailyMealSummary(rows)
  const dateStr = formatDateBR(today, timezone)

  const macros = (user?.dailyProteinG && user?.dailyFatG && user?.dailyCarbsG)
    ? {
        consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
        target: { proteinG: user.dailyProteinG, fatG: user.dailyFatG, carbsG: user.dailyCarbsG },
      }
    : undefined

  return formatDailySummary(dateStr, meals, totalCalories, target, macros)
}
```

- [ ] **Step 4: Update handler.ts call site**

In `src/lib/bot/handler.ts` line 315, pass macro fields in the user object:

```typescript
response = await handleSummary(supabase, user.id, text, {
  dailyCalorieTarget: user.dailyCalorieTarget,
  dailyProteinG: user.dailyProteinG,
  dailyFatG: user.dailyFatG,
  dailyCarbsG: user.dailyCarbsG,
  timezone: user.timezone,
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/bot/summary.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: ALL PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/flows/summary.ts src/lib/bot/handler.ts tests/unit/bot/summary.test.ts
git commit -m "feat: show daily macros in summary flow"
```

---

### Task 5: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: ALL PASS — no regressions in existing tests

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 3: Commit (if any cleanup was needed)**

Only if fixes were required during verification.
