# Macro Display Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a linha de macros "P:/G:/C:" aparecer de forma consistente em TODOS os fluxos de registro (texto, foto, rótulo, produto, consulta→registrar, quantidades em lote, edição/correção), não só no registro por texto.

**Architecture:** Hoje a linha de macros só sai quando o call site passa o arg `macros` para `formatProgress`/`formatMealBreakdown`. Só o caminho de texto (`meal-log.ts`) e o resumo diário (`summary.ts`) fazem isso, via o helper privado `buildMacrosBlock` (meal-log.ts:167-182). Vamos (1) extrair `buildMacrosBlock` para um util compartilhado `src/lib/bot/macros.ts`, (2) normalizar a ordem invertida de args entre `formatMealBreakdown` e `formatMealAddition`, e (3) fazer cada fluxo restante carregar `getDailyMacros` (já existe em meals.ts:250) + montar o bloco de macros com o helper compartilhado e passá-lo adiante. Por fim, unificamos o gate (`!= null` em vez de truthiness) e a ordem P/G/C no preview do rótulo.

**Tech Stack:** TypeScript strict, Next.js, Supabase (PostgREST), Vitest. `decToNum` (WS1, db/utils.ts:30) já é usado dentro de `getDailyMacros`.

---

## Decisões de produto (defaults escolhidos)

| Decisão | Default best-practice adotado | Alternativa (ajuste possível) |
| --- | --- | --- |
| Onde colocar o helper compartilhado de macros | Novo módulo `src/lib/bot/macros.ts` exportando `buildMacrosBlock` + tipo `MacrosBlock`. Evita ciclos de import entre `meal-log.ts` (define `EnrichedItem`) e os consumidores. | Colocar em `formatters.ts`. Rejeitado: borra a fronteira entre formatação pura e regra de gate que conhece o shape do User. |
| Ordem de args invertida `formatMealBreakdown` vs `formatMealAddition` | Igualar `formatMealAddition` à ordem de `formatMealBreakdown`: `(...,macros?,dateLabel?)`. Alinha com os 4 formatters que já usam essa ordem. | Migrar todos para objeto de opções `{ macros?, dateLabel? }`. Mais limpo mas toca ~6 funções de uma vez; follow-up. |
| Gate que decide exibir macro (`&&` vs `!= null`) | Adotar `!= null` no helper compartilhado. Preserva meta legítima de 0g (ex.: keto). `summary.ts` já usa esse critério. | Manter truthiness `&&`. Rejeitado: esconde a linha para metas válidas de zero. |
| Ordem dos macros no preview do rótulo (P/C/G vs P/G/C) | Padronizar **P/G/C** em todo o app, corrigindo só o preview do rótulo (handler.ts:893). É a ordem de `formatProgress`/`formatDailySummary`. | Padronizar tudo em P/C/G. Rejeitado: mudaria os formatters mais usados e já testados. |
| Propagar os 3 campos de macro do user p/ rótulo, produto, edição | Adicionar `dailyProteinG/dailyFatG/dailyCarbsG (number\|null)` aos tipos `user` dessas funções; handler já carrega esses campos. `getDailyMacros` substitui `getDailyCalories`. | Re-buscar a meta no DB dentro de cada fluxo. Rejeitado: I/O desnecessário; o handler já tem os dados. |

## File Structure

```
src/lib/bot/macros.ts            (CRIAR) — buildMacrosBlock + tipo MacrosBlock compartilhados
src/lib/utils/formatters.ts      (MODIFICAR) — normalizar ordem de args de formatMealAddition (~90-131)
src/lib/bot/meal-response.ts     (MODIFICAR) — ajustar call site de formatMealAddition (~38-40)
src/lib/bot/flows/meal-log.ts    (MODIFICAR) — remover buildMacrosBlock local, importar do macros.ts; bloco macros no lote (~1090-1298)
src/lib/bot/flows/query.ts       (MODIFICAR) — registerQueryItems recebe macros (~16-62)
src/lib/bot/flows/edit.ts        (MODIFICAR) — 9 saídas com getDailyMacros + macros (~22, 268, 408-415, 432-434, 445-447, 511-513, 572-581, 627-629, 668-670)
src/lib/bot/handler.ts           (MODIFICAR) — foto (~957-959), rótulo (~972-979, 1043-1045), produto (~188-235), edit call sites, preview rótulo (~893)

tests/unit/bot/macros.test.ts            (CRIAR)
tests/unit/utils/format-meal-addition.test.ts (MODIFICAR) — atualizar p/ nova ordem + caso macros
tests/unit/bot/query.test.ts             (MODIFICAR) — assert macro line
tests/unit/bot/edit.test.ts              (MODIFICAR) — assert macro line
tests/unit/bot/handler.test.ts           (MODIFICAR) — assert macro line nos fluxos foto/produto/rótulo
```

---

### Task 1: Extrair `buildMacrosBlock` para um util compartilhado com gate unificado

Hoje `buildMacrosBlock` é uma função privada em `meal-log.ts:167-182` e usa o gate truthiness `user.dailyProteinG && user.dailyFatG && user.dailyCarbsG`. Vamos movê-la para `src/lib/bot/macros.ts`, exportá-la, exportar o tipo `MacrosBlock` e trocar o gate por `!= null` (alinhando com `summary.ts:119-122`).

**Files:** Create `src/lib/bot/macros.ts`; Create `tests/unit/bot/macros.test.ts`; Modify `src/lib/bot/flows/meal-log.ts` (remover def. local ~167-182, importar do novo módulo)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/bot/macros.test.ts
import { describe, it, expect } from 'vitest'
import { buildMacrosBlock } from '@/lib/bot/macros'

const DAILY = { proteinG: 50, fatG: 20, carbsG: 100 }

