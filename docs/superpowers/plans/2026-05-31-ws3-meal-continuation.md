# Meal Continuation Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um alimento logado logo após uma refeição (ex.: "comi também X") deve continuar a refeição anterior em vez de abrir uma nova classificada por horário — valendo para TEXTO e FOTO.

**Architecture:** O coração é uma função pura `resolveMealTypeWithContinuation` em `src/lib/utils/meal-time.ts`, totalmente testável (janela de tempo, marcador, tipo explícito vence, negação, multi-refeição). Ela é plugada em dois pontos: (1) no fluxo de texto, dentro de `analyzeAndRegister` (`src/lib/bot/flows/meal-log.ts`), recebendo o `recent_meal` propagado pelo handler; (2) no fluxo de imagem (`src/lib/bot/handler.ts:handleIncomingImage`), que passa a LER `getState` e a tratar o `meal_type` do vision como fonte primária. O `recent_meal` state ganha um `registeredAt` para a janela de 90 min ser robusta (desacoplada do TTL de 5 min). `detectExplicitMealType` ganha guarda de negação; `parseMealType` (meal-detail) é centralizado na tokenização de meal-time.

**Tech Stack:** TypeScript strict, Vitest, Next.js, Supabase. Convenções do repo: testes em `tests/unit/<domínio>/`, mock Supabase via buildChain thenable, Conventional Commits, alias `@/*` → `src/*`.

---

## Decisões de produto (defaults escolhidos)

1. **Marcadores de continuação** — default: detecção por token (NFD, sem acento) de `tambem` (cobre "também"), `mais`, `ainda`, `tb`, e bigramas `e tambem` / `comi tambem` / `tomei tambem` / `inclui`. Roda sobre tokens (não `includes()`), evitando casar substrings tipo "maisena". _Alternativa:_ lista mínima só `tambem`/`tb`; ou detector via LLM.
2. **Quando herdar mealType** — default: herda só se (a) recent_meal do mesmo dia local, (b) dentro de 90 min do `registeredAt` do recent_meal, (c) sem meal_type explícito na mensagem, e (d) com marcador de continuação. Senão, comportamento atual. _Alternativa:_ sempre herdar se recente (arriscado); ou só recência sem marcador.
3. **vision meal_type primário (imagem)** — default: `continuation ? recentType : (visionMealType ?? resolveMealTypeFromContext(...))`. _Alternativa:_ manter `resolveMealTypeFromContext` primário e vision só fallback.
4. **Negação** — default: guarda simples — token de negação (`nao`, `nem`) até 2 tokens antes da keyword anula a detecção explícita daquela keyword. _Alternativa:_ ignorar negação; ou LLM.
5. **Multi-refeição no texto/legenda** — default: último meal keyword por posição vence. _Alternativa:_ primeiro vence; ou abrir fluxo de múltiplas refeições.
6. **parseMealType** — default: tokenizar igual meal-time (variante lenient que aceita "cafe" bare). _Alternativa:_ manter `includes()` (frágil) — rejeitado.

## File Structure

```
src/lib/utils/meal-time.ts          # + detectContinuationMarker, + resolveMealTypeWithContinuation,
                                     #   + negação em detectExplicitMealType, + detectExplicitMealTypeLenient,
                                     #   + tipo RecentMealRef
src/lib/bot/meal-response.ts        # setRecentMealState passa a gravar registeredAt
src/lib/bot/flows/meal-log.ts       # analyzeAndRegister aplica continuação; handleMealLog/LogFoodParams
                                     #   propagam recentMeal vindo do context
src/lib/bot/handler.ts              # handleIncomingImage lê getState + usa vision meal_type primário +
                                     #   continuação; texto repassa recent_meal ao handleMealLog
src/lib/bot/flows/meal-detail.ts    # parseMealType delega a detectExplicitMealTypeLenient
tests/unit/utils/meal-time.test.ts  # testes das novas funções puras
tests/unit/bot/meal-response.test.ts# registeredAt gravado
tests/unit/bot/meal-detail.test.ts  # parseMealType continua passando após refactor
```

---

### Task 1: `detectContinuationMarker` (função pura)

**Files:** Modify `src/lib/utils/meal-time.ts` (após `detectExplicitMealType`, ~linha 83) / Test `tests/unit/utils/meal-time.test.ts`

- [ ] **Step 1: Write the failing test** — adicione ao final de `tests/unit/utils/meal-time.test.ts`:
```ts
import {
  detectContinuationMarker,
} from '@/lib/utils/meal-time'

describe('detectContinuationMarker', () => {
  it.each([
    ['comi também um pão', true],
    ['tambem tomei leite', true],
    ['mais uma banana', true],
    ['ainda comi arroz', true],
    ['tb 1 ovo', true],
    ['e também 200ml de leite', true],
  ])('detects continuation in %s', (msg, expected) => {
    expect(detectContinuationMarker(msg)).toBe(expected)
  })

  it.each([
    ['comi arroz e feijão'],
    ['1 yakult'],
    ['maisena com leite'],   // "maisena" não pode casar "mais"
    ['lanchonete da esquina'],
    [''],
  ])('returns false for %s', (msg) => {
    expect(detectContinuationMarker(msg)).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(detectContinuationMarker(null)).toBe(false)
    expect(detectContinuationMarker(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/utils/meal-time.test.ts`. Expected: FAIL — `detectContinuationMarker is not a function` / import não resolvido.

