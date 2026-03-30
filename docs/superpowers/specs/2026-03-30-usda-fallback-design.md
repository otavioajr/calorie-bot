# USDA FoodData Central Fallback — Design Spec

**Date**: 2026-03-30
**Status**: Draft

## Problem

When the bot can't find a food in the TACO table (e.g., whey protein, creatine, BCAA, imported products), it falls back to decomposition — treating the food as a composite dish and breaking it into basic ingredients. This is wrong for supplements and simple products that aren't composite foods. It produces inaccurate calorie values and shows a confusing message: "Não encontrei X na Tabela TACO. Vou decompor nos ingredientes..."

## Solution

Add USDA FoodData Central as a fallback source between TACO matching and decomposition. The USDA database covers 300K+ foods including branded supplements, international products, and processed foods — all with verified nutritional data.

## New Enrichment Pipeline

```
TACO base match → TACO fuzzy match → USDA search → Decompose (composites only) → LLM fallback
```

**Before (current):**
```
TACO base → TACO fuzzy → [msg: "Não encontrei..."] → Decompose → LLM fallback
```

**After:**
```
[msg: "Encontrando os alimentos... 🔍"] → TACO base → TACO fuzzy → USDA search → Decompose → LLM fallback
```

## Components

### 1. USDA Client (`src/lib/usda/client.ts`)

New module responsible for querying the USDA FoodData Central API.

**Function: `searchUSDAFood(foodName: string, quantityGrams: number): Promise<USDAResult | null>`**

Steps:
1. Translate `foodName` from PT-BR to English via LLM (`translateFoodName()`)
2. Call `GET https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_API_KEY}&query=${translatedName}&dataType=SR%20Legacy,Branded&pageSize=5`
3. From the results, select the first food that has all four required nutrients (calories, protein, carbs, fat)
4. Extract nutrients using USDA nutrient IDs:
   - 1008 = Energy (kcal)
   - 1003 = Protein (g)
   - 1005 = Carbohydrate (g)
   - 1004 = Total fat (g)
5. Calculate proportional values: USDA returns per 100g, scale to `quantityGrams`
6. Return `USDAResult` or `null` if no suitable match found

**Interface:**
```typescript
interface USDAResult {
  food: string           // original PT-BR name
  usdaFoodName: string   // name from USDA response
  fdcId: number          // USDA FDC ID for traceability
  calories: number
  protein: number
  carbs: number
  fat: number
}
```

**Translation function: `translateFoodName(foodNamePtBr: string): Promise<string>`**

Uses the existing LLM provider's `chat()` method with a minimal system prompt:
```
Translate the following Brazilian Portuguese food name to English.
Return ONLY the English name, nothing else.
```

This is a lightweight call using the classify model (cheap/fast).

**Environment variable:**
- `USDA_API_KEY` — obtained free from https://fdc.nal.usda.gov/api-key-signup/

**Rate limits:** 1,000 requests/hour per IP. More than sufficient for our use case.

### 2. Pipeline Changes (`src/lib/bot/flows/meal-log.ts`)

**`enrichItemsWithTaco` function modifications:**

1. **Add generic feedback message at the start**: Send "Encontrando os alimentos... 🔍" once before processing items (replaces the per-item decomposition feedback)

2. **New Step 3 — USDA search**: After TACO fuzzy match fails, before decomposition:
   ```
   for each item not matched by TACO:
     result = await searchUSDAFood(item.food, item.quantity_grams)
     if result:
       use USDA macros, set source = 'usda'
     else:
       add to needsDecomposition
   ```

3. **Remove `formatDecompositionFeedback` call**: No more "Não encontrei X na Tabela TACO..." message. The generic "Encontrando os alimentos..." already covers it.

### 3. Source Tracking

The `source` field in `EnrichedItem` gains a new value: `"usda"`.

Full set of sources:
- `user_provided` — user gave explicit macros
- `taco` — matched in TACO table (base or fuzzy)
- `usda` — matched in USDA FoodData Central
- `taco_decomposed` — composite food decomposed into TACO ingredients
- `approximate` — LLM estimation fallback
- `user_history` — matched from user's meal history

### 4. Message Changes (`src/lib/utils/formatters.ts`)

- **Remove**: `formatDecompositionFeedback` function (or keep but stop calling it)
- **Add**: `formatSearchFeedback(): string` that returns `"Encontrando os alimentos... 🔍"`

### 5. Environment & Config

Add to `.env.example`:
```
# USDA FoodData Central (free — get key at https://fdc.nal.usda.gov/api-key-signup/)
USDA_API_KEY=
```

## Error Handling

- If USDA API is down or returns error → skip silently, proceed to decomposition
- If USDA returns results but none have complete nutrients → skip, proceed to decomposition
- If translation fails → try searching with original PT-BR name as fallback
- Network timeout: 5 seconds max per USDA request

## Performance

- USDA search adds ~200-400ms per unmatched food item
- Translation LLM call adds ~100-200ms (using fast classify model)
- Total worst case per item: ~600ms
- Most common foods (arroz, feijão, frango, leite) still match TACO instantly — USDA only triggers for supplements, imported foods, and uncommon items

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/lib/usda/client.ts` | **Create** — USDA API client with search and translation |
| `src/lib/bot/flows/meal-log.ts` | **Modify** — add USDA step to pipeline, add generic feedback message |
| `src/lib/utils/formatters.ts` | **Modify** — add `formatSearchFeedback`, stop calling `formatDecompositionFeedback` |
| `.env.example` | **Modify** — add `USDA_API_KEY` |
| `.env.local` | **Modify** — add actual USDA API key |
| `tests/unit/usda/client.test.ts` | **Create** — unit tests for USDA client |
| `tests/unit/bot/meal-log.test.ts` | **Modify** — update tests for new pipeline order |