describe('buildMacrosBlock', () => {
  it('returns the calorie target and a macros block when all 3 macro goals are set', () => {
    const { target, macros } = buildMacrosBlock(
      { dailyCalorieTarget: 1800, dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200 },
      DAILY,
    )
    expect(target).toBe(1800)
    expect(macros).toEqual({
      consumed: { proteinG: 50, fatG: 20, carbsG: 100 },
      target: { proteinG: 120, fatG: 60, carbsG: 200 },
    })
  })

  it('falls back to 2000 kcal when dailyCalorieTarget is null', () => {
    const { target } = buildMacrosBlock(
      { dailyCalorieTarget: null, dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200 },
      DAILY,
    )
    expect(target).toBe(2000)
  })

  it('returns macros=undefined when any macro goal is missing (null)', () => {
    const { macros } = buildMacrosBlock(
      { dailyCalorieTarget: 1800, dailyProteinG: 120, dailyFatG: null, dailyCarbsG: 200 },
      DAILY,
    )
    expect(macros).toBeUndefined()
  })

  it('returns macros=undefined when goals are undefined (user without macros)', () => {
    const { macros } = buildMacrosBlock({ dailyCalorieTarget: 1800 }, DAILY)
    expect(macros).toBeUndefined()
  })

  it('keeps the macros block when a goal is a legitimate 0 (gate uses != null, not truthiness)', () => {
    const { macros } = buildMacrosBlock(
      { dailyCalorieTarget: 1800, dailyProteinG: 150, dailyFatG: 130, dailyCarbsG: 0 },
      DAILY,
    )
    expect(macros).toEqual({
      consumed: { proteinG: 50, fatG: 20, carbsG: 100 },
      target: { proteinG: 150, fatG: 130, carbsG: 0 },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/bot/macros.test.ts`
  - Expected: FAIL — `Failed to resolve import "@/lib/bot/macros"` (o módulo ainda não existe).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/bot/macros.ts
// Shared macro-display helper. Builds the calorie target + (optional) macro block
// passed to formatProgress / formatMealBreakdown so the "P:/G:/C:" line renders
// consistently across every flow.

export interface MacrosBlock {
  consumed: { proteinG: number; fatG: number; carbsG: number }
  target: { proteinG: number; fatG: number; carbsG: number }
}

/**
 * Given the user's daily macro goals and the macros consumed so far, returns:
 *  - target: the daily calorie target (2000 fallback)
 *  - macros: the block to feed into the formatters, or undefined when the user
 *    has no macro goals.
 *
 * Gate uses `!= null` (not truthiness) so a legitimate 0g goal (e.g. keto carbs)
 * still renders the macro line. Mirrors summary.ts.
 */
export function buildMacrosBlock(
  user: {
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
  },
  dailyMacros: { proteinG: number; fatG: number; carbsG: number },
): { target: number; macros: MacrosBlock | undefined } {
  const target = user.dailyCalorieTarget ?? 2000
  const hasGoals =
    user.dailyProteinG != null && user.dailyFatG != null && user.dailyCarbsG != null
  const macros: MacrosBlock | undefined = hasGoals
    ? {
        consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
        target: { proteinG: user.dailyProteinG!, fatG: user.dailyFatG!, carbsG: user.dailyCarbsG! },
      }
    : undefined
  return { target, macros }
}
```

Em `src/lib/bot/flows/meal-log.ts`, remover a função local `buildMacrosBlock` (linhas 167-182) e adicionar o import no topo (junto dos demais imports `@/lib/bot/...`, ex. após a linha 21):

```ts
import { buildMacrosBlock } from '@/lib/bot/macros'
```

(As 4 chamadas internas a `buildMacrosBlock(user, dailyMacros)` em meal-log.ts:933, 991, 1391, 1499 continuam funcionando sem alteração — agora resolvem o import.)

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/bot/macros.test.ts tests/unit/bot/meal-log.test.ts`
  - Expected: PASS — macros.test.ts verde e meal-log.test.ts segue verde (mesma assinatura/comportamento, só mudou de gate `&&`→`!= null`; os testes existentes usam metas não-zero, então não regridem).

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/bot/macros.ts tests/unit/bot/macros.test.ts src/lib/bot/flows/meal-log.ts && git commit -m "refactor(macros): extrai buildMacrosBlock para util compartilhado com gate != null"`

---

### Task 2: Normalizar a ordem de args de `formatMealAddition` para `(...,macros?,dateLabel?)`

`formatMealBreakdown` (formatters.ts:45-56) recebe `(..., macros?, dateLabel?)`, mas `formatMealAddition` (formatters.ts:90-101) recebe `(..., dateLabel?, macros?)` — ordem **invertida**. O único call site que passava ambos (meal-response.ts:39) compensa manualmente passando `(dateLabel, macros)`. Vamos inverter a assinatura de `formatMealAddition` para casar com `formatMealBreakdown` e corrigir o call site, ANTES de espalhar macros aos novos fluxos.

**Files:** Modify `src/lib/utils/formatters.ts` (formatMealAddition ~90-118); Modify `src/lib/bot/meal-response.ts` (~38-40); Modify `tests/unit/utils/format-meal-addition.test.ts`

- [ ] **Step 1: Write the failing test**

Reescrever os 2 primeiros casos de `format-meal-addition.test.ts` para a nova ordem e adicionar um caso de macros. Substituir o bloco `describe('formatMealAddition', ...)` (linhas 11-27) por:

```ts
describe('formatMealAddition', () => {
  it('frames as "Somei … ao …" and lists the full meal (macros before dateLabel)', () => {
    // New signature: (mealType, added, full, mealTotal, dailyConsumed, dailyTarget, macros?, dateLabel?)
    const msg = formatMealAddition('breakfast', ADDED, FULL, 292, 292, 2168, undefined, 'Hoje')
    expect(msg).toContain('Somei')
    expect(msg).toContain('Açaí')
    expect(msg).toContain('Café da manhã agora:')
    expect(msg).toContain('Ovo')
    expect(msg).toContain('Queijo mussarela')
    expect(msg).toContain('Total: 292 kcal')
    expect(msg).toContain('📊 Hoje: 292 / 2168 kcal')
  })

  it('uses the date label (now the 8th arg) for backdated additions', () => {
    const msg = formatMealAddition('dinner', ADDED, FULL, 292, 292, 2168, undefined, 'Ontem')
    expect(msg).toContain('📊 Ontem: 292 / 2168 kcal')
  })

  it('renders the macro line when macros are passed (7th arg)', () => {
    const macros = {
      consumed: { proteinG: 18, fatG: 12, carbsG: 30 },
      target: { proteinG: 144, fatG: 60, carbsG: 200 },
    }
    const msg = formatMealAddition('breakfast', ADDED, FULL, 292, 292, 2168, macros, 'Hoje')
    expect(msg).toContain('P: 18/144g')
    expect(msg).toContain('📊 Hoje: 292 / 2168 kcal')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/utils/format-meal-addition.test.ts`
  - Expected: FAIL — na nova ordem, o 7º arg `undefined` cai onde hoje a função espera `dateLabel`, então `📊 Hoje:` vira `📊 undefined:` / `📊 [object Object]:`; o assert de `P: 18/144g` falha porque o macro chega no slot de `dateLabel`.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/utils/formatters.ts`, trocar a assinatura de `formatMealAddition` (linhas 90-101) para colocar `macros?` antes de `dateLabel?`:

```ts
export function formatMealAddition(
  mealType: string,
  addedItems: MealItem[],
  fullItems: MealItem[],
  mealTotal: number,
  dailyConsumed: number,
  dailyTarget: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
  dateLabel: string = 'Hoje',
): string {
```

O corpo já chama `formatProgress(dailyConsumed, dailyTarget, macros, dateLabel)` (linha 118) — não muda, agora os nomes batem.

Em `src/lib/bot/meal-response.ts`, corrigir o call site (linha 39) que hoje passa `(dateLabel, macros)` invertido:

```ts
  return logResult.wasAppend
    ? formatMealAddition(logResult.meal.mealType, addedForMsg, fullItems, logResult.meal.totalCalories, dailyConsumed, target, macros, dateLabel)
    : formatMealBreakdown(logResult.meal.mealType, fullItems, logResult.meal.totalCalories, dailyConsumed, target, macros, dateLabel)
```

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/utils/format-meal-addition.test.ts tests/unit/bot/meal-response.test.ts`
  - Expected: PASS — ambos verdes (meal-response.test.ts já cobre o caso "macros + append" em handler.ts:116-144 e continua passando com a nova ordem).

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/utils/formatters.ts src/lib/bot/meal-response.ts tests/unit/utils/format-meal-addition.test.ts && git commit -m "refactor(formatters): normaliza ordem de args de formatMealAddition para (macros, dateLabel)"`

---

### Task 3: Foto comum — passar macros em `buildConsolidatedMealResponse`

No `handleIncomingImage` (handler.ts:957-959), a foto usa `getDailyCalories` e chama `buildConsolidatedMealResponse(logResult, dailyConsumed, target, dateLabel)` SEM macros. Trocar por `getDailyMacros` + `buildMacrosBlock` e passar o bloco. O `user` aqui é o objeto completo carregado por `findUserByPhone` (handler.ts:781), então já tem os 3 campos de macro.

**Files:** Modify `src/lib/bot/handler.ts` (imports ~34, handleIncomingImage ~957-959); Modify `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Write the failing test**

Em `tests/unit/bot/handler.test.ts`, localizar o describe do fluxo de imagem (`handleIncomingImage`) e adicionar, dentro dele, um caso que mocka um user com metas de macro e `getDailyMacros` retornando consumo, asserindo que a resposta contém a linha de macros. Usar o mesmo padrão de mocks já presente no arquivo (procure por `mockGetDailyMacros` / `getDailyMacros`; se ainda não estiver mockado em `@/lib/db/queries/meals`, adicione `getDailyMacros: mockGetDailyMacros` ao factory existente e crie o hoisted `mockGetDailyMacros`).

```ts
it('includes the P:/G:/C: macro line in the photo confirmation when the user has macro goals', async () => {
  // user carregado por findUserByPhone tem metas de macro
  mockFindUserByPhone.mockResolvedValue({
    ...baseUser, // onboardingComplete: true, dailyCalorieTarget: 2000, timezone
    dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200,
  })
  mockAnalyzeImage.mockResolvedValue({
    image_type: 'food', confidence: 'high', needs_clarification: false,
    items: [{ food: 'Ovo', quantity_grams: 100, calories: 143, protein: 13, carbs: 1, fat: 10 }],
    unknown_items: [],
  })
  mockLogFoodToMeal.mockResolvedValue({
    wasAppend: false, mealId: 'm-photo',
    addedItems: [{ foodName: 'Ovo', quantityGrams: 100, calories: 143, proteinG: 13, carbsG: 1, fatG: 10, source: 'manual' }],
    meal: { id: 'm-photo', mealType: 'breakfast', totalCalories: 143, registeredAt: '2026-05-31T12:00:00Z',
      items: [{ id: 'i1', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: null, calories: 143, proteinG: 13, carbsG: 1, fatG: 10, source: 'manual', confidence: 'high' }] },
  })
  mockGetDailyMacros.mockResolvedValue({ calories: 143, proteinG: 13, carbsG: 1, fatG: 10 })

  await handleIncomingImage('5511999999999', 'msg-1', 'img-1')

  const sent = mockSendTextMessage.mock.calls.map(c => c[1]).join('\n')
  expect(sent).toContain('P: 13/120g')
})
```

> Ajuste os nomes dos mocks (`baseUser`, `mockFindUserByPhone`, `mockAnalyzeImage`, `mockSendTextMessage`, `mockLogFoodToMeal`) aos já existentes no topo de handler.test.ts. Se o teste de imagem ainda não existir no arquivo, crie um `describe('handleIncomingImage macro line', ...)` reusando os `vi.mock` já registrados.

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/bot/handler.test.ts -t "macro line in the photo"`
  - Expected: FAIL — `expect(sent).toContain('P: 13/120g')` falha porque a foto ainda chama `buildConsolidatedMealResponse(...)` sem macros, então só a linha de calorias sai.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/handler.ts`, adicionar `getDailyMacros` ao import de `@/lib/db/queries/meals` (linha 34) e `buildMacrosBlock` de `@/lib/bot/macros`:

```ts
import { getDailyCalories, getDailyMacros, getMealWithItems } from '@/lib/db/queries/meals'
import { buildMacrosBlock } from '@/lib/bot/macros'
```

Substituir handler.ts:957-959 por:

```ts
    const dailyMacros = await getDailyMacros(supabase, user.id, targetDate, user.timezone)
    const { target, macros } = buildMacrosBlock(user, dailyMacros)
    const response = buildConsolidatedMealResponse(logResult, dailyMacros.calories, target, dateLabel, macros)
```

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/bot/handler.test.ts -t "macro line in the photo"`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts && git commit -m "feat(handler): exibe linha de macros no registro por foto"`

---

### Task 4: Rótulo nutricional — propagar macros do user e passar bloco em `handleLabelPortions`

`handleLabelPortions` (handler.ts:972-1049) recebe `user: { calorieMode, dailyCalorieTarget, timezone }` (sem macros) e em 1043-1045 usa `getDailyCalories` + `buildConsolidatedMealResponse` sem macros. Os 3 call sites (~441-444, ~873-883) passam só esses campos. Vamos ampliar o tipo `user` para incluir os 3 campos de macro e propagá-los.

**Files:** Modify `src/lib/bot/handler.ts` (handleLabelPortions ~972-1045, call sites ~441-444 e ~879-883); Modify `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('includes the P:/G:/C: macro line in the nutrition-label confirmation', async () => {
  mockFindUserByPhone.mockResolvedValue({
    ...baseUser, dailyCalorieTarget: 2000, dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200,
  })
  // image_type=nutrition_label + caption com porções resolve direto via handleLabelPortions
  mockAnalyzeImage.mockResolvedValue({
    image_type: 'nutrition_label', confidence: 'high', needs_clarification: false,
    items: [{ food: 'Granola', quantity_grams: 30, calories: 130, protein: 4, carbs: 20, fat: 4 }],
    unknown_items: [],
  })
  mockLogFoodToMeal.mockResolvedValue({
    wasAppend: false, mealId: 'm-label',
    addedItems: [{ foodName: 'Granola', quantityGrams: 30, calories: 130, proteinG: 4, carbsG: 20, fatG: 4, source: 'manual' }],
    meal: { id: 'm-label', mealType: 'snack', totalCalories: 130, registeredAt: '2026-05-31T12:00:00Z',
      items: [{ id: 'i1', foodName: 'Granola', quantityGrams: 30, quantityDisplay: null, calories: 130, proteinG: 4, carbsG: 20, fatG: 4, source: 'manual', confidence: 'high' }] },
  })
  mockGetDailyMacros.mockResolvedValue({ calories: 130, proteinG: 4, carbsG: 20, fatG: 4 })

  // caption com "1 porção" para resolver direto (extractLabelPortionsFromCaption)
  await handleIncomingImage('5511999999999', 'msg-2', 'img-2', '1 porção')

  const sent = mockSendTextMessage.mock.calls.map(c => c[1]).join('\n')
  expect(sent).toContain('P: 4/120g')
})
```

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/bot/handler.test.ts -t "nutrition-label confirmation"`
  - Expected: FAIL — `handleLabelPortions` ainda usa `getDailyCalories` + `buildConsolidatedMealResponse` sem macros; a linha `P: 4/120g` não aparece. (Também há erro de tipo: `user` não tem os campos de macro até alterarmos a assinatura.)

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/handler.ts`, ampliar a assinatura `user` de `handleLabelPortions` (linha 979):

```ts
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    timezone?: string
  },
```

Substituir handler.ts:1043-1045 por:

```ts
  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const { target, macros } = buildMacrosBlock(user, dailyMacros)
  const response = buildConsolidatedMealResponse(logResult, dailyMacros.calories, target, dateLabel, macros)
```

Atualizar os 2 call sites que passam só `{calorieMode, dailyCalorieTarget, timezone}`:

handler.ts:441-444:
```ts
          await handleLabelPortions(supabase, from, user.id, messageId, text, context, {
            calorieMode: user.calorieMode,
            dailyCalorieTarget: user.dailyCalorieTarget,
            dailyProteinG: user.dailyProteinG,
            dailyFatG: user.dailyFatG,
            dailyCarbsG: user.dailyCarbsG,
            timezone: user.timezone,
          })
```

handler.ts:879-883:
```ts
          {
            calorieMode: user.calorieMode,
            dailyCalorieTarget: user.dailyCalorieTarget,
            dailyProteinG: user.dailyProteinG,
            dailyFatG: user.dailyFatG,
            dailyCarbsG: user.dailyCarbsG,
            timezone: user.timezone,
          },
```

> Nota: no call site ~441 o `user` é o `findUserByPhone` completo (tem os campos). No ~879 idem (mesmo escopo de `handleIncomingImage`). Ambos resolvem.

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/bot/handler.test.ts -t "nutrition-label confirmation"`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts && git commit -m "feat(handler): exibe linha de macros no registro por rótulo nutricional"`

---

### Task 5: Produto / código de barras — propagar macros em `registerConfirmedProductMeal`

`registerConfirmedProductMeal` (handler.ts:188-235) recebe `user: { dailyCalorieTarget, timezone }` e em 230-232 usa `getDailyCalories` + `buildConsolidatedMealResponse` sem macros. Os 2 call sites (~469-479, ~527-537) passam só `{dailyCalorieTarget, timezone}`. Ampliar o tipo e propagar.

**Files:** Modify `src/lib/bot/handler.ts` (registerConfirmedProductMeal ~194, ~230-232; call sites ~475-478 e ~533-536); Modify `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('includes the P:/G:/C: macro line when registering a confirmed product meal (quantity reply)', async () => {
  mockFindUserByPhone.mockResolvedValue({
    ...baseUser, dailyCalorieTarget: 2000, dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200,
  })
  // estado awaiting_product_quantity com produto e pendingMeal
  mockGetState.mockResolvedValue({
    contextType: 'awaiting_product_quantity',
    contextData: {
      product: { id: 'p1', name: 'Magic Toast', caloriesPer100g: 400, proteinPer100g: 10, carbsPer100g: 70, fatPer100g: 8, servingSizeG: 30, servingDisplay: '6 torradas' },
      pendingMeal: { mealType: 'snack', originalMessage: 'magic toast', food: 'magic toast', quantityDisplay: null, mealItems: [], productItemIndex: 0 },
    },
  })
  mockLogFoodToMeal.mockResolvedValue({
    wasAppend: false, mealId: 'm-prod',
    addedItems: [{ foodName: 'Magic Toast', quantityGrams: 30, calories: 120, proteinG: 3, carbsG: 21, fatG: 2.4, source: 'product' }],
    meal: { id: 'm-prod', mealType: 'snack', totalCalories: 120, registeredAt: '2026-05-31T12:00:00Z',
      items: [{ id: 'i1', foodName: 'Magic Toast', quantityGrams: 30, quantityDisplay: '30g', calories: 120, proteinG: 3, carbsG: 21, fatG: 2.4, source: 'product', confidence: 'high' }] },
  })
  mockGetDailyMacros.mockResolvedValue({ calories: 120, proteinG: 3, carbsG: 21, fatG: 2 })

  await handleIncomingMessage('5511999999999', 'msg-3', '30g')

  const sent = mockSendTextMessage.mock.calls.map(c => c[1]).join('\n')
  expect(sent).toContain('P: 3/120g')
})
```

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/bot/handler.test.ts -t "confirmed product meal"`
  - Expected: FAIL — `registerConfirmedProductMeal` usa `getDailyCalories` + `buildConsolidatedMealResponse` sem macros; `P: 3/120g` ausente.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/handler.ts`, ampliar a assinatura `user` de `registerConfirmedProductMeal` (linha 194):

```ts
  user: {
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    timezone?: string
  },
```

Substituir handler.ts:230-232 por:

```ts
  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const { target, macros } = buildMacrosBlock(user, dailyMacros)
  const response = buildConsolidatedMealResponse(logResult, dailyMacros.calories, target, dateLabel, macros)
```

Atualizar os 2 call sites (objeto `user` passado), handler.ts:475-478:

```ts
            {
              dailyCalorieTarget: user.dailyCalorieTarget,
              dailyProteinG: user.dailyProteinG,
              dailyFatG: user.dailyFatG,
              dailyCarbsG: user.dailyCarbsG,
              timezone: user.timezone,
            },
```

E handler.ts:533-536 (idêntico):

```ts
              {
                dailyCalorieTarget: user.dailyCalorieTarget,
                dailyProteinG: user.dailyProteinG,
                dailyFatG: user.dailyFatG,
                dailyCarbsG: user.dailyCarbsG,
                timezone: user.timezone,
              },
```

> Ambos os call sites estão em `handleIncomingMessage`, onde `user` é o `findUserByPhone` completo (handler.ts:247) — os 3 campos existem.

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/bot/handler.test.ts -t "confirmed product meal"`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts && git commit -m "feat(handler): exibe linha de macros no registro de produto/código de barras"`

---

### Task 6: Consulta → registrar — passar macros em `registerQueryItems`

`registerQueryItems` (query.ts:16-62) recebe `user: { timezone, dailyCalorieTarget }` e em 59-61 usa `getDailyCalories` + `buildConsolidatedMealResponse` sem macros. É chamada por `handleQueryConfirmation` (query.ts:389) e `registerFromQuotedQuery` (query.ts:90). Ampliar o tipo `user`, trocar para `getDailyMacros`+`buildMacrosBlock`, e propagar os campos a partir do handler (call sites em handler.ts:366-369 e 615-618).

**Files:** Modify `src/lib/bot/flows/query.ts` (imports ~7-9, registerQueryItems ~32/59-61, registerFromQuotedQuery ~68, handleQueryConfirmation ~297); Modify `src/lib/bot/handler.ts` (~366-369, ~615-618); Modify `tests/unit/bot/query.test.ts`

- [ ] **Step 1: Write the failing test**

Em `tests/unit/bot/query.test.ts`, no factory de mock de `@/lib/db/queries/meals` (linhas 50-53) adicionar `getDailyMacros: mockGetDailyMacros` (e criar o hoisted `mockGetDailyMacros`). Depois, dentro de `describe('handleQueryConfirmation', ...)`, adicionar:

```ts
it('includes the P:/G:/C: macro line when the user has macro goals', async () => {
  mockGetDailyMacros.mockResolvedValue({ calories: 580, proteinG: 30, carbsG: 70, fatG: 20 })
  mockLogFoodToMeal.mockResolvedValue({
    wasAppend: false, mealId: 'meal-new-1',
    addedItems: [{ foodName: 'coxinha', quantityGrams: 130, calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', quantityDisplay: '1 unidade' }],
    meal: { id: 'meal-new-1', mealType: 'snack', totalCalories: 290, registeredAt: '2026-05-30T15:00:00.000Z',
      items: [{ id: 'i1', foodName: 'coxinha', quantityGrams: 130, quantityDisplay: '1 unidade', calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', confidence: 'high' }] },
  })

  const result = await handleQueryConfirmation(
    supabase, USER_ID, 'registrar', confirmationContext,
    { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000, dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200 },
  )

  expect(result).toContain('P: 30/120g')
})

it('omits the macro line when the user has no macro goals', async () => {
  mockGetDailyMacros.mockResolvedValue({ calories: 290, proteinG: 13, carbsG: 22, fatG: 17 })
  mockLogFoodToMeal.mockResolvedValue({
    wasAppend: false, mealId: 'meal-new-2',
    addedItems: [{ foodName: 'coxinha', quantityGrams: 130, calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', quantityDisplay: '1 unidade' }],
    meal: { id: 'meal-new-2', mealType: 'snack', totalCalories: 290, registeredAt: '2026-05-30T15:00:00.000Z',
      items: [{ id: 'i1', foodName: 'coxinha', quantityGrams: 130, quantityDisplay: '1 unidade', calories: 290, proteinG: 13, carbsG: 22, fatG: 17, source: 'taco', confidence: 'high' }] },
  })

  const result = await handleQueryConfirmation(
    supabase, USER_ID, 'registrar', confirmationContext,
    { timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000 },
  )

  expect(result).not.toContain('P: 13/')
})
```

> Os casos existentes (`consolidates into the existing same-day meal …` e `creates a new meal …`) usam `mockGetDailyCalories` — após esta task `registerQueryItems` passa a usar `getDailyMacros`. Atualize esses dois testes: troque `mockGetDailyCalories.mockResolvedValue(580)` no `beforeEach` por `mockGetDailyMacros.mockResolvedValue({ calories: 580, proteinG: 0, carbsG: 0, fatG: 0 })` e mantenha os asserts de calorias (`380`/`290`) — eles continuam derivando de `dailyMacros.calories`/`totalCalories`.

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/bot/query.test.ts`
  - Expected: FAIL — `P: 30/120g` ausente (registerQueryItems não monta macros) e/ou erro de tipo no user estendido; os 2 testes existentes quebram porque ainda dependem de `mockGetDailyCalories`.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/flows/query.ts`, trocar o import (linha 7) e adicionar o helper:

```ts
import { getDailyMacros } from '@/lib/db/queries/meals'
import { buildMacrosBlock } from '@/lib/bot/macros'
```

Ampliar o tipo `user` de `registerQueryItems` (linha 32):

```ts
  user: { timezone?: string; dailyCalorieTarget?: number | null; dailyProteinG?: number | null; dailyFatG?: number | null; dailyCarbsG?: number | null } | undefined,
```

Substituir query.ts:57-61 por:

```ts
  await clearState(userId)

  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user?.timezone)
  const { target, macros } = buildMacrosBlock(
    { dailyCalorieTarget: user?.dailyCalorieTarget ?? null, dailyProteinG: user?.dailyProteinG, dailyFatG: user?.dailyFatG, dailyCarbsG: user?.dailyCarbsG },
    dailyMacros,
  )
  return buildConsolidatedMealResponse(logResult, dailyMacros.calories, target, dateLabel, macros)
```

Ampliar os tipos `user` de `registerFromQuotedQuery` (linha 68) e `handleQueryConfirmation` (linha 297) para o mesmo shape estendido:

```ts
  user?: { timezone?: string; dailyCalorieTarget?: number | null; dailyProteinG?: number | null; dailyFatG?: number | null; dailyCarbsG?: number | null },
```

Em `src/lib/bot/handler.ts`, atualizar os 2 call sites. handler.ts:366-369 (handleQueryConfirmation):

```ts
            const confirmResponse = await handleQueryConfirmation(supabase, user.id, text, context, {
              timezone: user.timezone,
              dailyCalorieTarget: user.dailyCalorieTarget,
              dailyProteinG: user.dailyProteinG,
              dailyFatG: user.dailyFatG,
              dailyCarbsG: user.dailyCarbsG,
            })
```

handler.ts:615-618 (registerFromQuotedQuery):

```ts
          const registerResponse = await registerFromQuotedQuery(supabase, user.id, quoteContext, {
            timezone: user.timezone,
            dailyCalorieTarget: user.dailyCalorieTarget,
            dailyProteinG: user.dailyProteinG,
            dailyFatG: user.dailyFatG,
            dailyCarbsG: user.dailyCarbsG,
          })
```

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/bot/query.test.ts`
  - Expected: PASS — novos casos verdes e os 2 existentes verdes com `mockGetDailyMacros`.

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/bot/flows/query.ts src/lib/bot/handler.ts tests/unit/bot/query.test.ts && git commit -m "feat(query): exibe linha de macros ao registrar resultado de consulta"`

---

### Task 7: Quantidades em lote — passar macros no `handleBulkQuantitiesResponse`

`handleBulkQuantitiesResponse` (meal-log.ts:1087-1298) recebe `user: { calorieMode, dailyCalorieTarget, phone, timezone }` (sem macros) e na finalização (1266-1294) usa `getDailyCalories` + `formatMealBreakdown` SEM macros nos 2 ramos (resolvedMealId em 1279, novo meal em 1288). Ampliar o tipo `user`, trocar `getDailyCalories` por `getDailyMacros`+`buildMacrosBlock`, e passar `macros` aos dois `formatMealBreakdown`.

**Files:** Modify `src/lib/bot/flows/meal-log.ts` (handleBulkQuantitiesResponse ~1092-1097, ~1266-1294); Modify `tests/unit/bot/meal-log.test.ts`

- [ ] **Step 1: Write the failing test**

Em `tests/unit/bot/meal-log.test.ts`, o `formatMealBreakdown` é mockado (linha 105: `mockFormatMealBreakdown`). Localizar o describe que cobre o fluxo `awaiting_bulk_quantities` (registro, não query). Adicionar um caso que verifica que `formatMealBreakdown` foi chamado com um `macros` definido quando o user tem metas:

```ts
it('passes the macros block to formatMealBreakdown in the bulk-quantities flow when the user has macro goals', async () => {
  // contexto awaiting_bulk_quantities, ramo de registro (flow != 'query')
  const context = {
    contextType: 'awaiting_bulk_quantities',
    contextData: {
      pending_items: [{ food: 'arroz', portion_type: 'bulk' }],
      resolved_meal_id: null,
      meal_type: 'lunch',
      original_message: 'comi arroz',
    },
  } as unknown as ConversationContext

  mockAnalyzeMeal.mockResolvedValue([{
    meal_type: 'lunch', confidence: 'high', references_previous: false, reference_query: null,
    items: [{ food: 'arroz', quantity_grams: 100, quantity_display: '100g', portion_type: 'bulk', has_user_quantity: true, calories: 130, protein: 3, carbs: 28, fat: 0.3, confidence: 'high' }],
    unknown_items: [], needs_clarification: false,
  }])
  mockGetDailyMacros.mockResolvedValue({ calories: 130, proteinG: 3, carbsG: 28, fatG: 0 })

  await handleMealLog(supabase, USER_ID, '100g de arroz', {
    calorieMode: 'taco', dailyCalorieTarget: 2000,
    dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200, timezone: 'America/Sao_Paulo',
  }, context)

  const lastCall = mockFormatMealBreakdown.mock.calls.at(-1)!
  // assinatura: (mealType, items, total, dailyConsumed, dailyTarget, macros?, dateLabel?)
  expect(lastCall[5]).toEqual({
    consumed: { proteinG: 3, fatG: 0, carbsG: 28 },
    target: { proteinG: 120, fatG: 60, carbsG: 200 },
  })
})
```

> Ajuste os nomes (`USER_ID`, `mockAnalyzeMeal`, `mockGetDailyMacros`, `mockFormatMealBreakdown`, `ConversationContext`) aos já existentes no arquivo; o `mockEnrichItemsWithTaco`/`enrichItemsWithTaco` é interno a meal-log.ts (não mockado), então o item já vem com `has_user_quantity: true` e quantidade pra resolver sem ramificar p/ produto.

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/bot/meal-log.test.ts -t "macros block to formatMealBreakdown in the bulk"`
  - Expected: FAIL — hoje o ramo de novo meal (meal-log.ts:1288) chama `formatMealBreakdown(...)` sem o arg `macros`, então `lastCall[5]` é `undefined`.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/flows/meal-log.ts`, ampliar a assinatura `user` de `handleBulkQuantitiesResponse` (linhas 1092-1097):

```ts
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
    phone?: string
    timezone?: string
  },
```

Substituir o bloco meal-log.ts:1266-1294 (de `const dailyConsumed = await getDailyCalories(...)` até o `return` final) por:

```ts
  const dailyMacros = await getDailyMacros(supabase, userId, targetDate, user.timezone)
  const { target, macros } = buildMacrosBlock(user, dailyMacros)

  if (resolvedMealId) {
    const fullMeal = await getMealWithItems(supabase, resolvedMealId)
    if (fullMeal) {
      const receiptItems = fullMeal.items.map(i => ({
        food: i.foodName,
        quantityGrams: i.quantityGrams,
        quantityDisplay: i.quantityDisplay,
        calories: i.calories,
      }))
      return {
        response: formatMealBreakdown(fullMeal.mealType, receiptItems, fullMeal.totalCalories, dailyMacros.calories, target, macros),
        completed: true,
        mealId: resolvedMealId,
      }
    }
  }

  const total = totalCaloriesFromEnriched(enriched)
  return {
    response: formatMealBreakdown(
      mealType,
      enriched.map(i => ({ food: i.food, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories })),
      total,
      dailyMacros.calories,
      target,
      macros,
    ),
    completed: true,
    mealId: savedMealId ?? undefined,
  }
```

> O `parseDateFromMessage` já produz `targetDate` no início da função (meal-log.ts:1107), então `getDailyMacros(..., targetDate, ...)` está disponível.

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/bot/meal-log.test.ts`
  - Expected: PASS — novo caso verde; demais casos do arquivo seguem verdes (o ramo query não foi tocado).

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/bot/flows/meal-log.ts tests/unit/bot/meal-log.test.ts && git commit -m "feat(meal-log): exibe linha de macros no fluxo de quantidades em lote"`

---

### Task 8: Edição / correção — propagar macros nas 9 saídas de `formatProgress`

`edit.ts` nunca importa `getDailyMacros` e tem 9 saídas chamando `formatProgress(dailyConsumed, target)` sem macros (linhas 268, 414, 434, 447, 513, 581, 610, 629, 670). O `user` chega como `{ timezone, dailyCalorieTarget }` em todas as funções. Vamos: ampliar o tipo `user` (todas as funções de edit que recebem `user`), criar um helper local `progressForUser` que busca macros e retorna a linha pronta, e substituir as 9 chamadas. Também propagar os 3 campos a partir do handler (todos os call sites de `handleEdit`).

**Files:** Modify `src/lib/bot/flows/edit.ts` (imports ~14-22, tipos `user` em handleEdit/handleAwaitingCorrectionValue/handleNaturalLanguageCorrection/handleNaturalLanguageCorrectionWithMeal/renameItem/handleQuotedEdit, 9 saídas); Modify `src/lib/bot/handler.ts` (call sites de handleEdit ~298-301, ~320-323, ~406-409, ~416-419, ~576-579, ~587-591, ~670-673); Modify `tests/unit/bot/edit.test.ts`

- [ ] **Step 1: Write the failing test**

Em `tests/unit/bot/edit.test.ts`, o `formatProgress` é mockado (linha 64) com retorno fixo. Vamos: (a) adicionar `getDailyMacros: mockGetDailyMacros` ao factory de `@/lib/db/queries/meals` (linhas 42-52) e criar o hoisted `mockGetDailyMacros`; (b) trocar o mock de `formatProgress` por um que reflita os args para podermos asseri-los:

```ts
// no factory de @/lib/utils/formatters (linha 63):
vi.mock('@/lib/utils/formatters', () => ({
  formatProgress: vi.fn((consumed: number, target: number, macros?: unknown) =>
    macros ? `📊 Hoje: ${consumed} / ${target} kcal\nP-LINE` : `📊 Hoje: ${consumed} / ${target} kcal`),
}))
```

Adicionar, dentro do describe do fluxo de remoção de item (quote-based ou guided — qualquer das 9 saídas; usar a de `remove_item`), um caso:

```ts
it('feeds getDailyMacros + macros into formatProgress when the user has macro goals', async () => {
  mockGetDailyMacros.mockResolvedValue({ calories: 1200, proteinG: 60, carbsG: 100, fatG: 30 })
  // ... arrange para acionar uma saída com formatProgress (ex.: remove_item via NL correction)
  // chamar handleEdit com user contendo metas:
  await handleEdit(supabase, USER_ID, /* mensagem que dispara remove_item */ '...', /* context */ null, {
    timezone: 'America/Sao_Paulo', dailyCalorieTarget: 2000,
    dailyProteinG: 120, dailyFatG: 60, dailyCarbsG: 200,
  })

  expect(mockGetDailyMacros).toHaveBeenCalled()
  const fpCall = (await import('@/lib/utils/formatters')).formatProgress as unknown as { mock: { calls: unknown[][] } }
  const lastFp = fpCall.mock.calls.at(-1)!
  expect(lastFp[2]).toEqual({
    consumed: { proteinG: 60, fatG: 30, carbsG: 100 },
    target: { proteinG: 120, fatG: 60, carbsG: 200 },
  })
})
```

> Use o setup de uma saída já testada no arquivo (ex.: a de remoção via quote em `handleQuotedEdit`, que tem mocks de `getMealWithItems`/`removeMealItem`/`recalculateMealTotal` já configuráveis). O ponto essencial do assert é: `getDailyMacros` foi chamado e `formatProgress` recebeu um 3º arg `macros` definido.

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/bot/edit.test.ts -t "getDailyMacros + macros into formatProgress"`
  - Expected: FAIL — edit.ts ainda usa `getDailyCalories` + `formatProgress(dailyConsumed, target)` (sem macros), então `getDailyMacros` nunca é chamado e `lastFp[2]` é `undefined`.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/flows/edit.ts`, ajustar imports (linhas 14-22): adicionar `getDailyMacros` ao import de `@/lib/db/queries/meals` e importar o helper; remover `getDailyCalories` se não restar uso (todas as 9 saídas migram, então pode sair):

```ts
import {
  deleteMeal,
  getLastMeal,
  getRecentMeals,
  getMealWithItems,
  updateMealItem,
  updateMealType,
  removeMealItem,
  recalculateMealTotal,
  getDailyMacros,
} from '@/lib/db/queries/meals'
import type { RecentMeal } from '@/lib/db/queries/meals'
import { getLLMProvider } from '@/lib/llm/index'
import { buildCorrectionPrompt, buildCorrectionPromptWithItems } from '@/lib/llm/prompts/correction'
import { CorrectionSchema } from '@/lib/llm/schemas/correction'
import type { Correction } from '@/lib/llm/schemas/correction'
import { appendItemsToMeal } from '@/lib/bot/flows/meal-log'
import { formatProgress } from '@/lib/utils/formatters'
import { buildMacrosBlock } from '@/lib/bot/macros'
```

Definir um tipo e um helper logo após `mealLabel` (após linha 53):

```ts
type EditUser = {
  timezone?: string
  dailyCalorieTarget?: number | null
  dailyProteinG?: number | null
  dailyFatG?: number | null
  dailyCarbsG?: number | null
}

/** Builds the progress line (calories + optional macros) for an edit reply. */
async function progressForUser(
  supabase: SupabaseClient,
  userId: string,
  user?: EditUser,
): Promise<string> {
  const dailyMacros = await getDailyMacros(supabase, userId, undefined, user?.timezone)
  const { target, macros } = buildMacrosBlock(
    { dailyCalorieTarget: user?.dailyCalorieTarget ?? null, dailyProteinG: user?.dailyProteinG, dailyFatG: user?.dailyFatG, dailyCarbsG: user?.dailyCarbsG },
    dailyMacros,
  )
  return formatProgress(dailyMacros.calories, target, macros)
}
```

Substituir o tipo `user?: { timezone?: string; dailyCalorieTarget?: number | null }` por `user?: EditUser` em TODAS as funções que o declaram: `handleEdit` (linha 64), `handleAwaitingCorrectionItem` (176), `handleAwaitingCorrectionValue` (211), `handleNaturalLanguageCorrection` (281), `handleNaturalLanguageCorrectionWithMeal` (330), `renameItem` (546), `handleQuotedEdit` (593).

Substituir cada uma das 9 saídas. Padrão: trocar o par
```ts
  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
  const target = user?.dailyCalorieTarget ?? 2000
  ...formatProgress(dailyConsumed, target)
```
por
```ts
  const progress = await progressForUser(supabase, userId, user)
  ...${progress}
```

Localizações exatas:
- **linha 266-270** (`handleAwaitingCorrectionValue`):
```ts
  await clearState(userId)
  const progress = await progressForUser(supabase, userId, user)
  return `✅ ${foodName} atualizado: ${currentGrams}g → ${newGrams}g (${targetItem.calories} → ${newCalories} kcal)\n${progress}`
```
- **linha 408-415** (`add_item`):
```ts
      const progress = await progressForUser(supabase, userId, user)
      return [
        '✅ Adicionado:',
        itemLines,
        `Novo total da refeição: ${result.newTotal} kcal`,
        progress,
      ].join('\n')
```
- **linha 432-434** (`change_meal_type`):
```ts
      const progress = await progressForUser(supabase, userId, user)
      return `✅ Refeição movida de ${mealLabel(options.currentMealType)} para ${mealLabel(correction.target_meal_type)}.\n${progress}`
```
- **linha 445-447** (`remove_item`):
```ts
      const progress = await progressForUser(supabase, userId, user)
      return `✅ ${targetItem.foodName} removido! Novo total: ${newTotal} kcal\n${progress}`
```
- **linha 511-513** (`update_value`):
```ts
      const progress = await progressForUser(supabase, userId, user)
      return `✅ ${targetItem.foodName}: ${oldValue} → ${amount} ${fieldLabels[field]}\n${progress}`
```
- **linha 572-582** (`renameItem`):
```ts
    await clearState(userId)
    const progress = await progressForUser(supabase, userId, user)

    return [
      '✏️ Corrigido!',
      `  ${oldName} ${targetItem.quantityGrams}g → ${newItem.food} ${newItem.quantity_grams ?? targetItem.quantityGrams}g`,
      `  ${oldCalories} kcal → ${Math.round(newItem.calories ?? 0)} kcal`,
      '',
      `📊 Novo total da refeição: ${newTotal} kcal`,
      progress,
    ].join('\n')
```
- **linha 608-610** (`handleQuotedEdit`, delete meal inteiro):
```ts
    await clearState(userId)
    const progress = await progressForUser(supabase, userId, user)
    return `Refeição apagada! ✅\n${progress}`
```
- **linha 627-629** (`handleQuotedEdit`, delete item):
```ts
    await clearState(userId)
    const progress = await progressForUser(supabase, userId, user)
    return `✅ ${targetItem.foodName} removido! Novo total: ${newTotal} kcal\n${progress}`
```
- **linha 668-670** (`handleQuotedEdit`, quantidade):
```ts
    await clearState(userId)
    const progress = await progressForUser(supabase, userId, user)
    return `✅ ${targetItem.foodName} atualizado: ${targetItem.quantityGrams}g → ${newGrams}g (${targetItem.calories} → ${newCalories} kcal)\n${progress}`
```

Em `src/lib/bot/handler.ts`, todos os 7 call sites de `handleEdit` passam `{ timezone, dailyCalorieTarget }`. Adicionar os 3 campos de macro em cada um (linhas 298-301, 320-323, 406-409, 416-419, 576-579, 587-591, 670-673). Como o objeto é idêntico, padronizar para:

```ts
            {
              timezone: user.timezone,
              dailyCalorieTarget: user.dailyCalorieTarget,
              dailyProteinG: user.dailyProteinG,
              dailyFatG: user.dailyFatG,
              dailyCarbsG: user.dailyCarbsG,
            }
```

(aplicar a cada call site, respeitando se há `quoteContext`/`quoteContext ?? undefined` como arg seguinte).

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/bot/edit.test.ts tests/unit/bot/handler.test.ts`
  - Expected: PASS — novo caso verde; os casos existentes de edit.test.ts seguem verdes porque o mock de `formatProgress` ainda retorna `📊 Hoje: …` (os asserts existentes verificam `toContain('📊 Hoje')`, mantido pelo novo mock).

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/bot/flows/edit.ts src/lib/bot/handler.ts tests/unit/bot/edit.test.ts && git commit -m "feat(edit): exibe linha de macros em todas as saídas de correção"`

---

### Task 9: Unificar a ordem P/G/C no preview do rótulo nutricional

O preview do rótulo (handler.ts:893) usa ordem `P / C / G` (`P: ...g | C: ...g | G: ...g`), enquanto `formatProgress` (formatters.ts:305) e `formatDailySummary` (formatters.ts:222) usam `P / G / C`. Corrigir o preview para P/G/C.

**Files:** Modify `src/lib/bot/handler.ts` (~893); Modify `tests/unit/bot/handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('renders the nutrition-label preview macros in P/G/C order (fat before carbs)', async () => {
  mockFindUserByPhone.mockResolvedValue({ ...baseUser, onboardingComplete: true })
  mockAnalyzeImage.mockResolvedValue({
    image_type: 'nutrition_label', confidence: 'high', needs_clarification: false,
    items: [{ food: 'Barra', quantity_grams: 25, calories: 100, protein: 8, carbs: 12, fat: 3 }],
    unknown_items: [],
  })
  // sem caption de porções → cai no preview com setState awaiting_label_portions

  await handleIncomingImage('5511999999999', 'msg-9', 'img-9')

  const preview = mockSendTextMessage.mock.calls.map(c => c[1]).find(m => m?.includes('Tabela nutricional'))!
  // P/G/C: gordura (G) vem antes de carbos (C)
  expect(preview).toMatch(/P:\s*8g\s*\|\s*G:\s*3g\s*\|\s*C:\s*12g/)
})
```

> `scaleNutritionLabelItem(item)` sem fator preserva os valores base (8/12/3). Ajuste o regex se o helper arredondar.

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run tests/unit/bot/handler.test.ts -t "P/G/C order"`
  - Expected: FAIL — a linha atual é `P: 8g | C: 12g | G: 3g` (P/C/G), então o regex P/G/C não casa.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/handler.ts`, substituir a linha 893:

```ts
        `  P: ${previewItem.protein ?? 0}g | G: ${previewItem.fat ?? 0}g | C: ${previewItem.carbs ?? 0}g`,
```

- [ ] **Step 4: Run test to verify it passes**
  - Run: `npx vitest run tests/unit/bot/handler.test.ts -t "P/G/C order"`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - Run: `git add src/lib/bot/handler.ts tests/unit/bot/handler.test.ts && git commit -m "fix(handler): padroniza ordem P/G/C no preview do rótulo nutricional"`

---

## Verificação final

- [ ] **Rodar a suíte completa:** `npm test`
  - Expected: todos verdes. Atenção especial a `tests/unit/bot/{macros,meal-log,meal-response,query,edit,handler}.test.ts` e `tests/unit/utils/{formatters,format-meal-addition}.test.ts`.
- [ ] **Lint:** `npm run lint`
  - Expected: zero erros. Conferir que `getDailyCalories` foi removido dos imports de `edit.ts` se nenhum uso restou (evita `no-unused-vars`), e que `handler.ts` importa `getDailyMacros` + `buildMacrosBlock`.
- [ ] **Sanidade manual de consistência:** confirmar que a linha "P:/G:/C:" agora aparece (quando o user tem metas de macro) em: registro por texto (já existia), foto, rótulo, produto/código de barras, consulta→registrar, quantidades em lote e todas as saídas de edição/correção; e que a ordem é P/G/C em todos.