- [ ] **Step 3: Write minimal implementation** — em `src/lib/utils/meal-time.ts`, logo após `detectExplicitMealType` (depois da linha 83), adicione:
```ts
// Continuation markers ("também", "mais", "ainda"…) signal the user is adding to the
// meal they just logged, not starting a new one. Matched over tokens (NFD, accent-free)
// so substrings like "maisena" don't falsely trigger "mais".
const CONTINUATION_UNIGRAMS = new Set(['tambem', 'mais', 'ainda', 'tb', 'inclui'])
const CONTINUATION_BIGRAMS: Array<[string, string]> = [
  ['e', 'tambem'],
  ['comi', 'tambem'],
  ['tomei', 'tambem'],
]

export function detectContinuationMarker(message?: string | null): boolean {
  if (!message) return false
  const tokens = tokenize(message)
  if (tokens.length === 0) return false

  for (const token of tokens) {
    if (CONTINUATION_UNIGRAMS.has(token)) return true
  }
  for (const [a, b] of CONTINUATION_BIGRAMS) {
    if (tokensContainPhrase(tokens, [a, b])) return true
  }
  return false
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/utils/meal-time.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/utils/meal-time.ts tests/unit/utils/meal-time.test.ts && git commit -m "feat(meal-time): detectContinuationMarker (também/mais/ainda) por token"`

---

### Task 2: Negação em `detectExplicitMealType`

**Files:** Modify `src/lib/utils/meal-time.ts` (`detectExplicitMealType`, ~71-83) / Test `tests/unit/utils/meal-time.test.ts`

- [ ] **Step 1: Write the failing test** — adicione dentro do `describe('detectExplicitMealType', …)` existente:
```ts
  it('ignores a meal keyword negated immediately before it', () => {
    expect(detectExplicitMealType('não é almoço')).toBeNull()
    expect(detectExplicitMealType('nem jantar nem ceia')).toBeNull()
  })

  it('still detects the affirmed meal in "não é almoço, é lanche"', () => {
    expect(detectExplicitMealType('não é almoço, é lanche')).toBe('snack')
  })
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/utils/meal-time.test.ts`. Expected: FAIL — `'não é almoço'` retorna `'lunch'` (não há guarda de negação).

