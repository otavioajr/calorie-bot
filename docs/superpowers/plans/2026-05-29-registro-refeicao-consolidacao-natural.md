# Registro de Refeição: Consolidação por Dia/Tipo + Conversa Natural — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o registro de refeição consolidar comida do mesmo tipo num único registro por dia (texto e foto), com confirmação "delta + refeição completa" e suporte a registro retroativo ("ontem"), em vez de criar registros duplicados que parecem substituir a refeição.

**Architecture:** Uma costura única `logFoodToMeal` (find-or-create por `(dia, meal_type)` → append + recalcula, ou cria) usada pelos 3 caminhos de inserção (texto, foto de comida, foto de rótulo). A data de consumo vem de um parser de data extraído para um util compartilhado. A confirmação ganha uma variante "adicionei" e rótulo de data ("Hoje/Ontem/data"). Quando o registro é de outro dia e sem tipo de refeição explícito, o bot pergunta a refeição.

**Tech Stack:** TypeScript (strict), Next.js, Supabase (`@supabase/supabase-js`), Vitest. Banco normalizado `meals` + `meal_items` (sem mudança de schema).

**Spec:** `docs/superpowers/specs/2026-05-29-registro-refeicao-consolidacao-natural-design.md`

**Branch:** `fix/registro-consolidacao-refeicao` (já criada).

---

## Convenções de teste do projeto (ler antes de começar)

- Testes de **query do banco** (`tests/unit/db/*.test.ts`): mockam o cliente Supabase com um "chain thenable". Padrão de `tests/unit/db/meals-detail.test.ts`:

```typescript
function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.gte = vi.fn(() => chain)
  chain.lte = vi.fn(() => chain)
  chain.order = vi.fn(() => chain)
  chain.limit = vi.fn(() => chain)
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}
function buildClient(chain: Record<string, unknown>) {
  return { from: vi.fn(() => chain) }
}
```

- Testes de **fluxo do bot** (`tests/unit/bot/*.test.ts`): usam `vi.hoisted()` + `vi.mock()` por módulo (ver `tests/unit/bot/meal-log.test.ts`).
- Rodar um teste único: `npx vitest run <arquivo> -t "<nome do teste>"`.
- `@/*` → `src/*`. Indentação 2 espaços. Arquivos `kebab-case`.

---

## Estrutura de arquivos

| Arquivo | Criar/Modificar | Responsabilidade |
|---|---|---|
| `src/lib/utils/relative-date.ts` | **Criar** | `parseDateFromMessage`, `localDateString`, `formatDateLabel` (extraído de `meal-detail.ts`) |
| `src/lib/bot/flows/meal-detail.ts` | Modificar | Importar `parseDateFromMessage` do util (remover cópia local) |
| `src/lib/db/queries/meals.ts` | Modificar | `export` em `getDayBoundsForTimezone`; nova query `findMealByTypeForDay` |
| `src/lib/bot/flows/meal-log.ts` | Modificar | Nova orquestração `logFoodToMeal`; `saveMeals`/`appendItemsToMeal` passam a usá-la; receipt "adicionei"; thread de `targetDate`; ask de meal_type backdatado |
| `src/lib/utils/formatters.ts` | Modificar | `formatMealAddition`; param `label` em `formatProgress`; param `dateLabel` em `formatMealBreakdown` |
| `src/lib/bot/handler.ts` | Modificar | `handleIncomingImage`/`handleLabelPortions` via `logFoodToMeal`; caso `awaiting_meal_type` |
| `src/lib/db/queries/context.ts` | Modificar | Novo `awaiting_meal_type` em `ContextType` + `CONTEXT_TTLS` |
| Testes correspondentes | Criar/Modificar | Ver cada task |

---

## Task 1: Query `findMealByTypeForDay`

Acha o registro existente de um `(user, dia, meal_type)` para consolidar. Retorna o mais antigo do dia (ordem `registered_at` asc) ou `null`.

**Files:**
- Modify: `src/lib/db/queries/meals.ts` (adicionar `export` em `getDayBoundsForTimezone:138`; nova função após `getMealDetailByType`)
- Test: `tests/unit/db/find-meal-by-type.test.ts` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/unit/db/find-meal-by-type.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.gte = vi.fn(() => chain)
  chain.lte = vi.fn(() => chain)
  chain.order = vi.fn(() => chain)
  chain.limit = vi.fn(() => chain)
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}
function buildClient(chain: Record<string, unknown>) {
  return { from: vi.fn(() => chain) }
}

