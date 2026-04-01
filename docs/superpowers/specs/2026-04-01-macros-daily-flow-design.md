# Design: Macros no fluxo diário

**Data:** 2026-04-01  
**Escopo:** Exibir progresso de macronutrientes (proteína, gordura, carboidratos) após registro de refeição e no resumo diário.

---

## Contexto

A infraestrutura de macros já existe:
- **Banco:** `users.daily_protein_g`, `users.daily_fat_g`, `users.daily_carbs_g` (metas), `meal_items.protein_g/carbs_g/fat_g` (consumido)
- **Query:** `getDailyMacros()` em `src/lib/db/queries/meals.ts:211` retorna `{calories, proteinG, carbsG, fatG}` agregados do dia
- **Formatter:** `formatProgress()` em `src/lib/utils/formatters.ts:214` já aceita param `macros` opcional e renderiza a linha extra

O que falta é **conectar** essas peças nos dois fluxos.

---

## Formato de exibição

```
📊 Hoje: 1200 / 2000 kcal (faltam 800)
P: 80/120g | G: 40/65g | C: 150/250g
```

A linha de macros só aparece se o usuário tiver metas de macros definidas (`daily_protein_g`, `daily_fat_g`, `daily_carbs_g` não nulos).

---

## Mudança 1: Progresso após registro de refeição

**Arquivo:** `src/lib/bot/flows/meal-log.ts`

**Função:** `buildReceiptResponse()` (linha ~149)

**Hoje:** Recebe `dailyConsumedSoFar` e `dailyTarget` (apenas calorias), repassa para `formatMealBreakdown()` / `formatMultiMealBreakdown()` que chamam `formatProgress(consumed, target)` sem macros.

**Mudança:** 
1. `buildReceiptResponse()` passa a receber um param opcional de macros (consumed + target)
2. Repassar macros para `formatMealBreakdown()` e `formatMultiMealBreakdown()`
3. Essas funções repassam para `formatProgress(consumed, target, macros)`

**Dados necessários no caller:**
- Chamar `getDailyMacros()` após registrar a refeição (já temos o supabase, userId e timezone no contexto)
- Ler `user.dailyProteinG`, `user.dailyFatG`, `user.dailyCarbsG` (já disponível no objeto user)

---

## Mudança 2: Resumo diário

**Arquivo:** `src/lib/bot/flows/summary.ts`

**Função:** `handleDailySummary()` (linha ~96)

**Hoje:** Chama `getDailyMeals()` → `buildDailyMealSummary()` → `formatDailySummary(dateStr, meals, totalCalories, target)`. A função `formatDailySummary()` tem sua própria lógica de formatação e NÃO chama `formatProgress()`.

**Mudança:**
1. Em `handleDailySummary()`, chamar `getDailyMacros()` em paralelo com `getDailyMeals()`
2. `formatDailySummary()` passa a receber param opcional de macros (consumed + target)
3. No final da string formatada, adicionar a linha de macros (mesmo formato compacto)

---

## Mudança 3: Assinaturas de funções em formatters.ts

**Arquivo:** `src/lib/utils/formatters.ts`

Funções que precisam receber macros:

| Função | Linha | Mudança |
|--------|-------|---------|
| `formatMealBreakdown()` | ~40 | Adicionar param `macros?`, repassar para `formatProgress()` |
| `formatMultiMealBreakdown()` | ~85 | Adicionar param `macros?`, repassar para `formatProgress()` |
| `formatDailySummary()` | ~124 | Adicionar param `macros?`, renderizar linha extra no final |

`formatProgress()` já aceita macros — nenhuma mudança necessária.

---

## Tipo do param macros

Reusar a estrutura já definida em `formatProgress()`:

```typescript
macros?: {
  consumed: { proteinG: number; fatG: number; carbsG: number }
  target: { proteinG: number; fatG: number; carbsG: number }
}
```

Helper para construir esse objeto a partir de `getDailyMacros()` + user:

```typescript
// Inline no caller, não precisa de helper dedicado
const macros = (user.dailyProteinG && user.dailyFatG && user.dailyCarbsG)
  ? {
      consumed: { proteinG: daily.proteinG, fatG: daily.fatG, carbsG: daily.carbsG },
      target: { proteinG: user.dailyProteinG, fatG: user.dailyFatG, carbsG: user.dailyCarbsG },
    }
  : undefined
```

---

## Fora de escopo

- Macros por refeição individual no resumo
- Resumo semanal com macros
- Lembretes com macros
- Ajuste direto de metas de macros via settings
- Dashboard web (mudanças apenas no bot WhatsApp)

---

## Arquivos impactados

| Arquivo | Tipo de mudança |
|---------|----------------|
| `src/lib/bot/flows/meal-log.ts` | Buscar macros, passar para buildReceiptResponse |
| `src/lib/bot/flows/summary.ts` | Buscar macros, passar para formatDailySummary |
| `src/lib/utils/formatters.ts` | Propagar param macros em 3 funções |