- [ ] **Step 3: Write minimal implementation** — em `src/lib/utils/meal-time.ts`, adicione o set de negação perto do topo (após `MEAL_KEYWORDS`, ~linha 43):
```ts
const NEGATION_TOKENS = new Set(['nao', 'nem'])
```
e substitua a função `tokensContainPhrase` por uma variante que rejeita ocorrências negadas. Edite `detectExplicitMealType` (linhas 71-83) para usar uma checagem por índice. Reescreva `tokensContainPhrase` (linhas 56-69) e `detectExplicitMealType` assim:
```ts
// Returns the START index of the first match of phraseTokens within tokens, or -1.
function findPhraseIndex(tokens: string[], phraseTokens: string[]): number {
  if (phraseTokens.length === 0) return -1
  for (let i = 0; i <= tokens.length - phraseTokens.length; i++) {
    let match = true
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) {
        match = false
        break
      }
    }
    if (match) return i
  }
  return -1
}

function tokensContainPhrase(tokens: string[], phraseTokens: string[]): boolean {
  return findPhraseIndex(tokens, phraseTokens) !== -1
}

// A match is "negated" when a negation token (não/nem) sits within the 2 tokens
// immediately preceding the phrase start.
function isNegatedAt(tokens: string[], start: number): boolean {
  for (let k = Math.max(0, start - 2); k < start; k++) {
    if (NEGATION_TOKENS.has(tokens[k])) return true
  }
  return false
}

export function detectExplicitMealType(caption?: string | null): MealType | null {
  if (!caption) return null
  const tokens = tokenize(caption)
  if (tokens.length === 0) return null

  for (const { phrases, mealType } of MEAL_KEYWORDS) {
    for (const phrase of phrases) {
      const phraseTokens = phrase.split(' ')
      const idx = findPhraseIndex(tokens, phraseTokens)
      if (idx !== -1 && !isNegatedAt(tokens, idx)) return mealType
    }
  }
  return null
}
```
Nota: a tokenização remove vírgula, então em `'nao e almoco, e lanche'` os tokens são `['nao','e','almoco','e','lanche']`. `almoco` (idx 2) é negado por `nao` em idx 0 (dentro de 2 antes); `lanche` (idx 4) não é negado → retorna `'snack'`. (A ordem de `MEAL_KEYWORDS` testa breakfast→lunch→snack; lunch é descartado por negação, então snack vence.)

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/utils/meal-time.test.ts`. Expected: PASS (incluindo os casos antigos de `detectExplicitMealType`, que não têm negação).

- [ ] **Step 5: Commit** — `git add src/lib/utils/meal-time.ts tests/unit/utils/meal-time.test.ts && git commit -m "feat(meal-time): guarda de negação em detectExplicitMealType"`

---

### Task 3: Multi-refeição — `detectExplicitMealType` retorna o ÚLTIMO mencionado

**Files:** Modify `src/lib/utils/meal-time.ts` (`detectExplicitMealType`) / Test `tests/unit/utils/meal-time.test.ts`

- [ ] **Step 1: Write the failing test** — adicione no `describe('detectExplicitMealType', …)`:
```ts
  it('prefers the LAST meal keyword by position (multi-meal caption)', () => {
    // "achei que era almoço, mas é lanche" → snack (último vence)
    expect(detectExplicitMealType('achei que era almoço, mas é lanche')).toBe('snack')
    // ordem inversa
    expect(detectExplicitMealType('era lanche, na verdade jantar')).toBe('dinner')
  })
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/utils/meal-time.test.ts`. Expected: FAIL — implementação atual retorna o PRIMEIRO keyword pela ordem de `MEAL_KEYWORDS` (lunch), não o último por posição.

- [ ] **Step 3: Write minimal implementation** — reescreva `detectExplicitMealType` (a versão da Task 2) para varrer todas as keywords não-negadas e escolher a de MAIOR índice:
```ts
export function detectExplicitMealType(caption?: string | null): MealType | null {
  if (!caption) return null
  const tokens = tokenize(caption)
  if (tokens.length === 0) return null

  let bestIdx = -1
  let bestType: MealType | null = null

  for (const { phrases, mealType } of MEAL_KEYWORDS) {
    for (const phrase of phrases) {
      const phraseTokens = phrase.split(' ')
      // Scan every occurrence; keep the last non-negated one across all keywords.
      let from = 0
      while (from <= tokens.length - phraseTokens.length) {
        const rest = tokens.slice(from)
        const rel = findPhraseIndex(rest, phraseTokens)
        if (rel === -1) break
        const idx = from + rel
        if (!isNegatedAt(tokens, idx) && idx > bestIdx) {
          bestIdx = idx
          bestType = mealType
        }
        from = idx + 1
      }
    }
  }
  return bestType
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/utils/meal-time.test.ts`. Expected: PASS. (Casos single-keyword antigos seguem passando: só há um índice.)

- [ ] **Step 5: Commit** — `git add src/lib/utils/meal-time.ts tests/unit/utils/meal-time.test.ts && git commit -m "feat(meal-time): multi-refeição usa o último meal keyword por posição"`

---

### Task 4: `resolveMealTypeWithContinuation` (orquestrador puro)

**Files:** Modify `src/lib/utils/meal-time.ts` (após `resolveMealTypeFromContext`, ~linha 90) / Test `tests/unit/utils/meal-time.test.ts`

Janela de continuação: **90 minutos** (default best-practice). Compara `now` contra `recentMeal.registeredAt`, e exige mesmo dia local não é checado aqui (a janela de 90 min e o TTL de 5 min do state já garantem proximidade; o "mesmo dia" é coberto na prática pela janela curta). A função recebe `now` e `recentMeal` para ser determinística nos testes.

- [ ] **Step 1: Write the failing test** — adicione ao final de `tests/unit/utils/meal-time.test.ts`:
```ts
import {
  resolveMealTypeWithContinuation,
  type RecentMealRef,
} from '@/lib/utils/meal-time'

describe('resolveMealTypeWithContinuation', () => {
  const breakfastAt8 = new Date('2026-05-31T11:00:00Z') // 08:00 America/Sao_Paulo
  const recentBreakfast: RecentMealRef = { mealType: 'breakfast', registeredAt: breakfastAt8.toISOString() }

  it('inherits recent meal type on continuation within window (café da manhã → também → breakfast)', () => {
    // 30 min depois, "comi também um pão", horário daria snack se classificasse por hora
    expect(
      resolveMealTypeWithContinuation({
        message: 'comi também um pão',
        currentTime: '15:30',           // horário cairia em snack
        baseMealType: 'snack',          // o que o LLM/horário classificaria
        recentMeal: recentBreakfast,
        now: new Date('2026-05-31T11:30:00Z'),
      }),
    ).toBe('breakfast')
  })

  it('does NOT inherit when there is no continuation marker', () => {
    expect(
      resolveMealTypeWithContinuation({
        message: 'comi um pão',
        currentTime: '15:30',
        baseMealType: 'snack',
        recentMeal: recentBreakfast,
        now: new Date('2026-05-31T11:30:00Z'),
      }),
    ).toBe('snack')
  })

  it('does NOT inherit when outside the 90-min window', () => {
    expect(
      resolveMealTypeWithContinuation({
        message: 'comi também um pão',
        currentTime: '15:30',
        baseMealType: 'snack',
        recentMeal: recentBreakfast,
        now: new Date('2026-05-31T13:00:00Z'), // 120 min depois do café
      }),
    ).toBe('snack')
  })

  it('explicit meal type in the message wins over inheritance', () => {
    expect(
      resolveMealTypeWithContinuation({
        message: 'também jantei arroz',  // "jantei" explícito
        currentTime: '15:30',
        baseMealType: 'snack',
        recentMeal: recentBreakfast,
        now: new Date('2026-05-31T11:30:00Z'),
      }),
    ).toBe('dinner')
  })

  it('returns baseMealType when there is no recent meal', () => {
    expect(
      resolveMealTypeWithContinuation({
        message: 'comi também um pão',
        currentTime: '15:30',
        baseMealType: 'snack',
        recentMeal: null,
        now: new Date('2026-05-31T11:30:00Z'),
      }),
    ).toBe('snack')
  })

  it('ignores recent meal with unparseable registeredAt', () => {
    expect(
      resolveMealTypeWithContinuation({
        message: 'comi também um pão',
        currentTime: '15:30',
        baseMealType: 'snack',
        recentMeal: { mealType: 'breakfast', registeredAt: 'not-a-date' },
        now: new Date('2026-05-31T11:30:00Z'),
      }),
    ).toBe('snack')
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/utils/meal-time.test.ts`. Expected: FAIL — `resolveMealTypeWithContinuation`/`RecentMealRef` não existem.

- [ ] **Step 3: Write minimal implementation** — em `src/lib/utils/meal-time.ts`, após `resolveMealTypeFromContext` (linha 90), adicione:
```ts
export interface RecentMealRef {
  mealType: MealType
  /** ISO timestamp of when the recent meal was registered. */
  registeredAt: string
}

/** Continuation window: how long after the recent meal a "também/mais" keeps it. */
export const CONTINUATION_WINDOW_MS = 90 * 60 * 1000

/**
 * Decides the meal_type for a follow-up message. If the message has a continuation
 * marker ("também"/"mais"/…), there's NO explicit meal type, and a recent meal exists
 * within CONTINUATION_WINDOW_MS, inherit the recent meal's type. Otherwise return
 * baseMealType (what the LLM/time-of-day would have chosen).
 *
 * `now` and `recentMeal` are injected for deterministic testing.
 */
export function resolveMealTypeWithContinuation(params: {
  message?: string | null
  currentTime: string
  baseMealType: MealType
  recentMeal: RecentMealRef | null
  now: Date
}): MealType {
  const { message, baseMealType, recentMeal, now } = params

  // Explicit meal type always wins (e.g. "também jantei").
  if (detectExplicitMealType(message)) return baseMealType
  if (!recentMeal) return baseMealType
  if (!detectContinuationMarker(message)) return baseMealType

  const registeredAtMs = Date.parse(recentMeal.registeredAt)
  if (!Number.isFinite(registeredAtMs)) return baseMealType
  const elapsed = now.getTime() - registeredAtMs
  if (elapsed < 0 || elapsed > CONTINUATION_WINDOW_MS) return baseMealType

  return recentMeal.mealType
}
```
Nota: no caso "também jantei", `detectExplicitMealType` retorna `'dinner'` (truthy) → o ramo `return baseMealType` é tomado. Mas o teste espera `'dinner'`, não `baseMealType` (`'snack'`). Ajuste: quando há tipo explícito, retorne-o, não o base:
```ts
  // Explicit meal type always wins (e.g. "também jantei").
  const explicit = detectExplicitMealType(message)
  if (explicit) return explicit
```
(Substitua a linha `if (detectExplicitMealType(message)) return baseMealType` por essas duas.)

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/utils/meal-time.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/utils/meal-time.ts tests/unit/utils/meal-time.test.ts && git commit -m "feat(meal-time): resolveMealTypeWithContinuation (janela 90min, marcador, explícito vence)"`

---

### Task 5: `setRecentMealState` grava `registeredAt`

**Files:** Modify `src/lib/bot/meal-response.ts` (`setRecentMealState`, linhas 6-19) / Test `tests/unit/bot/meal-response.test.ts`

O `recent_meal` state hoje guarda `mealId`, `mealType`, `items` — falta o timestamp para a janela de continuação. `MealWithItems.registeredAt` é uma string ISO (`src/lib/db/queries/meals.ts:310`). Vamos gravá-lo.

- [ ] **Step 1: Write the failing test** — verifique o arquivo de teste existente e adicione (se o arquivo não existir, crie-o seguindo o padrão de mocks abaixo). Em `tests/unit/bot/meal-response.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSetState, mockClearState } = vi.hoisted(() => ({
  mockSetState: vi.fn().mockResolvedValue(undefined),
  mockClearState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: mockClearState,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatMealAddition: vi.fn(),
  formatMealBreakdown: vi.fn(),
}))

import { setRecentMealState } from '@/lib/bot/meal-response'

describe('setRecentMealState', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stores registeredAt alongside mealId/mealType/items', async () => {
    const meal = {
      id: 'meal-1',
      mealType: 'breakfast',
      totalCalories: 300,
      registeredAt: '2026-05-31T11:00:00Z',
      items: [
        { id: 'i1', foodName: 'Pão', quantityGrams: 50, quantityDisplay: '1 unidade',
          calories: 140, proteinG: 4, carbsG: 28, fatG: 1 },
      ],
    } as Parameters<typeof setRecentMealState>[1]

    await setRecentMealState('user-1', meal)

    expect(mockSetState).toHaveBeenCalledWith('user-1', 'recent_meal', expect.objectContaining({
      mealId: 'meal-1',
      mealType: 'breakfast',
      registeredAt: '2026-05-31T11:00:00Z',
    }))
  })

  it('clears state when meal has no items', async () => {
    const meal = { id: 'm', mealType: 'lunch', totalCalories: 0, registeredAt: '2026-05-31T11:00:00Z', items: [] } as Parameters<typeof setRecentMealState>[1]
    await setRecentMealState('user-1', meal)
    expect(mockClearState).toHaveBeenCalledWith('user-1')
    expect(mockSetState).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/bot/meal-response.test.ts`. Expected: FAIL — o objeto passado a `setState` não contém `registeredAt`.

- [ ] **Step 3: Write minimal implementation** — em `src/lib/bot/meal-response.ts`, edite `setRecentMealState` (linhas 11-18) para incluir `registeredAt`:
```ts
  await setState(userId, 'recent_meal', {
    mealId: meal.id,
    mealType: meal.mealType,
    registeredAt: meal.registeredAt,
    items: meal.items.map(i => ({
      id: i.id, foodName: i.foodName, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay,
      calories: i.calories, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG,
    })),
  })
```
Confirme que `LogFoodResult['meal']` (= `MealWithItems`) expõe `registeredAt: string` (já confirmado em `src/lib/db/queries/meals.ts:310`).

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/bot/meal-response.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/bot/meal-response.ts tests/unit/bot/meal-response.test.ts && git commit -m "feat(meal-response): grava registeredAt no recent_meal state"`

---

### Task 6: Propagar `recentMeal` por `handleMealLog` e aplicar continuação no texto

**Files:** Modify `src/lib/bot/flows/meal-log.ts` (`handleMealLog` ~697-736; `analyzeAndRegister` ~1304-1364) / Test `tests/unit/bot/meal-log.test.ts`

Estratégia: `handleMealLog` ganha um parâmetro opcional `recentMeal?: RecentMealRef`. Ele é repassado a `analyzeAndRegister`, que — para mensagem de UMA refeição não-backdatada — aplica `resolveMealTypeWithContinuation` sobre `meals[0].meal_type`. Quando o tipo muda, sobrescreve `meals[0].meal_type` ANTES de `saveMeals`, de modo que `logFoodToMeal` consolide na refeição certa (find-or-create por user+meal_type+dia já junta com a refeição existente).

- [ ] **Step 1: Write the failing test** — leia o topo de `tests/unit/bot/meal-log.test.ts` para reusar os mocks existentes (LLM, queries). Adicione um teste que injeta `recentMeal` e um marcador de continuação e verifica que `logFoodToMeal` é chamado com `mealType: 'breakfast'` mesmo que o LLM tenha devolvido `snack`:
```ts
// (no topo do arquivo, garanta que getRecentMessages, parseDateFromMessage etc já estão mockados
//  como nos testes existentes; reuse o mock de analyzeMeal e o spy de logFoodToMeal/saveMeals)

describe('handleMealLog — continuation', () => {
  it('inherits recent meal type when message has "também" within window', async () => {
    // LLM classifies the follow-up as snack (afternoon), but recent meal is breakfast.
    mockAnalyzeMeal.mockResolvedValue([{
      meal_type: 'snack',
      confidence: 'high',
      references_previous: false,
      reference_query: null,
      items: [{ food: 'Pão', quantity_grams: 50, portion_type: 'unit', has_user_quantity: false,
        quantity_display: '1 unidade', quantity_source: 'estimated', calories: null, protein: null,
        carbs: null, fat: null, confidence: 'high' }],
      unknown_items: [],
      needs_clarification: false,
    }])

    vi.setSystemTime(new Date('2026-05-31T11:30:00Z')) // 30 min após o café

    await handleMealLog(
      mockSupabase,
      'user-1',
      'comi também um pão',
      { calorieMode: 'fixed', dailyCalorieTarget: 2000, timezone: 'America/Sao_Paulo' },
      null,
      { mealType: 'breakfast', registeredAt: '2026-05-31T11:00:00Z' }, // recentMeal
    )

    // logFoodToMeal (via saveMeals) deve receber breakfast, não snack
    expect(mockLogFoodToMeal).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({ mealType: 'breakfast' }),
    )
  })
})
```
Nota: adapte os nomes dos mocks (`mockAnalyzeMeal`, `mockLogFoodToMeal`, `mockSupabase`) aos já existentes no arquivo; se `logFoodToMeal` não for mockável por ser interno, faça o assert sobre o `findOrCreateMeal` mock (que recebe `mealType`). Use `vi.useFakeTimers()` no `beforeEach` e `vi.useRealTimers()` no `afterEach` deste describe.

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/bot/meal-log.test.ts`. Expected: FAIL — `handleMealLog` ignora o 6º argumento; o meal é salvo como `snack`.

- [ ] **Step 3: Write minimal implementation** — em `src/lib/bot/flows/meal-log.ts`:

(a) importe os helpers no topo (junte ao import existente da linha 15):
```ts
import { getUserLocalTime, detectExplicitMealType, resolveMealTypeWithContinuation, type RecentMealRef } from '@/lib/utils/meal-time'
```

(b) altere a assinatura de `handleMealLog` (linha 697) para aceitar `recentMeal`:
```ts
export async function handleMealLog(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    phone?: string
    timezone?: string
  },
  context: ConversationContext | null,
  recentMeal?: RecentMealRef | null,
): Promise<MealLogResult> {
```
e repasse `recentMeal` nas duas chamadas a `analyzeAndRegister` (linhas 732 e 735):
```ts
    return analyzeAndRegister(supabase, userId, combined, trimmed, user, recentMeal)
  }

  return analyzeAndRegister(supabase, userId, trimmed, trimmed, user, recentMeal)
```

(c) altere a assinatura de `analyzeAndRegister` (linha 1304) acrescentando `recentMeal`:
```ts
async function analyzeAndRegister(
  supabase: SupabaseClient,
  userId: string,
  messageToAnalyze: string,
  originalMessage: string,
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    phone?: string
    timezone?: string
  },
  recentMeal?: RecentMealRef | null,
): Promise<MealLogResult> {
```

(d) logo após o bloco de backdate-ask (após a linha 1364, antes de "Check for history references"), aplique a continuação para a refeição única não-backdatada:
```ts
  // Continuation: a single, same-day follow-up with a marker ("também"/"mais"…) inherits
  // the recent meal's type instead of the LLM/time classification, so it consolidates into
  // the meal the user just logged. Backdated logs and multi-meal messages are excluded.
  if (meals.length === 1 && !dateWasBackdated && recentMeal) {
    const inherited = resolveMealTypeWithContinuation({
      message: originalMessage,
      currentTime,
      baseMealType: meals[0].meal_type,
      recentMeal,
      now: new Date(),
    })
    meals[0].meal_type = inherited
  }
```
(`dateWasBackdated`, `currentTime` e `explicitMealType` já existem nesse escopo; `resolveMealTypeWithContinuation` re-checa explícito internamente, então é seguro.)

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/bot/meal-log.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/bot/flows/meal-log.ts tests/unit/bot/meal-log.test.ts && git commit -m "feat(meal-log): herda meal_type do recent_meal em continuação no texto"`

---

### Task 7: Handler de TEXTO repassa o `recent_meal` ao `handleMealLog`

**Files:** Modify `src/lib/bot/handler.ts` (bloco `recent_meal` ~290-363 e chamadas a `handleMealLog`) / sem teste novo dedicado (coberto por meal-log.test.ts + smoke do handler existente)

Hoje, "comi também X" após uma refeição cai no gatekeeper do `recent_meal`; quando classificado como `other`, o handler `clearState` (linha 361) e segue para classificação de intent → `meal_log` com `context = null` (linha 625), perdendo o recent_meal. Solução: capturar um `RecentMealRef` a partir do `context.contextData` ANTES de limpar, e passá-lo adiante.

- [ ] **Step 1: Write the failing test** — (opcional, smoke) se houver `tests/unit/bot/handler.test.ts` cobrindo o caminho de texto, adicione um caso garantindo que `handleMealLog` é chamado com o 6º argumento `{ mealType, registeredAt }` quando havia `recent_meal`. Caso o handler.test.ts não tenha infra para esse caminho, marque este step como N/A e confie na cobertura da Task 6. Run de verificação será o build/lint.

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/bot/handler.test.ts` (se aplicável). Expected: FAIL (6º arg ausente) ou N/A.

- [ ] **Step 3: Write minimal implementation** — em `src/lib/bot/handler.ts`:

(a) No início do `case 'recent_meal':` (após linha 294), capture um ref reutilizável:
```ts
          const recentMealType = context.contextData.mealType as MealType | undefined
          const recentRegisteredAt = context.contextData.registeredAt as string | undefined
          const recentMealRef: RecentMealRef | null =
            recentMealType && recentRegisteredAt
              ? { mealType: recentMealType, registeredAt: recentRegisteredAt }
              : null
```
(Importe os tipos no topo, junto do import da linha 41:)
```ts
import { getUserLocalTime, resolveMealTypeFromContext, detectExplicitMealType, resolveMealTypeWithContinuation, type RecentMealRef } from '@/lib/utils/meal-time'
import type { MealType } from '@/lib/utils/meal-time'
```

(b) No ramo `// "other" — clear state and continue` (linhas 360-362), em vez de só `clearState` + `break`, roteie diretamente o follow-up como meal_log COM o recentMealRef, evitando perder o contexto na re-classificação:
```ts
          // "other": likely a new/continued food log. Clear the recent_meal context but
          // keep a reference so a continuation marker ("também") can inherit its type.
          await clearState(user.id)
          if (isLikelyMealLog(text)) {
            const contResult = await handleMealLog(supabase, user.id, text, userSettings, null, recentMealRef)
            if (contResult.completed && contResult.mealId) {
              const contSentId = await sendTextMessage(from, contResult.response)
              saveHistory(supabase, user.id, text, contResult.response)
              await saveBotMessages(supabase, user.id, messageId, contSentId, 'meal', contResult.mealId)
              return
            }
            const contSentId = await sendTextMessage(from, contResult.response)
            saveHistory(supabase, user.id, text, contResult.response)
            await saveBotMessages(supabase, user.id, messageId, contSentId, null, null)
            return
          }
          break
```
Onde `isLikelyMealLog` é um guard leve. Se o repo já tem um classificador de intent rule-based exportável, reuse-o; caso contrário, defina no topo do handler um helper mínimo que detecta marcador de continuação OU verbos de ingestão:
```ts
function isLikelyMealLog(text: string): boolean {
  return detectContinuationMarker(text) || /\b(comi|comendo|tomei|bebi|lanchei|jantei|almocei)\b/i.test(text)
}
```
(Importe `detectContinuationMarker` do meal-time no mesmo import.) **Best-practice / alternativa documentada:** o ideal seria reusar o `classifyIntent` existente; manter `isLikelyMealLog` é o caminho conservador para não regressar outros intents. Se a classificação de intent já roda logo após o `break`, uma alternativa mais simples é NÃO interceptar aqui e apenas guardar `recentMealRef` numa variável de escopo externo, repassando-a na chamada de `handleMealLog` do `case 'meal_log'` (linha 625). Escolha esta alternativa se o handler.test.ts cobrir melhor o caminho via intent. Para o plano, adote a interceptação direta acima (determinística e testável via meal-log.test.ts).

(c) Garanta que as outras chamadas de `handleMealLog` que já recebem um `context` (linhas 379, 388, 397) continuam funcionando — elas não passam `recentMeal` (param opcional, default `undefined`), então nenhuma mudança é necessária ali.

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/bot/handler.test.ts && npx vitest run tests/unit/bot/meal-log.test.ts`. Expected: PASS. Rode também o build de tipos: `npm run build` não é necessário aqui; use `npx tsc --noEmit` se quiser checagem rápida de tipos.

- [ ] **Step 5: Commit** — `git add src/lib/bot/handler.ts && git commit -m "feat(handler): texto repassa recent_meal para continuação no meal_log"`

---

### Task 8: Fluxo de IMAGEM lê `getState`, usa vision meal_type primário e aplica continuação

**Files:** Modify `src/lib/bot/handler.ts` (`handleIncomingImage` ~771-963) / Test `tests/unit/bot/handler.test.ts` (se houver caminho de imagem) ou cobertura manual

Hoje (linha 837) o meal_type vem só de `resolveMealTypeFromContext({caption, currentTime})`, descartando o `imageResult.meal_type` do vision (calculado mas ignorado), e `handleIncomingImage` nunca chama `getState`. Mudanças:
1. Ler `getState(user.id)` e extrair um `RecentMealRef` se houver `recent_meal`.
2. `baseMealType = detectExplicitMealType(caption) ?? imageResult.meal_type ?? classifyMealTypeByTime(currentTime)` (vision como primário, caption explícito ainda vence, horário fallback).
3. Aplicar `resolveMealTypeWithContinuation` com o caption como `message`.

- [ ] **Step 1: Write the failing test** — se `tests/unit/bot/handler.test.ts` tem infra para `handleIncomingImage` (mock de `analyzeImage`, `getState`, `logFoodToMeal`), adicione:
```ts
it('image continuation: "também" caption after recent breakfast inherits breakfast', async () => {
  mockGetState.mockResolvedValue({
    contextType: 'recent_meal',
    contextData: { mealType: 'breakfast', registeredAt: '2026-05-31T11:00:00Z', items: [{}] },
    createdAt: '2026-05-31T11:00:00Z',
  })
  mockAnalyzeImage.mockResolvedValue({
    image_type: 'food',
    meal_type: 'snack',
    confidence: 'high',
    items: [{ food: 'Pão', quantity_grams: 50, calories: 140, protein: 4, carbs: 28, fat: 1, confidence: 'high', quantity_source: 'estimated' }],
    unknown_items: [], needs_clarification: false,
  })
  vi.setSystemTime(new Date('2026-05-31T11:30:00Z'))

  await handleIncomingImage('5511999', 'msg-1', 'img-1', 'comi também')

  expect(mockLogFoodToMeal).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ mealType: 'breakfast' }),
  )
})
```
Adapte aos mocks reais do arquivo. Se não houver infra, marque N/A e cubra a lógica via uma extração da função pura já testada na Task 4 (a wiring é simples).

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/bot/handler.test.ts`. Expected: FAIL — meal salvo como `snack` (vision/horário), `getState` não consultado no fluxo de imagem.

- [ ] **Step 3: Write minimal implementation** — em `src/lib/bot/handler.ts`, dentro de `handleIncomingImage`:

(a) importe `classifyMealTypeByTime` no import de meal-time (Task 7 já adicionou os outros):
```ts
import { getUserLocalTime, resolveMealTypeFromContext, detectExplicitMealType, resolveMealTypeWithContinuation, classifyMealTypeByTime, type RecentMealRef } from '@/lib/utils/meal-time'
```

(b) substitua a linha 837 (`const resolvedMealType = resolveMealTypeFromContext({ caption, currentTime })`) por:
```ts
    // vision meal_type is the primary signal (parity with text trusting the LLM); an
    // explicit caption keyword still wins; time-of-day is the last fallback.
    const baseMealType =
      detectExplicitMealType(caption) ?? imageResult.meal_type ?? classifyMealTypeByTime(currentTime)

    // Continuation: read recent_meal so a "também" caption right after a logged meal
    // keeps that meal's type instead of opening a new one.
    const imgContext = await getState(user.id)
    const imgRecentMeal: RecentMealRef | null =
      imgContext?.contextType === 'recent_meal' &&
      typeof imgContext.contextData.mealType === 'string' &&
      typeof imgContext.contextData.registeredAt === 'string'
        ? {
            mealType: imgContext.contextData.mealType as MealType,
            registeredAt: imgContext.contextData.registeredAt as string,
          }
        : null

    const resolvedMealType = resolveMealTypeWithContinuation({
      message: caption,
      currentTime,
      baseMealType,
      recentMeal: imgRecentMeal,
      now: new Date(),
    })
```
O resto do fluxo (linha 839+ monta `mealAnalysis` com `meal_type: resolvedMealType`) permanece igual. O `backdated`-ask (linha 915) usa `detectExplicitMealType(originalMessage)` e não é afetado: continuação só aplica para o mesmo dia (janela 90 min ≪ backdate), e backdated photos já têm seu próprio ramo.

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/bot/handler.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts && git commit -m "feat(handler): imagem usa vision meal_type primário + continuação via recent_meal"`

---

### Task 9: Centralizar `parseMealType` (meal-detail) na tokenização de meal-time

**Files:** Modify `src/lib/utils/meal-time.ts` (nova export `detectExplicitMealTypeLenient`), `src/lib/bot/flows/meal-detail.ts` (`parseMealType` 34-45, `MEAL_TYPE_MAP` 26-32) / Test `tests/unit/bot/meal-detail.test.ts`

O `parseMealType` atual usa `includes()` por substring (frágil: casaria "almoçado"). Centralizamos: criamos `detectExplicitMealTypeLenient` em meal-time que é igual ao `detectExplicitMealType` mas com "cafe" bare → breakfast (exigido pelo fluxo `awaiting_meal_type`, onde o usuário responde "café"). `parseMealType` passa a delegar.

- [ ] **Step 1: Write the failing test** — os testes existentes em `tests/unit/bot/meal-detail.test.ts` (linhas 39-87) já cobrem o contrato. Adicione um caso que trava o anti-substring:
```ts
  it('does not parse "almoçado" as lunch (token-based, not substring)', () => {
    expect(parseMealType('comida já almoçada ontem')).toBeNull()
  })
```
Mantenha todos os casos atuais — em especial `parseMealType('o que comi no cafe?')` → `'breakfast'` (linha 44-46) e `parseMealType('de manha comi muito')` → `null` (linha 84-86).

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/bot/meal-detail.test.ts`. Expected: FAIL — `parseMealType('comida já almoçada ontem')` retorna `'lunch'` (substring `almoco`? não — mas `almoçada` normaliza para `almocada`, que NÃO contém `almoco`; verifique). Se já passar, este step apenas confirma o comportamento e o objetivo passa a ser a centralização. Caso passe, adicione um caso que falha hoje: `expect(parseMealType('na lanchonete')).toBeNull()` — `includes('lanche')` casa "lanchonete" → hoje retorna `'snack'` (FAIL esperado).

- [ ] **Step 3: Write minimal implementation** —

(a) em `src/lib/utils/meal-time.ts`, adicione (após `detectExplicitMealType`):
```ts
// Lenient variant for REPLY contexts (e.g. user answering "qual refeição?"): a bare
// "café" resolves to breakfast here, unlike the strict detector which keeps it ambiguous.
const MEAL_KEYWORDS_LENIENT: Array<{ phrases: string[]; mealType: MealType }> = [
  { phrases: ['cafe da manha', 'desjejum', 'cafe'], mealType: 'breakfast' },
  { phrases: ['almoco', 'almocei', 'almocar'], mealType: 'lunch' },
  { phrases: ['lanche da tarde', 'lanche da manha', 'lanche', 'lanchei'], mealType: 'snack' },
  { phrases: ['jantar', 'janta', 'jantei'], mealType: 'dinner' },
  { phrases: ['ceia', 'ceando'], mealType: 'supper' },
]

export function detectExplicitMealTypeLenient(caption?: string | null): MealType | null {
  if (!caption) return null
  const tokens = tokenize(caption)
  if (tokens.length === 0) return null
  let bestIdx = -1
  let bestType: MealType | null = null
  for (const { phrases, mealType } of MEAL_KEYWORDS_LENIENT) {
    for (const phrase of phrases) {
      const phraseTokens = phrase.split(' ')
      let from = 0
      while (from <= tokens.length - phraseTokens.length) {
        const rel = findPhraseIndex(tokens.slice(from), phraseTokens)
        if (rel === -1) break
        const idx = from + rel
        if (!isNegatedAt(tokens, idx) && idx > bestIdx) {
          bestIdx = idx
          bestType = mealType
        }
        from = idx + 1
      }
    }
  }
  return bestType
}
```

(b) em `src/lib/bot/flows/meal-detail.ts`, remova `MEAL_TYPE_MAP` (linhas 26-32) e reescreva `parseMealType` (34-45) para delegar; ajuste o tipo de retorno para `MealType | null` (o consumidor `handleAwaitingMealType` espera string):
```ts
import { detectExplicitMealTypeLenient } from '@/lib/utils/meal-time'

export function parseMealType(message: string): string | null {
  return detectExplicitMealTypeLenient(message)
}
```
(Mantenha a função `normalize` se ainda for usada por `hasTemporalHints`; ela não é mais usada por `parseMealType`.)

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/bot/meal-detail.test.ts tests/unit/utils/meal-time.test.ts`. Expected: PASS (inclui `cafe` bare → breakfast, `de manha` → null, anti-substring `lanchonete`/`almoçada` → null).

- [ ] **Step 5: Commit** — `git add src/lib/utils/meal-time.ts src/lib/bot/flows/meal-detail.ts tests/unit/bot/meal-detail.test.ts && git commit -m "refactor(meal-detail): parseMealType delega à tokenização de meal-time (anti-substring)"`

---

### Task 10: Atualizar prompts de texto/imagem para sinalizar continuação ao LLM (defensivo)

**Files:** Modify `src/lib/llm/prompts/analyze.ts` (~76-81) e `src/lib/llm/prompts/vision.ts` (~5-13) / sem teste (prompts são texto)

Reforço de defesa-em-profundidade: deixar o LLM ciente de que "também/mais" não inventa nova refeição. A lógica determinística das Tasks 4/6/8 é a fonte de verdade; isto só melhora o sinal `meal_type` retornado pelo LLM.

- [ ] **Step 1: (sem teste)** — prompts não têm teste unitário; o gate é `npm run lint` + revisão.

- [ ] **Step 2: N/A**

- [ ] **Step 3: Write implementation** — em `src/lib/llm/prompts/analyze.ts`, dentro de `timeInstruction`, após a linha 12 (antes do fechamento do template), acrescente:
```ts
- CONTINUAÇÃO: se a mensagem usar "também", "mais", "ainda" logo após o usuário ter registrado algo, ela provavelmente continua a MESMA refeição anterior. Não troque o meal_type por horário nesse caso; se não houver tipo explícito, mantenha o tipo mais coerente com uma continuação.
```
Em `src/lib/llm/prompts/vision.ts`, dentro de `timeInstruction`, após a linha 12, acrescente a mesma orientação adaptada à legenda:
```ts
- CONTINUAÇÃO: se a legenda usar "também"/"mais"/"ainda", trate como continuação da refeição anterior do usuário; não reclassifique por horário se não houver tipo explícito.
```

- [ ] **Step 4: Run lint** — Run: `npm run lint`. Expected: sem erros nos arquivos de prompt.

- [ ] **Step 5: Commit** — `git add src/lib/llm/prompts/analyze.ts src/lib/llm/prompts/vision.ts && git commit -m "feat(prompts): sinaliza continuação (também/mais) ao LLM de texto e visão"`

---

## Verificação final

- [ ] **Suite completa:** `npm test` — todos os testes verdes. Atenção especial a `tests/unit/utils/meal-time.test.ts`, `tests/unit/bot/meal-response.test.ts`, `tests/unit/bot/meal-log.test.ts`, `tests/unit/bot/meal-detail.test.ts`, `tests/unit/bot/handler.test.ts`.
- [ ] **Lint:** `npm run lint` — zero erros.
- [ ] **Tipos:** `npx tsc --noEmit` — sem erros (assinaturas novas de `handleMealLog` e `RecentMealRef` propagadas).
- [ ] **Smoke do cenário-chave (manual ou via teste da Task 6):** café da manhã registrado às 08:00 → "comi também um pão" às 08:30 → deve consolidar em `breakfast`, não abrir `snack`.