describe('findMealByTypeForDay', () => {
  it('returns the existing meal of that type for the day', async () => {
    const { findMealByTypeForDay } = await import('@/lib/db/queries/meals')
    const chain = buildChain({
      data: [{ id: 'meal-1', meal_type: 'breakfast', total_calories: 212, registered_at: '2026-05-29T11:00:00Z' }],
      error: null,
    })
    const supabase = buildClient(chain)

    const result = await findMealByTypeForDay(
      supabase as never, 'user-123', 'breakfast',
      new Date('2026-05-29T14:00:00Z'), 'America/Sao_Paulo',
    )

    expect(supabase.from).toHaveBeenCalledWith('meals')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-123')
    expect(chain.eq).toHaveBeenCalledWith('meal_type', 'breakfast')
    expect(chain.limit).toHaveBeenCalledWith(1)
    expect(result).toEqual({
      id: 'meal-1', mealType: 'breakfast', totalCalories: 212, registeredAt: '2026-05-29T11:00:00Z',
    })
  })

  it('returns null when no meal of that type exists for the day', async () => {
    const { findMealByTypeForDay } = await import('@/lib/db/queries/meals')
    const chain = buildChain({ data: [], error: null })
    const result = await findMealByTypeForDay(
      buildClient(chain) as never, 'user-123', 'breakfast', new Date('2026-05-29T14:00:00Z'),
    )
    expect(result).toBeNull()
  })

  it('throws on query error', async () => {
    const { findMealByTypeForDay } = await import('@/lib/db/queries/meals')
    const chain = buildChain({ data: null, error: { message: 'boom' } })
    await expect(
      findMealByTypeForDay(buildClient(chain) as never, 'u', 'lunch', new Date()),
    ).rejects.toThrow('Failed to find meal by type: boom')
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/unit/db/find-meal-by-type.test.ts`
Expected: FAIL — `findMealByTypeForDay is not a function` / import undefined.

- [ ] **Step 3: Implementar**

Em `src/lib/db/queries/meals.ts`, linha 138, trocar a assinatura privada por exportada:

```typescript
export function getDayBoundsForTimezone(
```

No fim do arquivo (após `getMealDetailByType`, depois da linha 653), adicionar:

```typescript
// ---------------------------------------------------------------------------
// findMealByTypeForDay
// ---------------------------------------------------------------------------

export interface ExistingMeal {
  id: string
  mealType: string
  totalCalories: number
  registeredAt: string
}

/**
 * Returns the earliest meal of the given type for the user on the given day
 * (in the user's timezone), or null. Used to consolidate same-day/same-type logs.
 */
export async function findMealByTypeForDay(
  supabase: SupabaseClient,
  userId: string,
  mealType: string,
  date: Date,
  timezone: string = 'America/Sao_Paulo',
): Promise<ExistingMeal | null> {
  const { startOfDay, endOfDay } = getDayBoundsForTimezone(date, timezone)

  const { data, error } = await supabase
    .from('meals')
    .select('id, meal_type, total_calories, registered_at')
    .eq('user_id', userId)
    .eq('meal_type', mealType)
    .gte('registered_at', startOfDay.toISOString())
    .lte('registered_at', endOfDay.toISOString())
    .order('registered_at', { ascending: true })
    .limit(1)

  if (error) {
    throw new Error(`Failed to find meal by type: ${error.message}`)
  }

  if (!data || (data as unknown[]).length === 0) return null

  const row = (data as Array<Record<string, unknown>>)[0]
  return {
    id: row.id as string,
    mealType: row.meal_type as string,
    totalCalories: row.total_calories as number,
    registeredAt: row.registered_at as string,
  }
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run tests/unit/db/find-meal-by-type.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/queries/meals.ts tests/unit/db/find-meal-by-type.test.ts
git commit -m "feat(meals): findMealByTypeForDay query para consolidação por dia/tipo"
```

---

## Task 2: Util de data relativa (`relative-date.ts`)

Extrair `parseDateFromMessage` de `meal-detail.ts` para um util compartilhado e adicionar `localDateString` + `formatDateLabel`.

**Files:**
- Create: `src/lib/utils/relative-date.ts`
- Modify: `src/lib/bot/flows/meal-detail.ts` (remover cópia local, importar do util)
- Test: `tests/unit/utils/relative-date.test.ts` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/unit/utils/relative-date.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseDateFromMessage, localDateString, formatDateLabel } from '@/lib/utils/relative-date'

const NOW = new Date('2026-05-29T17:00:00Z') // sexta-feira, ~14h em America/Sao_Paulo

describe('parseDateFromMessage', () => {
  it('detects "ontem" (explicit, previous day)', () => {
    const { date, wasExplicit } = parseDateFromMessage('ontem no jantar comi arroz', NOW)
    expect(wasExplicit).toBe(true)
    expect(localDateString(date, 'America/Sao_Paulo')).toBe('2026-05-28')
  })

  it('detects "anteontem" before "ontem"', () => {
    const { date } = parseDateFromMessage('anteontem comi pizza', NOW)
    expect(localDateString(date, 'America/Sao_Paulo')).toBe('2026-05-27')
  })

  it('defaults to today, not explicit, when no date hint', () => {
    const { date, wasExplicit } = parseDateFromMessage('comi 2 ovos', NOW)
    expect(wasExplicit).toBe(false)
    expect(localDateString(date, 'America/Sao_Paulo')).toBe('2026-05-29')
  })
})

describe('formatDateLabel', () => {
  it('labels today as "Hoje"', () => {
    expect(formatDateLabel(new Date('2026-05-29T18:00:00Z'), 'America/Sao_Paulo', NOW)).toBe('Hoje')
  })
  it('labels yesterday as "Ontem"', () => {
    expect(formatDateLabel(new Date('2026-05-28T18:00:00Z'), 'America/Sao_Paulo', NOW)).toBe('Ontem')
  })
  it('labels older dates with day/month', () => {
    const label = formatDateLabel(new Date('2026-05-24T15:00:00Z'), 'America/Sao_Paulo', NOW)
    expect(label).toMatch(/24\/05/)
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/unit/utils/relative-date.test.ts`
Expected: FAIL — módulo `@/lib/utils/relative-date` não existe.

- [ ] **Step 3: Criar o util**

Criar `src/lib/utils/relative-date.ts`:

```typescript
// ---------------------------------------------------------------------------
// Relative date parsing + labels (shared by meal logging and meal_detail query)
// ---------------------------------------------------------------------------

function normalize(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

const WEEKDAY_MAP: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
}

export interface DateParseResult {
  date: Date
  wasExplicit: boolean
}

/**
 * Parses a relative date reference ("ontem", "anteontem", "hoje", weekday, "dia X")
 * out of a message. Returns an instant offset from `now` and whether the reference
 * was explicit. When nothing is found, returns `now` with wasExplicit=false.
 */
export function parseDateFromMessage(message: string, now?: Date): DateParseResult {
  const normalized = normalize(message)
  const today = now ?? new Date()

  if (normalized.includes('anteontem')) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - 2)
    return { date: d, wasExplicit: true }
  }

  if (normalized.includes('ontem')) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - 1)
    return { date: d, wasExplicit: true }
  }

  if (normalized.includes('hoje')) {
    return { date: today, wasExplicit: true }
  }

  for (const [name, dayIndex] of Object.entries(WEEKDAY_MAP)) {
    if (normalized.includes(name)) {
      const currentDay = today.getUTCDay()
      let diff = currentDay - dayIndex
      if (diff < 0) diff += 7
      const d = new Date(today)
      d.setUTCDate(d.getUTCDate() - diff)
      return { date: d, wasExplicit: true }
    }
  }

  const dayMatch = normalized.match(/dia\s+(\d{1,2})/)
  if (dayMatch) {
    const dayNum = parseInt(dayMatch[1], 10)
    const todayDayOfMonth = today.getUTCDate()
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), dayNum, 12, 0, 0))
    if (d.getUTCDate() !== dayNum || dayNum > todayDayOfMonth) {
      d.setUTCMonth(d.getUTCMonth() - 1)
      d.setUTCDate(dayNum)
    }
    return { date: d, wasExplicit: true }
  }

  return { date: today, wasExplicit: false }
}

/** Returns the local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateString(date: Date, timezone: string = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** Human label for a consumption date: "Hoje" | "Ontem" | "qua 24/05". */
export function formatDateLabel(date: Date, timezone: string = 'America/Sao_Paulo', now?: Date): string {
  const reference = now ?? new Date()
  const target = localDateString(date, timezone)
  if (target === localDateString(reference, timezone)) return 'Hoje'
  const yesterday = new Date(reference.getTime() - 24 * 60 * 60 * 1000)
  if (target === localDateString(yesterday, timezone)) return 'Ontem'

  const formatted = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(date)
  // "qua., 24/05" -> "qua 24/05"
  return formatted.replace(/\.,?/g, '').replace(/\s+/g, ' ').trim()
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/utils/relative-date.test.ts`
Expected: PASS.

- [ ] **Step 5: Apontar `meal-detail.ts` para o util (DRY)**

Em `src/lib/bot/flows/meal-detail.ts`:
1. Adicionar import no topo (após linha 4):

```typescript
import { parseDateFromMessage, type DateParseResult } from '@/lib/utils/relative-date'
```

2. Remover o bloco local `WEEKDAY_MAP`, `DateParseResult` e `parseDateFromMessage` (linhas ~43-112). Manter a função `normalize` local (ainda usada por `parseMealType`).
3. Se algum lugar do arquivo referencia `DateParseResult` localmente, agora usa o import.

- [ ] **Step 6: Rodar a suíte de meal-detail e confirmar que continua passando**

Run: `npx vitest run tests/unit/bot/meal-detail.test.ts`
Expected: PASS (sem regressão).

- [ ] **Step 7: Commit**

```bash
git add src/lib/utils/relative-date.ts tests/unit/utils/relative-date.test.ts src/lib/bot/flows/meal-detail.ts
git commit -m "refactor(date): extrai parseDateFromMessage para util + localDateString/formatDateLabel"
```

---

## Task 3: Orquestração `logFoodToMeal` (find-or-create + append + backdate)

Costura central. Recebe itens já no formato do banco (`MealItemInput`) e: acha o registro de `(targetDate, mealType)` → append + recalcula; senão cria (backdatando `registered_at` se o dia alvo ≠ hoje). Retorna `wasAppend`, `mealId`, itens adicionados e a refeição consolidada.

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts` (novo export + helper de mapeamento)
- Test: `tests/unit/bot/log-food-to-meal.test.ts` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/unit/bot/log-food-to-meal.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockFindMealByTypeForDay, mockCreateMeal, mockAddMealItems,
  mockRecalculateMealTotal, mockGetMealWithItems,
} = vi.hoisted(() => ({
  mockFindMealByTypeForDay: vi.fn(),
  mockCreateMeal: vi.fn(),
  mockAddMealItems: vi.fn().mockResolvedValue(undefined),
  mockRecalculateMealTotal: vi.fn(),
  mockGetMealWithItems: vi.fn(),
}))

vi.mock('@/lib/db/queries/meals', () => ({
  findMealByTypeForDay: mockFindMealByTypeForDay,
  createMeal: mockCreateMeal,
  addMealItems: mockAddMealItems,
  recalculateMealTotal: mockRecalculateMealTotal,
  getMealWithItems: mockGetMealWithItems,
  getDayBoundsForTimezone: vi.fn(() => ({
    startOfDay: new Date('2026-05-28T03:00:00Z'),
    endOfDay: new Date('2026-05-29T02:59:59.999Z'),
  })),
}))

import { logFoodToMeal } from '@/lib/bot/flows/meal-log'

const ITEM = {
  foodName: 'Açaí', quantityGrams: 67, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual',
}
const supabase = {} as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('logFoodToMeal', () => {
  it('appends to an existing meal of the same type/day and returns the consolidated meal', async () => {
    mockFindMealByTypeForDay.mockResolvedValue({ id: 'meal-1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x' })
    mockRecalculateMealTotal.mockResolvedValue(292)
    mockGetMealWithItems.mockResolvedValue({
      id: 'meal-1', mealType: 'breakfast', totalCalories: 292, registeredAt: 'x',
      items: [
        { id: 'a', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' },
        { id: 'b', foodName: 'Queijo mussarela', quantityGrams: 20, quantityDisplay: '1 fatia', calories: 66, proteinG: 5, carbsG: 0, fatG: 5, source: 'taco', confidence: 'high' },
        { id: 'c', foodName: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual', confidence: 'high' },
      ],
    })

    const result = await logFoodToMeal(supabase, {
      userId: 'u', mealType: 'breakfast', items: [ITEM],
      originalMessage: 'comi também 67g de açaí', targetDate: new Date('2026-05-29T12:00:00Z'),
    })

    expect(mockCreateMeal).not.toHaveBeenCalled()
    expect(mockAddMealItems).toHaveBeenCalledWith(supabase, 'meal-1', [ITEM])
    expect(mockRecalculateMealTotal).toHaveBeenCalledWith(supabase, 'meal-1')
    expect(result.wasAppend).toBe(true)
    expect(result.mealId).toBe('meal-1')
    expect(result.addedItems).toEqual([ITEM])
    expect(result.meal.items).toHaveLength(3)
    expect(result.meal.totalCalories).toBe(292)
  })

  it('creates a new meal when none exists for the day/type', async () => {
    mockFindMealByTypeForDay.mockResolvedValue(null)
    mockCreateMeal.mockResolvedValue('new-meal')
    mockGetMealWithItems.mockResolvedValue({
      id: 'new-meal', mealType: 'breakfast', totalCalories: 80, registeredAt: 'x',
      items: [{ id: 'c', foodName: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual', confidence: 'high' }],
    })

    const result = await logFoodToMeal(supabase, {
      userId: 'u', mealType: 'breakfast', items: [ITEM], originalMessage: 'comi açaí',
      // same local day as "now" -> no registeredAt override expected
      targetDate: new Date(),
    })

    expect(mockCreateMeal).toHaveBeenCalledTimes(1)
    const createArg = mockCreateMeal.mock.calls[0][1]
    expect(createArg.registeredAt).toBeUndefined()
    expect(result.wasAppend).toBe(false)
    expect(result.mealId).toBe('new-meal')
  })

  it('backdates registered_at to local noon when the target day is not today', async () => {
    mockFindMealByTypeForDay.mockResolvedValue(null)
    mockCreateMeal.mockResolvedValue('back-meal')
    mockGetMealWithItems.mockResolvedValue({ id: 'back-meal', mealType: 'dinner', totalCalories: 80, registeredAt: 'x', items: [] })

    await logFoodToMeal(supabase, {
      userId: 'u', mealType: 'dinner', items: [ITEM], originalMessage: 'ontem jantei açaí',
      targetDate: new Date('2026-05-28T12:00:00Z'),
    })

    const createArg = mockCreateMeal.mock.calls[0][1]
    expect(createArg.registeredAt).toBeInstanceOf(Date)
    // startOfDay (mock) + 12h = 2026-05-28T15:00:00Z
    expect((createArg.registeredAt as Date).toISOString()).toBe('2026-05-28T15:00:00.000Z')
  })
})
```

> Nota: o terceiro teste assume `localDateString(targetDate) !== localDateString(now)`. Como `targetDate` é 2026-05-28 e a suíte roda "hoje" (≠ 28/05/2026), o ramo de backdate é exercido. Se algum dia a suíte rodar exatamente em 28/05/2026, esse teste de borda pode precisar de `now` injetável — ver Step 3 (passamos `now` opcional só em teste, default `new Date()`).

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/unit/bot/log-food-to-meal.test.ts`
Expected: FAIL — `logFoodToMeal` não existe.

- [ ] **Step 3: Implementar `logFoodToMeal`**

Em `src/lib/bot/flows/meal-log.ts`:

1. Atualizar o import de `meals` (linha 6) para incluir os novos símbolos:

```typescript
import { addMealItems, createMeal, getDailyCalories, getDailyMacros, recalculateMealTotal, getMealWithItems, findMealByTypeForDay, getDayBoundsForTimezone } from '@/lib/db/queries/meals'
import type { MealItemInput, MealWithItems } from '@/lib/db/queries/meals'
```

2. Adicionar import do util de data (após linha 14):

```typescript
import { localDateString } from '@/lib/utils/relative-date'
```

3. Adicionar, logo após o bloco de `EnrichedItem` (após linha 48), um helper de mapeamento + a função `logFoodToMeal`:

```typescript
// ---------------------------------------------------------------------------
// Map an EnrichedItem to the DB input shape (single source of truth)
// ---------------------------------------------------------------------------

export function enrichedToMealItemInput(item: EnrichedItem): MealItemInput {
  return {
    foodName: item.food,
    quantityGrams: item.quantityGrams,
    calories: item.calories,
    proteinG: item.protein,
    carbsG: item.carbs,
    fatG: item.fat,
    source: item.source,
    tacoId: item.tacoId,
    productId: item.productId,
    confidence: item.source === 'approximate' ? 'low' : 'high',
    quantityDisplay: item.quantityDisplay ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// logFoodToMeal — single consolidation seam (find-or-create by day+meal_type)
// ---------------------------------------------------------------------------

export interface LogFoodResult {
  wasAppend: boolean
  mealId: string
  addedItems: MealItemInput[]
  meal: MealWithItems
}

export interface LogFoodParams {
  userId: string
  mealType: string
  items: MealItemInput[]
  originalMessage: string
  llmResponse?: unknown
  targetDate?: Date
  timezone?: string
  now?: Date
}

export async function logFoodToMeal(
  supabase: SupabaseClient,
  params: LogFoodParams,
): Promise<LogFoodResult> {
  const timezone = params.timezone ?? 'America/Sao_Paulo'
  const now = params.now ?? new Date()
  const targetDate = params.targetDate ?? now

  const existing = await findMealByTypeForDay(supabase, params.userId, params.mealType, targetDate, timezone)

  if (existing) {
    await addMealItems(supabase, existing.id, params.items)
    await recalculateMealTotal(supabase, existing.id)
    const meal = await getMealWithItems(supabase, existing.id)
    return {
      wasAppend: true,
      mealId: existing.id,
      addedItems: params.items,
      meal: meal!,
    }
  }

  // New meal. Backdate registered_at to local noon when target day != today.
  let registeredAt: Date | undefined
  if (localDateString(targetDate, timezone) !== localDateString(now, timezone)) {
    const { startOfDay } = getDayBoundsForTimezone(targetDate, timezone)
    registeredAt = new Date(startOfDay.getTime() + 12 * 60 * 60 * 1000)
  }

  const totalCalories = Math.round(params.items.reduce((sum, i) => sum + i.calories, 0))
  const mealId = await createMeal(supabase, {
    userId: params.userId,
    mealType: params.mealType,
    totalCalories,
    originalMessage: params.originalMessage,
    llmResponse: params.llmResponse ?? {},
    items: params.items,
    registeredAt,
  })
  const meal = await getMealWithItems(supabase, mealId)
  return {
    wasAppend: false,
    mealId,
    addedItems: params.items,
    meal: meal!,
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/bot/log-food-to-meal.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts tests/unit/bot/log-food-to-meal.test.ts
git commit -m "feat(meal-log): logFoodToMeal — costura única de consolidação por dia/tipo + backdate"
```

---

## Task 4: Confirmação "delta + refeição" e rótulo de data

`formatMealAddition` (mensagem de append) + `label` opcional em `formatProgress` + `dateLabel` opcional em `formatMealBreakdown`.

**Files:**
- Modify: `src/lib/utils/formatters.ts`
- Test: `tests/unit/utils/format-meal-addition.test.ts` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/unit/utils/format-meal-addition.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { formatMealAddition, formatProgress, formatMealBreakdown } from '@/lib/utils/formatters'

const ADDED = [{ food: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80 }]
const FULL = [
  { food: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146 },
  { food: 'Queijo mussarela', quantityGrams: 20, quantityDisplay: '1 fatia', calories: 66 },
  { food: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80 },
]

describe('formatMealAddition', () => {
  it('frames as "Somei … ao …" and lists the full meal', () => {
    const msg = formatMealAddition('breakfast', ADDED, FULL, 292, 292, 2168, 'Hoje')
    expect(msg).toContain('Somei')
    expect(msg).toContain('Açaí')
    expect(msg).toContain('Café da manhã agora:')
    expect(msg).toContain('Ovo')
    expect(msg).toContain('Queijo mussarela')
    expect(msg).toContain('Total: 292 kcal')
    expect(msg).toContain('📊 Hoje: 292 / 2168 kcal')
  })

  it('uses the date label for backdated additions', () => {
    const msg = formatMealAddition('dinner', ADDED, FULL, 292, 292, 2168, 'Ontem')
    expect(msg).toContain('📊 Ontem: 292 / 2168 kcal')
  })
})

describe('formatProgress label', () => {
  it('defaults to "Hoje"', () => {
    expect(formatProgress(100, 2000)).toContain('📊 Hoje: 100 / 2000 kcal')
  })
  it('accepts a custom label', () => {
    expect(formatProgress(100, 2000, undefined, 'Ontem')).toContain('📊 Ontem: 100 / 2000 kcal')
  })
})

describe('formatMealBreakdown dateLabel', () => {
  it('passes a custom date label through to the progress line', () => {
    const msg = formatMealBreakdown('breakfast', ADDED, 80, 80, 2000, undefined, 'Ontem')
    expect(msg).toContain('📊 Ontem: 80 / 2000 kcal')
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/unit/utils/format-meal-addition.test.ts`
Expected: FAIL — `formatMealAddition` não existe; `formatProgress`/`formatMealBreakdown` não aceitam label.

- [ ] **Step 3: Implementar**

Em `src/lib/utils/formatters.ts`:

3a. `formatProgress` (linha 234) — adicionar `label` no fim e usar na string. Substituir a assinatura e as duas linhas de `calorieLine`:

```typescript
export function formatProgress(
  consumed: number,
  target: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
  label: string = 'Hoje',
): string {
  const remaining = target - consumed

  let calorieLine: string
  if (remaining < 0) {
    const over = Math.abs(remaining)
    calorieLine = `📊 ${label}: ${consumed} / ${target} kcal (excedeu ${over} ⚠️)`
  } else {
    calorieLine = `📊 ${label}: ${consumed} / ${target} kcal (restam ${remaining})`
  }

  if (!macros) {
    return calorieLine
  }

  const macroLine = `P: ${macros.consumed.proteinG}/${macros.target.proteinG}g | G: ${macros.consumed.fatG}/${macros.target.fatG}g | C: ${macros.consumed.carbsG}/${macros.target.carbsG}g`
  return `${calorieLine}\n${macroLine}`
}
```

3b. `formatMealBreakdown` (linha 45) — adicionar `dateLabel` no fim e repassar ao `formatProgress`. Trocar a assinatura (adicionar parâmetro) e a chamada de `formatProgress`:

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
  dateLabel: string = 'Hoje',
): string {
```

E na linha que monta `progressLine` (atual linha 65):

```typescript
  const progressLine = formatProgress(dailyConsumed, dailyTarget, macros, dateLabel)
```

3c. Adicionar `formatMealAddition` logo após `formatMealBreakdown` (depois da linha 84):

```typescript
// ---------------------------------------------------------------------------
// formatMealAddition — confirmation when items were appended to an existing meal
// ---------------------------------------------------------------------------
export function formatMealAddition(
  mealType: string,
  addedItems: MealItem[],
  fullItems: MealItem[],
  mealTotal: number,
  dailyConsumed: number,
  dailyTarget: number,
  dateLabel: string = 'Hoje',
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
  const renderItem = (item: MealItem): string => {
    const display = item.quantityDisplay || `${item.quantityGrams}g`
    const calStr = item.confidence === 'low' ? `~${item.calories}` : `${item.calories}`
    const indicator = item.confidence === 'low' ? ' ⚠️' : ''
    return `• ${item.food} (${display}) — ${calStr} kcal${indicator}`
  }

  const addedSummary = addedItems
    .map((i) => {
      const display = i.quantityDisplay || `${i.quantityGrams}g`
      return `${i.food} (${display}) — ${i.calories} kcal`
    })
    .join(', ')

  const fullLines = fullItems.map(renderItem).join('\n')
  const progressLine = formatProgress(dailyConsumed, dailyTarget, macros, dateLabel)

  return [
    `🍽️ Somei ${addedSummary} ao ${translateMealType(mealType).toLowerCase()}.`,
    '',
    `${translateMealType(mealType)} agora:`,
    fullLines,
    `Total: ${mealTotal} kcal`,
    '',
    progressLine,
    '',
    'Algo errado? Manda "corrigir"',
  ].filter(Boolean).join('\n')
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/utils/format-meal-addition.test.ts`
Expected: PASS.

- [ ] **Step 5: Garantir que nada quebrou em formatters**

Run: `npx vitest run tests/unit/utils tests/unit/bot/meal-log.test.ts`
Expected: PASS (parâmetros novos são opcionais → retrocompatível).

- [ ] **Step 6: Commit**

```bash
git add src/lib/utils/formatters.ts tests/unit/utils/format-meal-addition.test.ts
git commit -m "feat(formatters): formatMealAddition + rótulo de data em formatProgress/formatMealBreakdown"
```

---

## Task 5: Foto de comida via `logFoodToMeal` (consolidação + confirmação "adicionei")

Refatorar o branch de foto de comida em `handleIncomingImage` para consolidar e mostrar a refeição completa quando soma.

**Files:**
- Modify: `src/lib/bot/handler.ts` (`handleIncomingImage`, branch ~925-982)
- Test: `tests/unit/bot/handler-image-consolidation.test.ts` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/unit/bot/handler-image-consolidation.test.ts` (mocka as dependências de `handleIncomingImage` e verifica que uma foto consolida no café da manhã existente e responde com "Somei"):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  mockFindUserByPhone: vi.fn(),
  mockCreateUser: vi.fn(),
  mockDownload: vi.fn().mockResolvedValue(Buffer.from('fakejpeg')),
  mockAnalyzeImage: vi.fn(),
  mockLogFoodToMeal: vi.fn(),
  mockGetDailyCalories: vi.fn().mockResolvedValue(292),
  mockSendText: vi.fn().mockResolvedValue('sent-id'),
  mockSaveHistory: vi.fn(),
  mockSaveBotMessages: vi.fn(),
  mockSetState: vi.fn().mockResolvedValue(undefined),
  mockGetMealWithItems: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/db/supabase', () => ({ createServiceRoleClient: vi.fn(() => ({})) }))
vi.mock('@/lib/db/queries/users', () => ({ findUserByPhone: h.mockFindUserByPhone, createUser: h.mockCreateUser }))
vi.mock('@/lib/whatsapp/media', () => ({ downloadWhatsAppMedia: h.mockDownload, MediaTooLargeError: class extends Error {}, MAX_IMAGE_SIZE: 5_000_000 }))
vi.mock('@/lib/llm/index', () => ({ getLLMProvider: vi.fn(() => ({ analyzeImage: h.mockAnalyzeImage })) }))
vi.mock('@/lib/bot/flows/meal-log', () => ({ logFoodToMeal: h.mockLogFoodToMeal, handleMealLog: vi.fn() }))
vi.mock('@/lib/db/queries/meals', () => ({ getDailyCalories: h.mockGetDailyCalories, getMealWithItems: h.mockGetMealWithItems, createMeal: vi.fn() }))
vi.mock('@/lib/whatsapp/client', () => ({ sendTextMessage: h.mockSendText }))
vi.mock('@/lib/bot/state', () => ({ setState: h.mockSetState, clearState: vi.fn() }))
// ...additional mocks as needed for imports pulled in by handler.ts (saveHistory, logLLMUsage, etc.)

beforeEach(() => vi.clearAllMocks())

describe('handleIncomingImage — food photo consolidation', () => {
  it('appends a food photo to the existing breakfast and replies with "Somei"', async () => {
    h.mockFindUserByPhone.mockResolvedValue({
      id: 'u1', onboardingComplete: true, calorieMode: 'taco', dailyCalorieTarget: 2168, timezone: 'America/Sao_Paulo',
    })
    h.mockAnalyzeImage.mockResolvedValue({
      image_type: 'food', confidence: 'high', needs_clarification: false, unknown_items: [],
      items: [{ food: 'Açaí', quantity_grams: 67, calories: 80, protein: 1, carbs: 18, fat: 0.5 }],
    })
    h.mockLogFoodToMeal.mockResolvedValue({
      wasAppend: true, mealId: 'meal-1',
      addedItems: [{ foodName: 'Açaí', quantityGrams: 67, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual' }],
      meal: { id: 'meal-1', mealType: 'breakfast', totalCalories: 292, registeredAt: 'x', items: [
        { id: 'a', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' },
        { id: 'b', foodName: 'Queijo mussarela', quantityGrams: 20, quantityDisplay: '1 fatia', calories: 66, proteinG: 5, carbsG: 0, fatG: 5, source: 'taco', confidence: 'high' },
        { id: 'c', foodName: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual', confidence: 'high' },
      ] },
    })

    const { handleIncomingImage } = await import('@/lib/bot/handler')
    await handleIncomingImage('5511999', 'msg-1', 'img-1', 'Comi também no café da manhã 67g desse açaí')

    expect(h.mockLogFoodToMeal).toHaveBeenCalledTimes(1)
    const sent = h.mockSendText.mock.calls.map(c => c[1]).join('\n')
    expect(sent).toContain('Somei')
    expect(sent).toContain('Café da manhã agora:')
    expect(sent).toContain('Total: 292 kcal')
  })
})
```

> O conjunto exato de `vi.mock` deve cobrir TODOS os módulos importados no topo de `handler.ts` (ex.: `saveHistory`, `logLLMUsage`, `saveBotMessages`, `resolveMealTypeFromContext`, etc.). Ao escrever o teste, abra `handler.ts:1-60` e espelhe os imports. Use `tests/unit/bot/handler.test.ts` como referência do conjunto de mocks já estabelecido.

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/unit/bot/handler-image-consolidation.test.ts`
Expected: FAIL — hoje o branch chama `createMeal` direto e responde com "registrado!", não "Somei".

- [ ] **Step 3: Implementar — refatorar o branch de foto de comida**

Em `src/lib/bot/handler.ts`:

3a. Garantir imports (topo do arquivo): adicionar `logFoodToMeal` e os formatters/util:

```typescript
import { logFoodToMeal } from '@/lib/bot/flows/meal-log'
import { formatMealAddition } from '@/lib/utils/formatters'
import { parseDateFromMessage, formatDateLabel } from '@/lib/utils/relative-date'
```
(Manter os imports já existentes de `formatMealBreakdown`, `createMeal`, `getMealWithItems`, `getDailyCalories`, `resolveMealTypeFromContext`, etc.)

3b. Substituir o bloco atual de foto de comida (linhas 925-982, do `const imageTotal = …` até o `await saveBotMessages(...)` que fecha o branch não-rótulo) por:

```typescript
    const originalMessage = caption || '[imagem]'
    const { date: targetDate } = parseDateFromMessage(originalMessage)
    const dateLabel = formatDateLabel(targetDate, user.timezone)

    const logResult = await logFoodToMeal(supabase, {
      userId: user.id,
      mealType: mealAnalysis.meal_type,
      items: mealAnalysis.items.map((item) => ({
        foodName: item.food,
        quantityGrams: item.quantity_grams ?? 0,
        calories: item.calories ?? 0,
        proteinG: item.protein ?? 0,
        carbsG: item.carbs ?? 0,
        fatG: item.fat ?? 0,
        source: 'manual' as const,
      })),
      originalMessage,
      llmResponse: mealAnalysis as unknown as Record<string, unknown>,
      targetDate,
      timezone: user.timezone,
    })

    // Keep recent_meal state pointing at the consolidated meal (for corrections)
    if (logResult.meal.items.length > 0) {
      await setState(user.id, 'recent_meal', {
        mealId: logResult.mealId,
        mealType: logResult.meal.mealType,
        items: logResult.meal.items.map(i => ({
          id: i.id, foodName: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay,
          calories: i.calories, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG,
        })),
      })
    }

    const dailyConsumed = await getDailyCalories(supabase, user.id, targetDate, user.timezone)
    const target = user.dailyCalorieTarget ?? 2000

    const fullItems = logResult.meal.items.map(i => ({
      food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories,
    }))
    const addedForMsg = logResult.addedItems.map(i => ({
      food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay ?? null, calories: i.calories,
    }))

    const response = logResult.wasAppend
      ? formatMealAddition(logResult.meal.mealType, addedForMsg, fullItems, logResult.meal.totalCalories, dailyConsumed, target, dateLabel)
      : formatMealBreakdown(
          logResult.meal.mealType,
          fullItems,
          logResult.meal.totalCalories,
          dailyConsumed,
          target,
          undefined,
          dateLabel,
        )

    const imgSentId = await sendTextMessage(from, response)
    saveHistory(supabase, user.id, caption || '[imagem de alimento]', response)
    await saveBotMessages(supabase, user.id, messageId, imgSentId, 'meal', logResult.mealId)
```

> Observação: remover a declaração antiga de `const imageTotal`, `const mealId = await createMeal(...)` e o `getMealWithItems`/`setState` antigos desse branch — tudo é substituído pelo bloco acima. O `originalMessage` agora é declarado aqui (antes ele era declarado na linha 926).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/bot/handler-image-consolidation.test.ts tests/unit/bot/handler.test.ts`
Expected: PASS (novo teste + sem regressão no handler existente; ajustar mocks de `handler.test.ts` se ele cobria o branch de foto com `createMeal` — atualizar expectativa para `logFoodToMeal`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/handler.ts tests/unit/bot/handler-image-consolidation.test.ts
git commit -m "feat(image): foto de comida consolida no registro do dia/tipo via logFoodToMeal"
```

---

## Task 6: Foto de rótulo nutricional via `logFoodToMeal`

`handleLabelPortions` (handler.ts:991) hoje sempre `createMeal`. Passar por `logFoodToMeal`, parseando a data da legenda guardada em `originalMessage`.

**Files:**
- Modify: `src/lib/bot/handler.ts` (`handleLabelPortions`, linhas 991-1075)
- Test: `tests/unit/bot/handler-label-consolidation.test.ts` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/unit/bot/handler-label-consolidation.test.ts` espelhando os mocks da Task 5, mas exercitando `handleIncomingImage` com `image_type: 'nutrition_label'` e legenda `"Comi também no café da manhã 67g desse açaí"` (porções resolvidas pela legenda → `handleLabelPortions` imediato). Asserções:

```typescript
    expect(h.mockLogFoodToMeal).toHaveBeenCalledTimes(1)
    const arg = h.mockLogFoodToMeal.mock.calls[0][1]
    expect(arg.mealType).toBe('breakfast')
    const sent = h.mockSendText.mock.calls.map(c => c[1]).join('\n')
    expect(sent).toContain('Somei')
```

> O mock de `scaleNutritionLabelItem`/`extractLabelGramsFromCaption` pode ser real (funções puras já testadas). Garanta que `analyzeImage` retorne um item com `quantity_grams` = porção do rótulo (ex.: 60) para `extractLabelGramsFromCaption('...67g...')`/serving=60 resultar em `resolvedPortions ≈ 1.1`.

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/unit/bot/handler-label-consolidation.test.ts`
Expected: FAIL — hoje `handleLabelPortions` cria refeição nova e responde "registrado!".

- [ ] **Step 3: Implementar — refatorar `handleLabelPortions`**

Em `src/lib/bot/handler.ts`, substituir o corpo de `handleLabelPortions` a partir do `// Save meal to database…` (linha 1019) até o fim da função (linha 1074) por:

```typescript
  const originalMessage = (context.contextData.originalMessage as string) || '[imagem]'
  const { date: targetDate } = parseDateFromMessage(originalMessage)
  const dateLabel = formatDateLabel(targetDate, user.timezone)

  const logResult = await logFoodToMeal(supabase, {
    userId,
    mealType: multipliedAnalysis.meal_type,
    items: multipliedItems.map((item) => ({
      foodName: item.food,
      quantityGrams: item.quantity_grams ?? 0,
      calories: item.calories ?? 0,
      proteinG: item.protein ?? 0,
      carbsG: item.carbs ?? 0,
      fatG: item.fat ?? 0,
      source: 'manual' as const,
    })),
    originalMessage,
    llmResponse: multipliedAnalysis as unknown as Record<string, unknown>,
    targetDate,
    timezone: user.timezone,
  })

  if (logResult.meal.items.length > 0) {
    await setState(userId, 'recent_meal', {
      mealId: logResult.mealId,
      mealType: logResult.meal.mealType,
      items: logResult.meal.items.map(i => ({
        id: i.id, foodName: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay,
        calories: i.calories, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG,
      })),
    })
  } else {
    await clearState(userId)
  }

  const dailyConsumed = await getDailyCalories(supabase, userId, targetDate, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000

  const fullItems = logResult.meal.items.map(i => ({
    food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories,
  }))
  const addedForMsg = logResult.addedItems.map(i => ({
    food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay ?? null, calories: i.calories,
  }))

  const response = logResult.wasAppend
    ? formatMealAddition(logResult.meal.mealType, addedForMsg, fullItems, logResult.meal.totalCalories, dailyConsumed, target, dateLabel)
    : formatMealBreakdown(logResult.meal.mealType, fullItems, logResult.meal.totalCalories, dailyConsumed, target, undefined, dateLabel)

  const labelSentId = await sendTextMessage(from, response)
  await saveBotMessages(supabase, userId, incomingMessageId, labelSentId, 'meal', logResult.mealId)
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/bot/handler-label-consolidation.test.ts tests/unit/bot/label-portions.test.ts tests/unit/bot/nutrition-label.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/handler.ts tests/unit/bot/handler-label-consolidation.test.ts
git commit -m "feat(image): foto de rótulo consolida no registro do dia/tipo via logFoodToMeal"
```

---

## Task 7: Texto via `logFoodToMeal` (consolida além dos 5 min + receipt "adicionei" + backdate)

`saveMeals` passa a usar `logFoodToMeal` (consolida sempre por dia/tipo). `analyzeAndRegister` calcula `targetDate` e o repassa. O receipt single-meal vira "adicionei" quando foi append.

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`
- Test: `tests/unit/bot/meal-log-consolidation.test.ts` (criar) + ajustes em `tests/unit/bot/meal-log.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/unit/bot/meal-log-consolidation.test.ts` reaproveitando o cabeçalho de mocks de `tests/unit/bot/meal-log.test.ts`, mas adicionando ao mock de `@/lib/db/queries/meals` as funções `findMealByTypeForDay`, `addMealItems`, `recalculateMealTotal`, `getMealWithItems`, `getDayBoundsForTimezone`. Cenário: usuário já tem café da manhã (212) e manda por texto "comi também 1 pão no café da manhã". Mockar `findMealByTypeForDay` → registro existente e verificar que NÃO cria refeição nova e que a resposta usa "Somei".

```typescript
// dentro do bloco de mocks de '@/lib/db/queries/meals':
//   findMealByTypeForDay: mockFindMealByTypeForDay,
//   addMealItems: vi.fn().mockResolvedValue(undefined),
//   recalculateMealTotal: vi.fn().mockResolvedValue(278),
//   getMealWithItems: mockGetMealWithItems,
//   getDayBoundsForTimezone: vi.fn(() => ({ startOfDay: new Date('2026-05-29T03:00:00Z'), endOfDay: new Date('2026-05-30T02:59:59.999Z') })),

it('consolidates a text log into the existing same-day breakfast', async () => {
  mockFindMealByTypeForDay.mockResolvedValue({ id: 'b1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x' })
  mockGetMealWithItems.mockResolvedValue({
    id: 'b1', mealType: 'breakfast', totalCalories: 278, registeredAt: 'x',
    items: [
      { id: '1', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' },
      { id: '2', foodName: 'Queijo mussarela', quantityGrams: 20, quantityDisplay: '1 fatia', calories: 66, proteinG: 5, carbsG: 0, fatG: 5, source: 'taco', confidence: 'high' },
      { id: '3', foodName: 'Pão', quantityGrams: 50, quantityDisplay: null, calories: 66, proteinG: 2, carbsG: 13, fatG: 1, source: 'taco', confidence: 'high' },
    ],
  })
  mockAnalyzeMeal.mockResolvedValue([{
    meal_type: 'breakfast', confidence: 'high', references_previous: false, reference_query: null,
    items: [{ food: 'Pão', quantity_grams: 50, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
    unknown_items: [], needs_clarification: false,
  }])
  mockMatchTacoByBase.mockResolvedValue([{ id: 9, foodName: 'Pão francês', foodBase: 'Pão', foodVariant: 'francês', caloriesPer100g: 132, proteinPer100g: 4, carbsPer100g: 26, fatPer100g: 2, isDefault: true }])

  const result = await handleMealLog(buildSupabase(), USER_ID, 'comi também 1 pão no café da manhã', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, null)

  expect(mockCreateMeal).not.toHaveBeenCalled()
  expect(result.response).toContain('Somei')
})
```

> Como `meal-log.test.ts` mocka `formatMealBreakdown`/`formatProgress`, neste novo arquivo mocke também `formatMealAddition` para retornar uma string contendo "Somei" (`mockFormatMealAddition: vi.fn().mockReturnValue('Somei ... ao café da manhã')`) e inclua-o no `vi.mock('@/lib/utils/formatters', ...)`.

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/unit/bot/meal-log-consolidation.test.ts`
Expected: FAIL — hoje `saveMeals` chama `createMeal` (logo `mockCreateMeal` é chamado) e o receipt diz "registrado!".

- [ ] **Step 3: Implementar**

Em `src/lib/bot/flows/meal-log.ts`:

3a. Importar o util de data (já feito na Task 3 import de `localDateString`; adicionar `parseDateFromMessage` e `formatDateLabel`):

```typescript
import { localDateString, parseDateFromMessage, formatDateLabel } from '@/lib/utils/relative-date'
```

3b. Importar `formatMealAddition` (linha 7, junto aos outros formatters):

```typescript
import { formatMealBreakdown, formatMultiMealBreakdown, formatProgress, formatSearchFeedback, formatDefaultNotice, formatMealAddition } from '@/lib/utils/formatters'
```

3c. Reescrever `saveMeals` (linhas 803-849) para usar `logFoodToMeal` e retornar resultados ricos. Nova assinatura/retorno:

```typescript
async function saveMeals(
  supabase: SupabaseClient,
  userId: string,
  meals: MealAnalysis[],
  enrichedMeals: EnrichedItem[][],
  originalMessage: string,
  targetDate?: Date,
  timezone?: string,
): Promise<LogFoodResult[]> {
  const results: LogFoodResult[] = []
  for (let i = 0; i < meals.length; i++) {
    const analysis = meals[i]
    const items = (enrichedMeals[i] ?? []).map(enrichedToMealItemInput)

    const result = await logFoodToMeal(supabase, {
      userId,
      mealType: analysis.meal_type,
      items,
      originalMessage,
      llmResponse: analysis as unknown as Record<string, unknown>,
      targetDate,
      timezone,
    })
    results.push(result)
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

  return results
}
```

3d. Atualizar os chamadores de `saveMeals` para o novo retorno (`LogFoodResult[]`):

- `handleHistorySelection` (linha 783): `const results = await saveMeals(...)`; `const lastMealId = results[results.length - 1].mealId`; usar `lastMealId` onde antes usava `mealIds[mealIds.length - 1]`; passar `targetDate`/`timezone` (parsear de `originalMessage` — ver 3e).
- `analyzeAndRegister` history single-match (linha 1160), partial meal (linha 1229) e final register (linha 1272): idem — trocar `mealIds`/`savedIds` por `results.map(r => r.mealId)` conforme necessário.
- `handleBulkQuantitiesResponse` (linha 1049): `const results = await saveMeals(...)`; `savedMealId = results[results.length - 1]?.mealId ?? null`.

3e. No topo de `analyzeAndRegister` (após linha 1116), calcular a data alvo e passar adiante:

```typescript
  const { date: targetDate } = parseDateFromMessage(originalMessage)
  const dateLabel = formatDateLabel(targetDate, user.timezone)
```
Passar `targetDate, user.timezone` em TODAS as chamadas a `saveMeals` dentro de `analyzeAndRegister`.

3f. Receipt "adicionei" no caminho final (linhas 1271-1287). Substituir o trecho final por:

```typescript
  // Register (consolidating by day + meal_type)
  const results = await saveMeals(supabase, userId, meals, enrichedMeals, originalMessage, targetDate, user.timezone)
  const lastResult = results[results.length - 1]
  await saveRecentMealState(supabase, userId, lastResult.mealId)

  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000
  const macros = (user.dailyProteinG && user.dailyFatG && user.dailyCarbsG)
    ? {
        consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
        target: { proteinG: user.dailyProteinG, fatG: user.dailyFatG, carbsG: user.dailyCarbsG },
      }
    : undefined

  // Single meal that was appended → "Somei …" receipt with the full consolidated meal
  if (results.length === 1 && lastResult.wasAppend) {
    const fullItems = lastResult.meal.items.map(i => ({
      food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories,
    }))
    const addedForMsg = lastResult.addedItems.map(i => ({
      food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay ?? null, calories: i.calories,
    }))
    const response = formatMealAddition(
      lastResult.meal.mealType, addedForMsg, fullItems, lastResult.meal.totalCalories,
      dailyMacros.calories, target, dateLabel, macros,
    )
    return { response, completed: true, mealId: lastResult.mealId }
  }

  const response = buildReceiptResponse(meals, enrichedMeals, dailyMacros.calories, target, macros, dateLabel)
  return { response, completed: true, mealId: lastResult.mealId }
```

3g. `buildReceiptResponse` (linha 173) — aceitar `dateLabel` e repassá-lo a `formatMealBreakdown`. Adicionar o parâmetro no fim:

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
  dateLabel: string = 'Hoje',
): string {
```
E na chamada de `formatMealBreakdown` dentro dela (linha 196), acrescentar `dateLabel` como último argumento (após `macros`).

> As demais chamadas a `buildReceiptResponse` (history single-match linha 1170, history selection linha 794) podem permanecer sem `dateLabel` (default 'Hoje') ou passar o `dateLabel` calculado, conforme o caminho tenha `targetDate`. Para o caminho de history single-match dentro de `analyzeAndRegister`, passar `dateLabel`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/bot/meal-log-consolidation.test.ts`
Expected: PASS.

- [ ] **Step 5: Corrigir regressões em `meal-log.test.ts`**

O mock de `@/lib/db/queries/meals` em `tests/unit/bot/meal-log.test.ts` precisa ganhar `findMealByTypeForDay` (default `mockResolvedValue(null)` → cai no caminho create, preservando o comportamento esperado pelos testes antigos), `addMealItems`, `recalculateMealTotal`, `getDayBoundsForTimezone`, e o mock de formatters precisa de `formatMealAddition`. Atualizar e rodar:

Run: `npx vitest run tests/unit/bot/meal-log.test.ts`
Expected: PASS (ajustar expectativas que afirmavam `createMeal` chamado: com `findMealByTypeForDay→null`, `logFoodToMeal` ainda chama `createMeal`, então essas continuam válidas).

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts tests/unit/bot/meal-log-consolidation.test.ts tests/unit/bot/meal-log.test.ts
git commit -m "feat(meal-log): texto consolida por dia/tipo + receipt adicionei + backdate"
```

---

## Task 8: Perguntar a refeição quando o registro é de outro dia sem tipo explícito

**Files:**
- Modify: `src/lib/db/queries/context.ts` (novo `awaiting_meal_type`)
- Modify: `src/lib/bot/flows/meal-log.ts` (detectar backdate-sem-tipo no caminho final; handler do estado)
- Modify: `src/lib/bot/handler.ts` (rotear `awaiting_meal_type`)
- Test: `tests/unit/bot/meal-log-backdate-ask.test.ts` (criar)

- [ ] **Step 1: Adicionar o tipo de contexto (sem teste próprio — coberto pelo fluxo)**

Em `src/lib/db/queries/context.ts`:
- Em `CONTEXT_TTLS` (linha 3), adicionar: `awaiting_meal_type: 10,`
- Na união `ContextType` (linha 26), adicionar: `| 'awaiting_meal_type'`

- [ ] **Step 2: Escrever o teste que falha (fluxo no meal-log)**

Criar `tests/unit/bot/meal-log-backdate-ask.test.ts` (mesmos mocks de `meal-log-consolidation.test.ts`). Cenário: "ontem comi 2 ovos" (data explícita, sem meal_type). Esperado: `setState('awaiting_meal_type', …)` chamado e resposta perguntando a refeição; `createMeal`/`logFoodToMeal` NÃO chamados ainda. Em seguida, simular a resposta "café da manhã" via `handleMealLog` com contexto `awaiting_meal_type` e verificar que `logFoodToMeal` é chamado com `mealType: 'breakfast'` e `targetDate` de ontem.

```typescript
it('asks for the meal type when backdated without explicit meal_type', async () => {
  mockAnalyzeMeal.mockResolvedValue([{
    meal_type: 'snack', confidence: 'high', references_previous: false, reference_query: null,
    items: [{ food: 'Ovo', quantity_grams: 100, quantity_display: '2 ovos', quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
    unknown_items: [], needs_clarification: false,
  }])
  mockMatchTacoByBase.mockResolvedValue([{ id: 1, foodName: 'Ovo', foodBase: 'Ovo', foodVariant: 'cozido', caloriesPer100g: 146, proteinPer100g: 12, carbsPer100g: 1, fatPer100g: 10, isDefault: true }])

  const res = await handleMealLog(buildSupabase(), USER_ID, 'ontem comi 2 ovos', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, null)

  expect(mockSetState).toHaveBeenCalledWith(USER_ID, 'awaiting_meal_type', expect.objectContaining({ originalMessage: 'ontem comi 2 ovos' }))
  expect(res.completed).toBe(false)
  expect(res.response.toLowerCase()).toContain('refeição')
})

it('registers on the chosen meal type for the backdated day', async () => {
  mockFindMealByTypeForDay.mockResolvedValue(null)
  mockCreateMeal.mockResolvedValue('m-back')
  mockGetMealWithItems.mockResolvedValue({ id: 'm-back', mealType: 'breakfast', totalCalories: 146, registeredAt: 'x', items: [{ id: '1', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' }] })

  const ctx = {
    id: 'c', userId: USER_ID, contextType: 'awaiting_meal_type' as const,
    contextData: {
      items: [{ foodName: 'Ovo', quantityGrams: 100, quantityDisplay: '2 ovos', calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco' }],
      targetDateISO: '2026-05-28T12:00:00.000Z',
      originalMessage: 'ontem comi 2 ovos',
    },
    expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: new Date().toISOString(),
  }
  const res = await handleMealLog(buildSupabase(), USER_ID, 'café da manhã', { calorieMode: 'taco', dailyCalorieTarget: 2168 }, ctx)

  const arg = mockLogFoodToMeal ? undefined : mockCreateMeal.mock.calls[0]?.[1]
  // logFoodToMeal is internal here; assert via createMeal mealType + completed
  expect(res.completed).toBe(true)
})
```

> Nota: neste arquivo, `logFoodToMeal` é o real (não mockado), então a asserção se dá por `createMeal`/`findMealByTypeForDay`. Verifique `mockCreateMeal.mock.calls[0][1].mealType === 'breakfast'` e `registeredAt` definido (backdate).

- [ ] **Step 3: Rodar e confirmar falha**

Run: `npx vitest run tests/unit/bot/meal-log-backdate-ask.test.ts`
Expected: FAIL — não existe ramo de ask nem handler de `awaiting_meal_type`.

- [ ] **Step 4: Implementar — detectar backdate-sem-tipo e o handler de resposta**

Em `src/lib/bot/flows/meal-log.ts`:

4a. Importar o detector de meal_type explícito (de `meal-time.ts`):

```typescript
import { getUserLocalTime, detectExplicitMealType } from '@/lib/utils/meal-time'
```
(`getUserLocalTime` já é importado na linha 14 — apenas acrescentar `detectExplicitMealType`.)

4b. No `handleMealLog` (linha 593), adicionar um branch para o novo estado, antes do `awaiting_clarification`:

```typescript
  if (context?.contextType === 'awaiting_meal_type') {
    return handleAwaitingMealType(supabase, userId, trimmed, context, user)
  }
```

4c. No caminho final de `analyzeAndRegister` (logo após o cálculo de `targetDate`/`dateLabel` e ANTES de registrar — ou seja, imediatamente antes do `const results = await saveMeals(...)` introduzido na Task 7), inserir a checagem de backdate-sem-tipo. Como precisamos dos itens já enriquecidos, fazer a checagem após a montagem de `enrichedMeals` (linha ~1269) e antes do `saveMeals`:

```typescript
  // Backdated log without an explicit meal type → ask which meal (single-meal case only)
  const dateWasBackdated = localDateString(targetDate, user.timezone) !== localDateString(new Date(), user.timezone)
  const explicitMealType = detectExplicitMealType(originalMessage)
  if (dateWasBackdated && !explicitMealType && enrichedMeals.length === 1) {
    await setState(userId, 'awaiting_meal_type', {
      items: enrichedMeals[0].map(enrichedToMealItemInput) as unknown as Record<string, unknown>,
      targetDateISO: targetDate.toISOString(),
      originalMessage,
    })
    return {
      response: 'Esse registro é de outro dia. Em qual refeição? (café da manhã, almoço, lanche, jantar ou ceia)',
      completed: false,
    }
  }
```

4d. Adicionar o handler `handleAwaitingMealType` (junto aos outros handlers de estado, ex.: após `handleHistorySelection`):

```typescript
async function handleAwaitingMealType(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user: { dailyCalorieTarget: number | null; dailyProteinG?: number | null; dailyFatG?: number | null; dailyCarbsG?: number | null; timezone?: string },
): Promise<MealLogResult> {
  const mealType = detectExplicitMealType(message)
  if (!mealType) {
    return {
      response: 'Não entendi a refeição. Responde com: café da manhã, almoço, lanche, jantar ou ceia.',
      completed: false,
    }
  }

  const items = (context.contextData.items as MealItemInput[]) ?? []
  const targetDate = new Date(context.contextData.targetDateISO as string)
  const originalMessage = (context.contextData.originalMessage as string) ?? ''

  const result = await logFoodToMeal(supabase, {
    userId,
    mealType,
    items,
    originalMessage,
    targetDate,
    timezone: user.timezone,
  })
  await clearState(userId)

  const dailyConsumed = await getDailyCalories(supabase, userId, targetDate, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000
  const dateLabel = formatDateLabel(targetDate, user.timezone)

  const fullItems = result.meal.items.map(i => ({
    food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories,
  }))

  if (result.wasAppend) {
    const addedForMsg = result.addedItems.map(i => ({
      food: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay ?? null, calories: i.calories,
    }))
    return {
      response: formatMealAddition(result.meal.mealType, addedForMsg, fullItems, result.meal.totalCalories, dailyConsumed, target, dateLabel),
      completed: true,
      mealId: result.mealId,
    }
  }

  return {
    response: formatMealBreakdown(result.meal.mealType, fullItems, result.meal.totalCalories, dailyConsumed, target, undefined, dateLabel),
    completed: true,
    mealId: result.mealId,
  }
}
```

4e. Em `src/lib/bot/handler.ts`, rotear o estado novo. No `switch (context.contextType)` (linha 317), adicionar um case que delega a `handleMealLog` (igual a `awaiting_clarification`/`awaiting_bulk_quantities`):

```typescript
        case 'awaiting_meal_type': {
          const mealResult = await handleMealLog(supabase, user.id, text, userSettings, context)
          const mtSentId = await sendTextMessage(from, mealResult.response)
          saveHistory(supabase, user.id, text, mealResult.response)
          await saveBotMessages(supabase, user.id, messageId, mtSentId,
            mealResult.completed && mealResult.mealId ? 'meal' : null,
            mealResult.mealId ?? null)
          return
        }
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/bot/meal-log-backdate-ask.test.ts`
Expected: PASS.

- [ ] **Step 6: Rodar a suíte de contexto/estado para garantir o tipo novo**

Run: `npx vitest run tests/unit/bot/state.test.ts tests/unit/bot/handler.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/queries/context.ts src/lib/bot/flows/meal-log.ts src/lib/bot/handler.ts tests/unit/bot/meal-log-backdate-ask.test.ts
git commit -m "feat(meal-log): pergunta a refeição em registro retroativo sem tipo explícito"
```

---

## Task 9: `appendItemsToMeal` — rotear por tipo correto em vez de falhar calado

Trocar o `return null` de `meal-log.ts:650` por: rotear os itens para a refeição do tipo correto via `logFoodToMeal`, usando o `mealType` já conhecido do alvo.

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts` (`appendItemsToMeal`, linhas 624-697)
- Test: `tests/unit/bot/append-items-routing.test.ts` (criar) + checar `tests/unit/bot/edit.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/unit/bot/append-items-routing.test.ts` (mocks de `meal-log.test.ts` + `findMealByTypeForDay`). Cenário: alvo é `breakfast`, mas a mensagem "comi também frango no almoço" re-classifica para `lunch`. Esperado: NÃO retorna null silencioso; em vez disso os itens vão para o almoço (find-or-create lunch). Asserção: `result` não-nulo e `findMealByTypeForDay`/`createMeal` chamados para `lunch`.

```typescript
it('routes mismatched meal_type items to the correct meal instead of dropping them', async () => {
  mockGetMealWithItems.mockResolvedValue({ id: 'b1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x', items: [] })
  mockAnalyzeMeal.mockResolvedValue([{
    meal_type: 'lunch', confidence: 'high', references_previous: false, reference_query: null,
    items: [{ food: 'Frango', quantity_grams: 120, quantity_display: null, quantity_source: 'estimated', portion_type: 'unit', has_user_quantity: true, calories: null, protein: null, carbs: null, fat: null, confidence: 'high' }],
    unknown_items: [], needs_clarification: false,
  }])
  mockMatchTacoByBase.mockResolvedValue([{ id: 7, foodName: 'Frango grelhado', foodBase: 'Frango', foodVariant: 'grelhado', caloriesPer100g: 159, proteinPer100g: 32, carbsPer100g: 0, fatPer100g: 3, isDefault: true }])
  mockFindMealByTypeForDay.mockResolvedValue(null) // no lunch yet today
  mockCreateMeal.mockResolvedValue('lunch-1')
  mockGetMealWithItems.mockResolvedValueOnce({ id: 'b1', mealType: 'breakfast', totalCalories: 212, registeredAt: 'x', items: [] })

  const { appendItemsToMeal } = await import('@/lib/bot/flows/meal-log')
  const result = await appendItemsToMeal(buildSupabase(), USER_ID, 'b1', 'comi também frango no almoço', { timezone: 'America/Sao_Paulo' })

  expect(result).not.toBeNull()
  expect(mockCreateMeal).toHaveBeenCalled() // created the lunch meal
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run tests/unit/bot/append-items-routing.test.ts`
Expected: FAIL — hoje retorna `null` quando `meal_type` diverge.

- [ ] **Step 3: Implementar**

Em `src/lib/bot/flows/meal-log.ts`, dentro de `appendItemsToMeal`, substituir o bloco do guard (linhas 646-650) e a inserção (linhas 674-696). Em vez de validar e dar `return null`, separar os itens cujo `meal_type` bate do alvo dos que divergem, e rotear cada grupo via `logFoodToMeal`. Reescrever a parte final da função (a partir do guard) por:

```typescript
  const targetMeal = await getMealWithItems(supabase, mealId)
  if (!targetMeal) return null

  const resolvedItems = items.filter((item) => {
    const hasQuantity = item.quantity_grams !== null && item.quantity_grams !== undefined && item.quantity_grams > 0
    const isUnit = item.portion_type === 'unit'
    const userProvided = item.has_user_quantity === true
    return hasQuantity || isUnit || userProvided
  })
  if (resolvedItems.length === 0) return null

  let enriched: EnrichedItem[]
  try {
    enriched = await enrichItemsWithTaco(supabase, resolvedItems, llm, userId)
  } catch (err) {
    if (err instanceof ProductInteractionRequired) return null
    throw err
  }

  const validEnriched = enriched.filter((e): e is EnrichedItem => e !== null && e !== undefined)
  if (validEnriched.length === 0) return null

  // Map each enriched item to the meal_type its source message implies. Items whose
  // analyzed meal_type matches the target go to the target meal; the rest are routed
  // (find-or-create) to a meal of their own type for today — nothing is silently dropped.
  const targetType = targetMeal.mealType
  const itemTypeByFood = new Map<string, string>()
  for (const m of meals) {
    for (const it of m.items) itemTypeByFood.set(it.food.toLowerCase(), m.meal_type)
  }

  const sameTypeInputs: MealItemInput[] = []
  const otherByType = new Map<string, MealItemInput[]>()
  for (const item of validEnriched) {
    const input = enrichedToMealItemInput(item)
    const itemType = itemTypeByFood.get(item.food.toLowerCase()) ?? targetType
    if (itemType === targetType) {
      sameTypeInputs.push(input)
    } else {
      const bucket = otherByType.get(itemType) ?? []
      bucket.push(input)
      otherByType.set(itemType, bucket)
    }
  }

  // Same-type items → append directly to the target meal
  if (sameTypeInputs.length > 0) {
    await addMealItems(supabase, mealId, sameTypeInputs)
  }
  // Other-type items → their own meal (today), via the consolidation seam
  for (const [type, inputs] of otherByType) {
    await logFoodToMeal(supabase, {
      userId, mealType: type, items: inputs, originalMessage: message, timezone: user?.timezone,
    })
  }

  for (const item of validEnriched) {
    if (item.tacoId && item.source === 'taco') {
      const foodBase = item.defaultFoodBase ?? item.food
      await recordTacoUsage(supabase, foodBase, item.tacoId, userId)
    }
  }

  const newTotal = await recalculateMealTotal(supabase, mealId)
  return { added: validEnriched, newTotal }
```

> Observação: remover o antigo `resolvedItems`/`enriched`/`addMealItems` duplicado mais abaixo na função (linhas 652-696 originais) — tudo é substituído pelo bloco acima. `MealItemInput` já está importado (Task 3).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/bot/append-items-routing.test.ts tests/unit/bot/edit.test.ts`
Expected: PASS (o teste de add_item por linguagem natural em `edit.test.ts:407+` continua válido — `findMealByTypeForDay` no mock deve devolver o alvo; ajustar mock se necessário).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts tests/unit/bot/append-items-routing.test.ts
git commit -m "fix(meal-log): roteia itens de tipo divergente em vez de descartar no append"
```

---

## Task 10: Teste de integração in-memory — reproduz o print (texto → foto-rótulo → 1 café com 3 itens)

Valida a costura real (`logFoodToMeal`) com um Supabase fake em memória que de fato armazena `meals`/`meal_items`, provando consolidação e total 292.

**Files:**
- Test: `tests/unit/bot/log-food-to-meal-integration.test.ts` (criar)

- [ ] **Step 1: Escrever o teste (in-memory Supabase fake)**

Criar `tests/unit/bot/log-food-to-meal-integration.test.ts`. Aqui NÃO mockamos `@/lib/db/queries/meals` — usamos as queries reais contra um fake do cliente Supabase que implementa o subconjunto usado (`from().insert().select().single()`, `select().eq().eq().gte().lte().order().limit()`, `select().eq()`, `update().eq()`).

```typescript
import { describe, it, expect } from 'vitest'
import { logFoodToMeal } from '@/lib/bot/flows/meal-log'
import { createInMemorySupabase } from '../../helpers/in-memory-supabase'

describe('integration: consolidação café da manhã (texto + foto)', () => {
  it('soma o açaí no café da manhã existente → 1 refeição, 3 itens, 292 kcal', async () => {
    const supabase = createInMemorySupabase()
    const userId = 'user-1'
    const today = new Date()

    // 1) texto: ovos + queijo (cria o café da manhã)
    const r1 = await logFoodToMeal(supabase as never, {
      userId, mealType: 'breakfast',
      items: [
        { foodName: 'Ovo', quantityGrams: 100, calories: 146, proteinG: 12, carbsG: 1, fatG: 10, source: 'taco' },
        { foodName: 'Queijo mussarela', quantityGrams: 20, calories: 66, proteinG: 5, carbsG: 0, fatG: 5, source: 'taco' },
      ],
      originalMessage: 'comi 2 ovos e queijo', targetDate: today,
    })
    expect(r1.wasAppend).toBe(false)

    // 2) foto-rótulo: açaí (deve SOMAR no mesmo café da manhã)
    const r2 = await logFoodToMeal(supabase as never, {
      userId, mealType: 'breakfast',
      items: [{ foodName: 'Açaí', quantityGrams: 67, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.5, source: 'manual' }],
      originalMessage: 'comi também 67g de açaí', targetDate: today,
    })

    expect(r2.wasAppend).toBe(true)
    expect(r2.mealId).toBe(r1.mealId)
    expect(r2.meal.items).toHaveLength(3)
    expect(r2.meal.totalCalories).toBe(292)
  })
})
```

- [ ] **Step 2: Criar o helper de Supabase em memória**

Criar `tests/helpers/in-memory-supabase.ts` implementando só o necessário para `createMeal`, `addMealItems`, `recalculateMealTotal`, `getMealWithItems`, `findMealByTypeForDay`:

```typescript
import { vi } from 'vitest'

interface MealRow { id: string; user_id: string; meal_type: string; total_calories: number; registered_at: string; original_message: string; llm_response: unknown }
interface ItemRow { id: string; meal_id: string; food_name: string; quantity_grams: number; quantity_display: string | null; calories: number; protein_g: number; carbs_g: number; fat_g: number; source: string; confidence: string; taco_id: number | null; product_id: string | null }

export function createInMemorySupabase() {
  const meals: MealRow[] = []
  const items: ItemRow[] = []
  let seq = 0
  const id = (p: string) => `${p}-${++seq}`

  function applyFilters<T extends Record<string, unknown>>(rows: T[], filters: Array<[string, string, unknown]>): T[] {
    return rows.filter(row =>
      filters.every(([op, col, val]) => {
        const v = row[col] as unknown
        if (op === 'eq') return v === val
        if (op === 'gte') return String(v) >= String(val)
        if (op === 'lte') return String(v) <= String(val)
        return true
      }),
    )
  }

  return {
    from(table: string) {
      if (table === 'meals') return mealsTable()
      if (table === 'meal_items') return itemsTable()
      throw new Error(`Unexpected table ${table}`)
    },
  }

  function mealsTable() {
    const filters: Array<[string, string, unknown]> = []
    let insertPayload: Record<string, unknown> | null = null
    let updatePayload: Record<string, unknown> | null = null
    const api: Record<string, unknown> = {}
    api.insert = (payload: Record<string, unknown>) => { insertPayload = payload; return api }
    api.update = (payload: Record<string, unknown>) => { updatePayload = payload; return api }
    api.select = () => api
    api.eq = (c: string, v: unknown) => { filters.push(['eq', c, v]); return api }
    api.gte = (c: string, v: unknown) => { filters.push(['gte', c, v]); return api }
    api.lte = (c: string, v: unknown) => { filters.push(['lte', c, v]); return api }
    api.order = () => api
    api.limit = () => api
    api.single = async () => {
      if (insertPayload) {
        const row: MealRow = {
          id: id('meal'),
          user_id: insertPayload.user_id as string,
          meal_type: insertPayload.meal_type as string,
          total_calories: insertPayload.total_calories as number,
          registered_at: (insertPayload.registered_at as string) ?? new Date().toISOString(),
          original_message: (insertPayload.original_message as string) ?? '',
          llm_response: insertPayload.llm_response ?? {},
        }
        meals.push(row)
        return { data: { id: row.id }, error: null }
      }
      const found = applyFilters(meals, filters)[0]
      return found ? { data: found, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    }
    api.then = (resolve: (v: unknown) => unknown) => {
      if (updatePayload) {
        for (const m of applyFilters(meals, filters)) Object.assign(m, updatePayload)
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      return Promise.resolve({ data: applyFilters(meals, filters), error: null }).then(resolve)
    }
    return api
  }

  function itemsTable() {
    const filters: Array<[string, string, unknown]> = []
    let insertPayload: Array<Record<string, unknown>> | null = null
    const api: Record<string, unknown> = {}
    api.insert = (payload: Array<Record<string, unknown>>) => { insertPayload = payload; return api }
    api.select = () => api
    api.eq = (c: string, v: unknown) => { filters.push(['eq', c, v]); return api }
    api.then = (resolve: (v: unknown) => unknown) => {
      if (insertPayload) {
        for (const p of insertPayload) {
          items.push({
            id: id('item'), meal_id: p.meal_id as string, food_name: p.food_name as string,
            quantity_grams: p.quantity_grams as number, quantity_display: (p.quantity_display as string) ?? null,
            calories: p.calories as number, protein_g: p.protein_g as number, carbs_g: p.carbs_g as number, fat_g: p.fat_g as number,
            source: p.source as string, confidence: (p.confidence as string) ?? 'high',
            taco_id: (p.taco_id as number) ?? null, product_id: (p.product_id as string) ?? null,
          })
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      return Promise.resolve({ data: applyFilters(items, filters), error: null }).then(resolve)
    }
    return api
  }
}
```

> Se algum método do cliente real usado por essas 5 queries não estiver coberto (ex.: `getMealWithItems` faz `from('meals').select(...).eq('id').single()` e depois `from('meal_items').select(...).eq('meal_id')`), o fake acima já cobre ambos. Rodar e ajustar pontualmente se faltar um operador.

- [ ] **Step 3: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/bot/log-food-to-meal-integration.test.ts`
Expected: PASS — `wasAppend=true`, mesmo `mealId`, 3 itens, total 292.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/bot/log-food-to-meal-integration.test.ts tests/helpers/in-memory-supabase.ts
git commit -m "test(meal-log): integração in-memory reproduz consolidação do café da manhã (292)"
```

---

## Fechamento

- [ ] **Rodar a suíte inteira + lint**

Run: `npm test && npm run lint`
Expected: tudo verde. Corrigir o que aparecer.

- [ ] **Verificação manual (opcional, recomendado)**

Subir local (`npm run dev` + `ngrok`) e testar pelo WhatsApp:
1. "Comi no café da manhã 2 ovos e uma fatia de queijo mussarela" → registra café (212).
2. Foto do rótulo com legenda "Comi também no café da manhã 67g desse açaí" → resposta "Somei Açaí … ao café da manhã", refeição completa, total 292, **um só** café da manhã.
3. "ontem no jantar comi X" → registra no dia certo, rótulo "Ontem".
4. "ontem comi 2 ovos" → pergunta a refeição; responder "café da manhã" → registra ontem.

- [ ] **Abrir PR para review** (não mergear sem revisar — ver `feedback_review_prs_before_merge`)

```bash
git push -u origin fix/registro-consolidacao-refeicao
gh pr create --title "fix: consolida registro de refeição por dia/tipo + registro natural/retroativo" --body "Ver spec e plano em docs/superpowers/."
```

---

## Self-review (cobertura do spec)

| Requisito do spec | Task |
|---|---|
| Uma refeição por (dia, meal_type) | 1 (query), 3 (logFoodToMeal), 5/6/7 (wiring) |
| Costura única `logFoodToMeal` nos 3 caminhos | 3, 5, 6, 7 |
| Foto deixa de ser ilha | 5, 6 |
| Backdate (texto e legenda) | 2 (parser), 3 (registered_at), 5/6/7 (targetDate) |
| Backdate sem tipo → perguntar | 8 |
| Confirmação delta + refeição | 4, 5, 6, 7, 8 |
| Rótulo de data (Hoje/Ontem/data) | 2, 4 |
| Conserto do guard que falha calado | 9 |
| Testes (unit, repro/integração) | todas + 10 |

**Limitações documentadas (do spec):** lanche/ceia repetidos somam num único registro por tipo/dia; registros duplicados antigos não são migrados; backdate-sem-tipo trata o caso single-meal (multi-meal retroativo usa o tipo derivado); corrida de mensagens é baixo risco (processamento sequencial + dedup).
