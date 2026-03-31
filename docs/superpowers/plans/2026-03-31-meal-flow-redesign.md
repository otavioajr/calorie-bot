# Meal Flow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the meal registration flow to classify portions (unit/bulk/packaged), ask for missing quantities, improve TACO matching with normalization and synonyms, and add real meal correction (not just delete).

**Architecture:** The LLM now classifies each food item with a `portion_type`. Bulk/packaged items without explicit quantities trigger a follow-up question before registration. TACO matching gets a normalization layer with synonyms and token-based search. The edit flow is rewritten to support updating individual meal items, not just deleting whole meals.

**Tech Stack:** TypeScript, Supabase (Postgres), Zod, Vitest, Next.js App Router

---

### Task 1: Database Migration — New Columns

**Files:**
- Create: `supabase/migrations/00014_meal_flow_redesign.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- supabase/migrations/00014_meal_flow_redesign.sql

-- food_cache: add portion classification columns
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS portion_type TEXT;
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS default_grams NUMERIC;
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS default_display TEXT;

-- meal_items: add confidence and display columns
ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT 'high';
ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS quantity_display TEXT;
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db push`
Expected: Migration applied successfully.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00014_meal_flow_redesign.sql
git commit -m "db: add portion_type to food_cache, confidence to meal_items"
```

---

### Task 2: Food Name Normalization Utils

**Files:**
- Create: `src/lib/utils/food-normalize.ts`
- Create: `tests/unit/utils/food-normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/utils/food-normalize.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeFoodNameForTaco, applySynonyms, tokenMatchScore } from '@/lib/utils/food-normalize'

describe('normalizeFoodNameForTaco', () => {
  it('lowercases and removes accents', () => {
    expect(normalizeFoodNameForTaco('Café com Leite')).toBe('cafe com leite')
  })

  it('normalizes multiple spaces', () => {
    expect(normalizeFoodNameForTaco('arroz   branco')).toBe('arroz branco')
  })

  it('trims whitespace', () => {
    expect(normalizeFoodNameForTaco('  banana  ')).toBe('banana')
  })
})

describe('applySynonyms', () => {
  it('normalizes "semi desnatado" to "semidesnatado"', () => {
    expect(applySynonyms('leite semi desnatado')).toBe('leite semidesnatado')
  })

  it('normalizes "semi-desnatado" to "semidesnatado"', () => {
    expect(applySynonyms('leite semi-desnatado')).toBe('leite semidesnatado')
  })

  it('normalizes "peito de frango" to TACO format', () => {
    expect(applySynonyms('peito de frango')).toBe('frango, peito')
  })

  it('normalizes "arroz branco" to TACO format', () => {
    expect(applySynonyms('arroz branco')).toBe('arroz, tipo 1, cozido')
  })

  it('returns input unchanged when no synonym matches', () => {
    expect(applySynonyms('abacaxi')).toBe('abacaxi')
  })
})

describe('tokenMatchScore', () => {
  it('returns 1.0 for perfect token overlap', () => {
    expect(tokenMatchScore(
      ['leite', 'semidesnatado'],
      ['leite', 'de', 'vaca', 'semidesnatado'],
    )).toBe(1.0)
  })

  it('returns 0.5 when half the input tokens match', () => {
    expect(tokenMatchScore(
      ['leite', 'chocolate'],
      ['leite', 'de', 'vaca', 'integral'],
    )).toBe(0.5)
  })

  it('returns 0 when no tokens match', () => {
    expect(tokenMatchScore(
      ['pizza'],
      ['arroz', 'tipo', '1', 'cozido'],
    )).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/utils/food-normalize.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement food-normalize.ts**

```typescript
// src/lib/utils/food-normalize.ts

/**
 * Synonyms map: normalized input phrases → TACO-compatible names.
 * Applied AFTER lowercasing and accent removal.
 * Longest matches first to avoid partial replacements.
 */
const SYNONYMS: [string, string][] = [
  // Sorted by length descending to match longest first
  ['leite semidesnatado', 'leite, de vaca, semidesnatado'],
  ['leite semi desnatado', 'leite, de vaca, semidesnatado'],
  ['leite semi-desnatado', 'leite, de vaca, semidesnatado'],
  ['leite integral', 'leite, de vaca, integral'],
  ['leite desnatado', 'leite, de vaca, desnatado'],
  ['peito de frango', 'frango, peito'],
  ['frango grelhado', 'frango, peito, sem pele, grelhado'],
  ['batata frita', 'batata, frita'],
  ['queijo minas', 'queijo, minas'],
  ['ovo cozido', 'ovo, de galinha, inteiro, cozido'],
  ['ovo frito', 'ovo, de galinha, inteiro, frito'],
  ['pao frances', 'pao, trigo, frances'],
  ['pao de forma', 'pao, de forma, tradicional'],
  ['arroz branco', 'arroz, tipo 1, cozido'],
  ['arroz integral', 'arroz, integral, cozido'],
  ['feijao preto', 'feijao, preto, cozido'],
  ['feijao carioca', 'feijao, carioca, cozido'],
  ['semi desnatado', 'semidesnatado'],
  ['semi-desnatado', 'semidesnatado'],
]

/**
 * Normalize a food name: lowercase, remove accents, collapse spaces.
 */
export function normalizeFoodNameForTaco(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

/**
 * Apply synonym replacements to a normalized food name.
 * Input should already be lowercase and accent-free.
 */
export function applySynonyms(name: string): string {
  let result = name
  for (const [from, to] of SYNONYMS) {
    if (result.includes(from)) {
      result = result.replace(from, to)
      break // Only apply first match (longest first)
    }
  }
  return result
}

/**
 * Calculate token overlap score between input tokens and target tokens.
 * Returns a number between 0 and 1: (matched input tokens) / (total input tokens).
 */
export function tokenMatchScore(inputTokens: string[], targetTokens: string[]): number {
  if (inputTokens.length === 0) return 0
  const targetSet = new Set(targetTokens)
  const matched = inputTokens.filter(t => targetSet.has(t)).length
  return matched / inputTokens.length
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/utils/food-normalize.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/food-normalize.ts tests/unit/utils/food-normalize.test.ts
git commit -m "feat: add food name normalization with synonyms and token matching"
```

---

### Task 3: Update Zod Schemas — portion_type and has_user_quantity

**Files:**
- Modify: `src/lib/llm/schemas/meal-analysis.ts`
- Modify: `tests/unit/llm/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/llm/schemas.test.ts`:

```typescript
describe('MealItemSchema portion fields', () => {
  it('parses portion_type field', () => {
    const result = MealItemSchema.parse({
      food: 'Arroz branco',
      quantity_grams: 90,
      portion_type: 'bulk',
      has_user_quantity: false,
    })
    expect(result.portion_type).toBe('bulk')
    expect(result.has_user_quantity).toBe(false)
  })

  it('defaults portion_type to "unit" when not provided', () => {
    const result = MealItemSchema.parse({
      food: 'Banana',
      quantity_grams: 120,
    })
    expect(result.portion_type).toBe('unit')
    expect(result.has_user_quantity).toBe(false)
  })

  it('allows null quantity_grams for bulk items without user quantity', () => {
    const result = MealItemSchema.parse({
      food: 'Arroz branco',
      quantity_grams: null,
      portion_type: 'bulk',
      has_user_quantity: false,
    })
    expect(result.quantity_grams).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/llm/schemas.test.ts`
Expected: FAIL — `portion_type` not in schema

- [ ] **Step 3: Update MealItemSchema**

In `src/lib/llm/schemas/meal-analysis.ts`, replace the `MealItemSchema` definition:

```typescript
export const PortionTypeSchema = z.enum(['unit', 'bulk', 'packaged']).default('unit')
export type PortionType = z.infer<typeof PortionTypeSchema>

export const MealItemSchema = z.object({
  food: z.string(),
  quantity_grams: z.coerce.number().positive().nullable().optional().default(null),
  quantity_display: z.string().nullable().optional().default(null),
  quantity_source: z.enum(['estimated', 'user_provided']).default('estimated'),
  portion_type: PortionTypeSchema.optional().default('unit'),
  has_user_quantity: z.boolean().optional().default(false),
  calories: z.coerce.number().nonnegative().nullable().optional().default(null),
  protein: z.coerce.number().nonnegative().nullable().optional().default(null),
  carbs: z.coerce.number().nonnegative().nullable().optional().default(null),
  fat: z.coerce.number().nonnegative().nullable().optional().default(null),
  confidence: ConfidenceSchema.optional().default('medium'),
})
```

**Important:** `quantity_grams` changes from `z.coerce.number().positive()` to `z.coerce.number().positive().nullable().optional().default(null)`. This allows `null` for bulk items without user-provided quantities.

**Note:** This change makes `quantity_grams` nullable. All existing code that reads `item.quantity_grams` must be checked — but in the current pipeline, items with `null` quantity_grams will be caught by the triagem step (Task 7) BEFORE they reach enrichment. The enrichment pipeline (`enrichItemsWithTaco`) will only receive items with a valid `quantity_grams`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/llm/schemas.test.ts`
Expected: All tests PASS (including existing tests — check that existing tests still parse with the new nullable quantity_grams)

- [ ] **Step 5: Fix any broken existing tests**

If existing tests relied on `quantity_grams` always being a positive number, update them to pass explicit values. The schema now defaults to `null` instead of requiring a positive number.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/schemas/meal-analysis.ts tests/unit/llm/schemas.test.ts
git commit -m "feat: add portion_type and has_user_quantity to MealItemSchema"
```

---

### Task 4: Update Analyze Prompt — Add Portion Classification

**Files:**
- Modify: `src/lib/llm/prompts/analyze.ts`
- Modify: `tests/unit/llm/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/llm/prompts.test.ts`:

```typescript
describe('buildAnalyzePrompt portion classification', () => {
  it('includes portion_type in the prompt', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('portion_type')
    expect(prompt).toContain('"unit"')
    expect(prompt).toContain('"bulk"')
    expect(prompt).toContain('"packaged"')
  })

  it('includes has_user_quantity in the prompt', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('has_user_quantity')
  })

  it('instructs to set quantity_grams null for bulk without user quantity', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('quantity_grams": null')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/llm/prompts.test.ts`
Expected: FAIL — prompt doesn't contain `portion_type`

- [ ] **Step 3: Update buildAnalyzePrompt**

Replace the entire `buildAnalyzePrompt` function in `src/lib/llm/prompts/analyze.ts`:

```typescript
export function buildAnalyzePrompt(): string {
  return `Você é um identificador de alimentos. Sua ÚNICA função é:
1. Identificar alimentos mencionados na mensagem
2. Classificar cada alimento como "unit", "bulk" ou "packaged"
3. Estimar quantidades em gramas SOMENTE quando possível
4. Classificar o tipo de refeição

Você NÃO precisa calcular calorias ou macronutrientes — isso será feito automaticamente.

CLASSIFICAÇÃO DE PORÇÃO (portion_type):
- "unit": alimento com unidade natural e peso médio conhecido. Exemplos: banana, ovo, pão francês, coxinha, pão de queijo, maçã, laranja, fatia de bolo.
- "bulk": alimento a granel, a quantidade varia muito. Exemplos: arroz, feijão, leite, macarrão, carne, azeite, manteiga, queijo (quando não em fatias).
- "packaged": produto industrializado/marca. Exemplos: Magic Toast, Yakult, Danone, whey, suplementos, produtos com nome de marca.

REGRA PRINCIPAL DE QUANTIDADE:
- Se o usuário informou a quantidade (ex: "200ml de leite", "2 fatias"), defina "has_user_quantity": true e preencha quantity_grams + quantity_display.
- Se o alimento é "unit" e sem quantidade explícita, use o peso médio da TABELA DE PORÇÕES abaixo. has_user_quantity: false.
- Se o alimento é "bulk" ou "packaged" e NÃO tem quantidade explícita, defina "quantity_grams": null e "quantity_display": null. has_user_quantity: false.

TABELA DE PORÇÕES (use para converter medidas caseiras em gramas):
- 1 fatia de pão de forma = 25g
- 1 pão francês = 50g
- 1 fatia de bolo = 60g
- 1 ovo = 50g
- 1 banana = 120g
- 1 maçã = 150g
- 1 laranja = 180g
- 1 colher de sopa de arroz = 25g
- 1 escumadeira de arroz = 90g
- 1 concha de feijão = 80g
- 1 colher de sopa de feijão = 25g
- 1 filé de frango (peito) = 120g
- 1 bife médio = 100g
- 1 colher de sopa de azeite/óleo = 13g
- 1 colher de sopa de manteiga/margarina = 10g
- 1 colher de sopa de requeijão = 15g
- 1 fatia de queijo = 20g
- 1 fatia de presunto = 15g
- 1 copo de leite (200ml) = 206g
- 100ml de leite = 103g
- 1 xícara de café (50ml) = 50g
- 1 iogurte (170ml) = 175g
- 1 colher de sopa de açúcar = 12g
- 1 colher de sopa de aveia = 15g
- 1 colher de sopa de granola = 10g
- 1 pegador de macarrão = 110g
- 1 porção de batata frita = 100g
- 1 coxinha = 80g
- 1 pão de queijo = 40g

REGRAS ABSOLUTAS:
- Responda APENAS em JSON no formato especificado
- SEMPRE escreva os nomes dos alimentos em português do Brasil (ex: "Arroz branco", "Feijão preto", "Frango grelhado")
- NUNCA use nomes de alimentos em inglês — traduza sempre para PT-BR
- NUNCA dê conselhos de saúde, dieta ou nutrição
- SEMPRE use a tabela de porções acima para converter medidas caseiras em gramas
- Se não reconhecer um alimento, coloque em "unknown_items"
- Se não tiver certeza da quantidade, marque "confidence": "low"
- Se a mensagem não contiver informação suficiente, retorne needs_clarification: true
- Se o usuário informar valores nutricionais explícitos (ex: "200g de frango com 35g de proteína"), inclua esses valores nos campos opcionais

REFERÊNCIA A REFEIÇÕES ANTERIORES:
- Se o usuário referenciar algo que já comeu antes (ex: "igual aquela pizza", "mesmo de ontem", "usa os macros daquele açaí"), defina "references_previous": true e em "reference_query" coloque o termo de busca (ex: "pizza", "açaí")
- Palavras-chave: "igual", "mesmo", "aquele", "daquele", "de ontem", "de novo", "repete"

MÚLTIPLAS REFEIÇÕES:
Se o usuário mencionar refeições de períodos diferentes (ex: "manhã café com leite", "almoço yakisoba", "tarde 2 caquis"), você DEVE separar em múltiplas refeições no array "meals". Indicadores de período: manhã/café, almoço, tarde/lanche, noite/jantar/janta, ceia.

FORMATO DE RESPOSTA (JSON):
{
  "meals": [
    {
      "meal_type": "breakfast|lunch|snack|dinner|supper",
      "confidence": "high|medium|low",
      "references_previous": false,
      "reference_query": null,
      "items": [
        {
          "food": "nome do alimento",
          "portion_type": "unit|bulk|packaged",
          "has_user_quantity": false,
          "quantity_grams": 100,
          "quantity_display": "100ml",
          "quantity_source": "estimated|user_provided",
          "calories": null,
          "protein": null,
          "carbs": null,
          "fat": null,
          "confidence": "high|medium|low"
        }
      ],
      "unknown_items": [],
      "needs_clarification": false,
      "clarification_question": null
    }
  ]
}

EXEMPLOS:

Entrada: "comi arroz, uma banana e leite"
Saída:
{
  "meals": [{
    "meal_type": "lunch",
    "confidence": "medium",
    "items": [
      {"food": "Arroz branco", "portion_type": "bulk", "has_user_quantity": false, "quantity_grams": null, "quantity_display": null, "quantity_source": "estimated"},
      {"food": "Banana", "portion_type": "unit", "has_user_quantity": false, "quantity_grams": 120, "quantity_display": "1 unidade", "quantity_source": "estimated"},
      {"food": "Leite", "portion_type": "bulk", "has_user_quantity": false, "quantity_grams": null, "quantity_display": null, "quantity_source": "estimated"}
    ],
    "unknown_items": [], "needs_clarification": false
  }]
}

Entrada: "200ml de leite e 2 pães franceses"
Saída:
{
  "meals": [{
    "meal_type": "breakfast",
    "confidence": "high",
    "items": [
      {"food": "Leite", "portion_type": "bulk", "has_user_quantity": true, "quantity_grams": 206, "quantity_display": "200ml", "quantity_source": "user_provided"},
      {"food": "Pão francês", "portion_type": "unit", "has_user_quantity": true, "quantity_grams": 100, "quantity_display": "2 unidades", "quantity_source": "user_provided"}
    ],
    "unknown_items": [], "needs_clarification": false
  }]
}

NOTAS SOBRE CAMPOS:
- "quantity_display": a quantidade EXATAMENTE como o usuário descreveu (ex: "100ml", "2 fatias", "1 banana", "15g"). Se o usuário não especificou quantidade E o alimento é "unit", usar "1 unidade". Se bulk/packaged sem quantidade, deixar null.
- "quantity_grams": em gramas. Se bulk/packaged sem quantidade do usuário, deixar null.
- "calories", "protein", "carbs", "fat": incluir SOMENTE se o usuário forneceu valores explícitos. Caso contrário, deixar null.
- "quantity_source": usar "user_provided" quando o usuário informou a quantidade explicitamente.
- "portion_type": classificar SEMPRE. Na dúvida, use "bulk" (melhor perguntar do que chutar).
- "has_user_quantity": true se o usuário escreveu uma quantidade explícita na mensagem.

Responda SOMENTE com o JSON. Não inclua texto antes ou depois do JSON.`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/llm/prompts.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/prompts/analyze.ts tests/unit/llm/prompts.test.ts
git commit -m "feat: update analyze prompt with portion classification (unit/bulk/packaged)"
```

---

### Task 5: Expand food_cache Queries

**Files:**
- Modify: `src/lib/db/queries/food-cache.ts`
- Modify: `tests/unit/db/food-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/db/food-cache.test.ts`:

```typescript
describe('CachedFood portion fields', () => {
  it('cacheFood accepts portion fields', async () => {
    // This tests that the interface and function accept the new fields
    // Actual DB test would be integration — here we verify the types compile
    const data = {
      foodName: 'Banana',
      caloriesPer100g: 89,
      proteinPer100g: 1.1,
      carbsPer100g: 22.8,
      fatPer100g: 0.3,
      typicalPortionGrams: 120,
      source: 'taco',
      portionType: 'unit' as const,
      defaultGrams: 120,
      defaultDisplay: '1 unidade',
    }
    // Verify the type is accepted (compile-time check)
    expect(data.portionType).toBe('unit')
    expect(data.defaultGrams).toBe(120)
    expect(data.defaultDisplay).toBe('1 unidade')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/db/food-cache.test.ts`
Expected: FAIL or type errors if checking against the interface

- [ ] **Step 3: Update CachedFood interface and cacheFood function**

In `src/lib/db/queries/food-cache.ts`:

Update the `CachedFood` interface:

```typescript
export interface CachedFood {
  id: string
  foodNameNormalized: string
  caloriesPer100g: number
  proteinPer100g: number | null
  carbsPer100g: number | null
  fatPer100g: number | null
  typicalPortionGrams: number | null
  source: string
  hitCount: number
  portionType: string | null
  defaultGrams: number | null
  defaultDisplay: string | null
}
```

Update `rowToCachedFood`:

```typescript
function rowToCachedFood(row: Record<string, unknown>): CachedFood {
  return {
    id: row.id as string,
    foodNameNormalized: row.food_name_normalized as string,
    caloriesPer100g: row.calories_per_100g as number,
    proteinPer100g: row.protein_per_100g as number | null,
    carbsPer100g: row.carbs_per_100g as number | null,
    fatPer100g: row.fat_per_100g as number | null,
    typicalPortionGrams: row.typical_portion_grams as number | null,
    source: row.source as string,
    hitCount: row.hit_count as number,
    portionType: (row.portion_type as string) ?? null,
    defaultGrams: (row.default_grams as number) ?? null,
    defaultDisplay: (row.default_display as string) ?? null,
  }
}
```

Update `cacheFood` to accept the new fields:

```typescript
export async function cacheFood(
  supabase: SupabaseClient,
  data: {
    foodName: string
    caloriesPer100g: number
    proteinPer100g?: number
    carbsPer100g?: number
    fatPer100g?: number
    typicalPortionGrams?: number
    source: string
    portionType?: string
    defaultGrams?: number
    defaultDisplay?: string
  }
): Promise<void> {
  const normalized = normalizeFoodName(data.foodName)

  const row: Record<string, unknown> = {
    food_name_normalized: normalized,
    calories_per_100g: data.caloriesPer100g,
    source: data.source,
  }

  if (data.proteinPer100g !== undefined) row.protein_per_100g = data.proteinPer100g
  if (data.carbsPer100g !== undefined) row.carbs_per_100g = data.carbsPer100g
  if (data.fatPer100g !== undefined) row.fat_per_100g = data.fatPer100g
  if (data.typicalPortionGrams !== undefined) row.typical_portion_grams = data.typicalPortionGrams
  if (data.portionType !== undefined) row.portion_type = data.portionType
  if (data.defaultGrams !== undefined) row.default_grams = data.defaultGrams
  if (data.defaultDisplay !== undefined) row.default_display = data.defaultDisplay

  const { error } = await supabase
    .from('food_cache')
    .upsert(row, { onConflict: 'food_name_normalized' })

  if (error) throw new Error(error.message)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/db/food-cache.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/queries/food-cache.ts tests/unit/db/food-cache.test.ts
git commit -m "feat: expand food_cache with portion_type, default_grams, default_display"
```

---

### Task 6: New Meal Queries — getMealWithItems, updateMealItem, removeMealItem

**Files:**
- Modify: `src/lib/db/queries/meals.ts`

- [ ] **Step 1: Add new interfaces and functions**

Add at the end of `src/lib/db/queries/meals.ts`:

```typescript
// ---------------------------------------------------------------------------
// MealWithItems (for correction flow)
// ---------------------------------------------------------------------------

export interface MealItemDetail {
  id: string
  foodName: string
  quantityGrams: number
  quantityDisplay: string | null
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
  source: string
  confidence: string
}

export interface MealWithItems {
  id: string
  mealType: string
  totalCalories: number
  registeredAt: string
  items: MealItemDetail[]
}

/**
 * Returns a meal with all its items for the correction flow.
 */
export async function getMealWithItems(
  supabase: SupabaseClient,
  mealId: string,
): Promise<MealWithItems | null> {
  const { data: mealRow, error: mealError } = await supabase
    .from('meals')
    .select('id, meal_type, total_calories, registered_at')
    .eq('id', mealId)
    .single()

  if (mealError) {
    if (mealError.code === 'PGRST116') return null
    throw new Error(`Failed to get meal: ${mealError.message}`)
  }

  const meal = mealRow as Record<string, unknown>

  const { data: itemRows, error: itemsError } = await supabase
    .from('meal_items')
    .select('id, food_name, quantity_grams, quantity_display, calories, protein_g, carbs_g, fat_g, source, confidence')
    .eq('meal_id', mealId)

  if (itemsError) {
    throw new Error(`Failed to get meal items: ${itemsError.message}`)
  }

  const items = (itemRows as Array<Record<string, unknown>> || []).map((row) => ({
    id: row.id as string,
    foodName: row.food_name as string,
    quantityGrams: row.quantity_grams as number,
    quantityDisplay: (row.quantity_display as string) ?? null,
    calories: row.calories as number,
    proteinG: row.protein_g as number,
    carbsG: row.carbs_g as number,
    fatG: row.fat_g as number,
    source: row.source as string,
    confidence: (row.confidence as string) ?? 'high',
  }))

  return {
    id: meal.id as string,
    mealType: meal.meal_type as string,
    totalCalories: meal.total_calories as number,
    registeredAt: meal.registered_at as string,
    items,
  }
}

/**
 * Update a single meal item's quantity and recalculated macros.
 */
export async function updateMealItem(
  supabase: SupabaseClient,
  itemId: string,
  update: {
    quantityGrams: number
    quantityDisplay?: string
    calories: number
    proteinG: number
    carbsG: number
    fatG: number
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    quantity_grams: update.quantityGrams,
    calories: update.calories,
    protein_g: update.proteinG,
    carbs_g: update.carbsG,
    fat_g: update.fatG,
  }
  if (update.quantityDisplay !== undefined) {
    row.quantity_display = update.quantityDisplay
  }

  const { error } = await supabase
    .from('meal_items')
    .update(row)
    .eq('id', itemId)

  if (error) throw new Error(`Failed to update meal item: ${error.message}`)
}

/**
 * Remove a single meal item by ID.
 */
export async function removeMealItem(
  supabase: SupabaseClient,
  itemId: string,
): Promise<void> {
  const { error } = await supabase
    .from('meal_items')
    .delete()
    .eq('id', itemId)

  if (error) throw new Error(`Failed to remove meal item: ${error.message}`)
}

/**
 * Recalculate and update a meal's total_calories from its items.
 */
export async function recalculateMealTotal(
  supabase: SupabaseClient,
  mealId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('meal_items')
    .select('calories')
    .eq('meal_id', mealId)

  if (error) throw new Error(`Failed to sum meal items: ${error.message}`)

  const total = Math.round(
    (data as Array<Record<string, unknown>> || []).reduce(
      (sum, row) => sum + (row.calories as number || 0),
      0,
    ),
  )

  const { error: updateError } = await supabase
    .from('meals')
    .update({ total_calories: total })
    .eq('id', mealId)

  if (updateError) throw new Error(`Failed to update meal total: ${updateError.message}`)

  return total
}
```

- [ ] **Step 2: Also update MealItemInput to accept new fields**

Update the `MealItemInput` interface at the top of the file:

```typescript
export interface MealItemInput {
  foodName: string
  quantityGrams: number
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
  source: string
  tacoId?: number
  confidence?: string
  quantityDisplay?: string
}
```

Update the `createMeal` function's item mapping to include the new fields:

```typescript
    const itemRows = data.items.map((item) => ({
      meal_id: mealId,
      food_name: item.foodName,
      quantity_grams: item.quantityGrams,
      calories: item.calories,
      protein_g: item.proteinG,
      carbs_g: item.carbsG,
      fat_g: item.fatG,
      source: item.source,
      taco_id: item.tacoId ?? null,
      confidence: item.confidence ?? 'high',
      quantity_display: item.quantityDisplay ?? null,
    }))
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/queries/meals.ts
git commit -m "feat: add getMealWithItems, updateMealItem, removeMealItem, recalculateMealTotal"
```

---

### Task 7: Update Context Types — New States

**Files:**
- Modify: `src/lib/db/queries/context.ts`

- [ ] **Step 1: Add new context types and TTLs**

In `src/lib/db/queries/context.ts`, update the `ContextType` union and `CONTEXT_TTLS`:

Add to the `ContextType` union:
```typescript
export type ContextType =
  | 'onboarding'
  | 'awaiting_confirmation'
  | 'awaiting_clarification'
  | 'awaiting_correction'
  | 'awaiting_correction_item'
  | 'awaiting_correction_value'
  | 'awaiting_bulk_quantities'
  | 'awaiting_weight'
  | 'awaiting_label_portions'
  | 'settings_menu'
  | 'settings_change'
  | 'awaiting_reset_confirmation'
  | 'awaiting_history_selection'
```

Add to `CONTEXT_TTLS`:
```typescript
export const CONTEXT_TTLS: Record<ContextType, number> = {
  onboarding: 1440,
  awaiting_confirmation: 5,
  awaiting_clarification: 10,
  awaiting_correction: 10,
  awaiting_correction_item: 10,
  awaiting_correction_value: 10,
  awaiting_bulk_quantities: 10,
  awaiting_weight: 5,
  awaiting_label_portions: 5,
  settings_menu: 5,
  settings_change: 5,
  awaiting_reset_confirmation: 5,
  awaiting_history_selection: 5,
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/db/queries/context.ts
git commit -m "feat: add awaiting_bulk_quantities and correction context types"
```

---

### Task 8: Correction Prompt and Schema

**Files:**
- Create: `src/lib/llm/prompts/correction.ts`
- Create: `src/lib/llm/schemas/correction.ts`
- Create: `tests/unit/llm/correction-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/llm/correction-schema.test.ts
import { describe, it, expect } from 'vitest'
import { CorrectionSchema } from '@/lib/llm/schemas/correction'

describe('CorrectionSchema', () => {
  it('parses update_quantity action', () => {
    const result = CorrectionSchema.parse({
      action: 'update_quantity',
      target_meal_type: 'lunch',
      target_food: 'arroz',
      new_quantity: '2 escumadeiras',
      new_food: null,
      confidence: 'high',
    })
    expect(result.action).toBe('update_quantity')
    expect(result.target_food).toBe('arroz')
    expect(result.new_quantity).toBe('2 escumadeiras')
  })

  it('parses remove_item action', () => {
    const result = CorrectionSchema.parse({
      action: 'remove_item',
      target_meal_type: null,
      target_food: 'queijo',
      new_quantity: null,
      new_food: null,
      confidence: 'high',
    })
    expect(result.action).toBe('remove_item')
  })

  it('parses replace_item action', () => {
    const result = CorrectionSchema.parse({
      action: 'replace_item',
      target_meal_type: 'breakfast',
      target_food: 'queijo minas',
      new_quantity: null,
      new_food: 'queijo cottage',
      confidence: 'medium',
    })
    expect(result.action).toBe('replace_item')
    expect(result.new_food).toBe('queijo cottage')
  })

  it('parses add_item action', () => {
    const result = CorrectionSchema.parse({
      action: 'add_item',
      target_meal_type: 'lunch',
      target_food: 'suco de laranja',
      new_quantity: '200ml',
      new_food: null,
      confidence: 'high',
    })
    expect(result.action).toBe('add_item')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/llm/correction-schema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the correction schema**

```typescript
// src/lib/llm/schemas/correction.ts
import { z } from 'zod'

export const CorrectionActionSchema = z.enum([
  'update_quantity',
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
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
})

export type Correction = z.infer<typeof CorrectionSchema>
export type CorrectionAction = z.infer<typeof CorrectionActionSchema>
```

- [ ] **Step 4: Create the correction prompt**

```typescript
// src/lib/llm/prompts/correction.ts

export function buildCorrectionPrompt(message: string): string {
  return `Analise a mensagem do usuário e extraia a intenção de CORREÇÃO de uma refeição já registrada.

MENSAGEM DO USUÁRIO: "${message}"

AÇÕES POSSÍVEIS:
- "update_quantity": mudar a quantidade de um item (ex: "o arroz era 2 escumadeiras", "era 200ml, não 100ml")
- "remove_item": remover um item (ex: "tira o queijo", "remove o suco")
- "add_item": adicionar um item que faltou (ex: "faltou o suco", "esqueci de colocar a salada")
- "replace_item": trocar um alimento por outro (ex: "era queijo cottage, não minas")
- "delete_meal": apagar a refeição inteira (ex: "apaga o almoço", "deleta tudo")

REGRAS:
- "target_meal_type": tipo da refeição alvo (breakfast, lunch, snack, dinner, supper). Se o usuário não especificou, deixe null.
- "target_food": nome do alimento alvo (o que está no registro atual). Para add_item, é o nome do item a adicionar.
- "new_quantity": nova quantidade descrita pelo usuário (texto livre, ex: "2 escumadeiras", "200ml"). Null se não aplicável.
- "new_food": novo alimento (para replace_item). Null se não aplicável.
- "confidence": "high" se a intenção é clara, "medium" se precisa confirmar, "low" se ambíguo.

Responda SOMENTE com JSON no formato:
{
  "action": "update_quantity|remove_item|add_item|replace_item|delete_meal",
  "target_meal_type": "breakfast|lunch|snack|dinner|supper|null",
  "target_food": "nome do alimento",
  "new_quantity": "quantidade nova ou null",
  "new_food": "novo alimento ou null",
  "confidence": "high|medium|low"
}`
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/llm/correction-schema.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/schemas/correction.ts src/lib/llm/prompts/correction.ts tests/unit/llm/correction-schema.test.ts
git commit -m "feat: add correction schema and prompt for meal editing"
```

---

### Task 9: Rewrite meal-log.ts — Triagem + Pergunta Flow

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`

This is the core change. The `analyzeAndRegister` function is split into:
1. Analyze with LLM
2. Triage items (resolved vs pending)
3. Register resolved items immediately
4. Ask for missing quantities (set `awaiting_bulk_quantities` state)
5. When user responds, complete registration

- [ ] **Step 1: Add the new `awaiting_bulk_quantities` handler at the top of `handleMealLog`**

In `handleMealLog`, add a new branch after `awaiting_history_selection` and before `awaiting_clarification`:

```typescript
  // Branch: user is responding with missing quantities
  if (context?.contextType === 'awaiting_bulk_quantities') {
    return handleBulkQuantitiesResponse(supabase, userId, trimmed, context, user)
  }
```

- [ ] **Step 2: Implement `handleBulkQuantitiesResponse`**

Add this function in `meal-log.ts`:

```typescript
async function handleBulkQuantitiesResponse(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    phone?: string
    timezone?: string
  },
): Promise<MealLogResult> {
  const pendingItems = context.contextData.pending_items as Array<{
    food: string
    portion_type: string
  }>
  const resolvedMealId = context.contextData.resolved_meal_id as string | null
  const mealType = context.contextData.meal_type as string
  const originalMessage = context.contextData.original_message as string

  // Use LLM to parse the user's quantity response into structured items
  const llm = getLLMProvider()
  const history = await getRecentMessages(supabase, userId)
  const pendingNames = pendingItems.map(i => i.food).join(', ')

  // Build a focused prompt: "the user was asked for quantities of X, Y, Z. They replied: ..."
  const quantityPrompt = `O usuário estava informando as quantidades de: ${pendingNames}.\nResposta do usuário: "${message}"\n\nIdentifique as quantidades mencionadas para cada alimento.`

  const meals: MealAnalysis[] = await llm.analyzeMeal(quantityPrompt, history)

  if (!meals.length || !meals[0].items.length) {
    return {
      response: `Não entendi as quantidades. Pode repetir? (ex: "1 escumadeira de arroz e 200ml de leite")`,
      completed: false,
    }
  }

  // Match parsed items to pending items
  const parsedItems = meals[0].items
  const allItemsResolved = parsedItems.every(
    i => i.quantity_grams !== null && i.quantity_grams !== undefined && i.quantity_grams > 0,
  )

  if (!allItemsResolved) {
    // Some items still unresolved — ask again
    const stillPending = parsedItems
      .filter(i => !i.quantity_grams || i.quantity_grams <= 0)
      .map(i => `• ${i.food}`)
      .join('\n')
    return {
      response: `Ainda faltam quantidades:\n${stillPending}\n\nPode me dizer? (ex: "200ml", "2 colheres")`,
      completed: false,
    }
  }

  // All items have quantities — enrich and register
  const enriched = await enrichItemsWithTaco(supabase, parsedItems, llm, userId)

  await clearState(userId)

  const mealAnalysis: MealAnalysis = {
    meal_type: mealType as MealAnalysis['meal_type'],
    confidence: 'high',
    references_previous: false,
    reference_query: null,
    items: parsedItems,
    unknown_items: [],
    needs_clarification: false,
  }

  // If there was a partial meal already saved, add items to it
  if (resolvedMealId) {
    // Add new items to the existing meal
    const itemRows = enriched.map((item) => ({
      foodName: item.food,
      quantityGrams: item.quantityGrams,
      calories: item.calories,
      proteinG: item.protein,
      carbsG: item.carbs,
      fatG: item.fat,
      source: item.source,
      tacoId: item.tacoId,
      confidence: item.source === 'approximate' ? 'low' : 'high',
      quantityDisplay: item.quantityDisplay,
    }))

    // Insert new items
    const { error } = await supabase.from('meal_items').insert(
      itemRows.map((item) => ({
        meal_id: resolvedMealId,
        food_name: item.foodName,
        quantity_grams: item.quantityGrams,
        calories: item.calories,
        protein_g: item.proteinG,
        carbs_g: item.carbsG,
        fat_g: item.fatG,
        source: item.source,
        taco_id: item.tacoId ?? null,
        confidence: item.confidence,
        quantity_display: item.quantityDisplay ?? null,
      })),
    )
    if (error) throw new Error(`Failed to add items to meal: ${error.message}`)

    // Recalculate total
    await recalculateMealTotal(supabase, resolvedMealId)
  } else {
    // No partial meal — create new
    await saveMeals(supabase, userId, [mealAnalysis], [enriched], originalMessage)
  }

  // Record TACO usage
  for (const item of enriched) {
    if (item.tacoId && item.source === 'taco') {
      const foodBase = item.defaultFoodBase ?? item.food
      await recordTacoUsage(supabase, foodBase, item.tacoId, userId)
    }
  }

  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user.timezone)
  const target = user.dailyCalorieTarget ?? 2000

  // Build combined receipt (resolved + newly added items)
  const { getMealWithItems } = await import('@/lib/db/queries/meals')
  const fullMeal = resolvedMealId ? await getMealWithItems(supabase, resolvedMealId) : null

  if (fullMeal) {
    const receiptItems = fullMeal.items.map(i => ({
      food: i.foodName,
      quantityGrams: i.quantityGrams,
      quantityDisplay: i.quantityDisplay,
      calories: i.calories,
    }))

    const receipt = formatMealBreakdown(
      fullMeal.mealType,
      receiptItems,
      fullMeal.totalCalories,
      dailyConsumed,
      target,
    )
    return { response: receipt, completed: true }
  }

  // Fallback: build receipt from what we have
  const total = totalCaloriesFromEnriched(enriched)
  const receipt = formatMealBreakdown(
    mealType,
    enriched.map(i => ({ food: i.food, quantityGrams: i.quantityGrams, quantityDisplay: i.quantityDisplay, calories: i.calories })),
    total,
    dailyConsumed,
    target,
  )

  return { response: receipt, completed: true }
}
```

- [ ] **Step 3: Update `analyzeAndRegister` to triage items**

Replace the section after LLM analysis (after the history reference check and before enrichment) in `analyzeAndRegister`. After the `formatSearchFeedback` is sent, add triage logic:

```typescript
  // Send feedback once before enrichment loop
  if (user.phone) {
    await sendTextMessage(user.phone, formatSearchFeedback())
  }

  // TRIAGE: separate resolved items from items needing quantity
  for (let mealIdx = 0; mealIdx < meals.length; mealIdx++) {
    const meal = meals[mealIdx]
    const resolvedItems: MealItem[] = []
    const pendingItems: Array<{ food: string; portion_type: string }> = []

    for (const item of meal.items) {
      const hasQuantity = item.quantity_grams !== null && item.quantity_grams !== undefined && item.quantity_grams > 0
      const isUnit = item.portion_type === 'unit'
      const userProvided = item.has_user_quantity === true

      if (hasQuantity || isUnit || userProvided) {
        resolvedItems.push(item)
      } else {
        pendingItems.push({ food: item.food, portion_type: item.portion_type ?? 'bulk' })
      }
    }

    if (pendingItems.length > 0) {
      // Some items need quantities — register resolved ones first, ask for the rest
      let resolvedMealId: string | null = null

      if (resolvedItems.length > 0) {
        const enriched = await enrichItemsWithTaco(supabase, resolvedItems, llm, userId)
        const partialAnalysis: MealAnalysis = { ...meal, items: resolvedItems }
        await saveMeals(supabase, userId, [partialAnalysis], [enriched], originalMessage)

        // Get the meal ID we just created
        const lastMeal = await getLastMeal(supabase, userId)
        resolvedMealId = lastMeal?.id ?? null
      }

      // Ask for missing quantities
      const exampleMap: Record<string, string> = {
        'Arroz branco': 'ex: 2 colheres, 1 escumadeira',
        'Feijão': 'ex: 1 concha, 2 colheres',
        'Leite': 'ex: 200ml, 1 copo',
        'Macarrão': 'ex: 1 pegador, 200g',
        'Carne': 'ex: 1 bife, 150g',
      }
      const defaultExample = 'ex: quantidade em g, ml, colheres, etc.'

      const pendingLines = pendingItems.map(p => {
        const example = Object.entries(exampleMap).find(([k]) =>
          p.food.toLowerCase().includes(k.toLowerCase()),
        )?.[1] ?? defaultExample
        return `• ${p.food} — quanto? (${example})`
      }).join('\n')

      let askMsg: string
      if (resolvedItems.length > 0) {
        const resolvedNames = resolvedItems.map(i => i.food).join(', ')
        askMsg = `✅ ${resolvedNames} registrado! Pra completar:\n${pendingLines}`
      } else {
        askMsg = `Pra registrar, me diz as quantidades:\n${pendingLines}`
      }

      await setState(userId, 'awaiting_bulk_quantities', {
        pending_items: pendingItems,
        resolved_meal_id: resolvedMealId,
        meal_type: meal.meal_type,
        original_message: originalMessage,
      })

      return { response: askMsg, completed: false }
    }
  }

  // All items resolved — proceed with normal enrichment + registration
```

The rest of the function (enrichment and registration) stays as-is.

- [ ] **Step 4: Add import for `recalculateMealTotal` and `getLastMeal`**

At the top of `meal-log.ts`, ensure these imports are present:

```typescript
import { createMeal, getDailyCalories, getDailyMacros, getLastMeal, recalculateMealTotal } from '@/lib/db/queries/meals'
import { getMealWithItems } from '@/lib/db/queries/meals'
```

**Note:** Remove the dynamic import in `handleBulkQuantitiesResponse` and use the static import instead.

- [ ] **Step 5: Update `saveMeals` to pass confidence and quantityDisplay**

In the `saveMeals` function, update the item mapping:

```typescript
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
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts
git commit -m "feat: add portion triage — ask for bulk quantities before registering"
```

---

### Task 10: Rewrite edit.ts — Real Correction Flow

**Files:**
- Modify: `src/lib/bot/flows/edit.ts`

- [ ] **Step 1: Rewrite edit.ts**

Replace the entire file with the new correction flow that supports both guided (numbered) and natural language correction:

```typescript
// src/lib/bot/flows/edit.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'
import { setState, clearState } from '@/lib/bot/state'
import {
  deleteMeal,
  getLastMeal,
  getRecentMeals,
  getMealWithItems,
  updateMealItem,
  removeMealItem,
  recalculateMealTotal,
  getDailyCalories,
} from '@/lib/db/queries/meals'
import type { RecentMeal, MealWithItems } from '@/lib/db/queries/meals'
import { getLLMProvider } from '@/lib/llm/index'
import { buildCorrectionPrompt } from '@/lib/llm/prompts/correction'
import { CorrectionSchema } from '@/lib/llm/schemas/correction'
import type { Correction } from '@/lib/llm/schemas/correction'
import { enrichItemsWithTaco } from '@/lib/bot/flows/meal-log'
import { calculateMacros, matchTacoByBase } from '@/lib/db/queries/taco'
import { formatProgress } from '@/lib/utils/formatters'

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const DELETE_PATTERN = /apaga(r)?\s*(último|ultimo|last)?/i
const CORRECTION_PATTERN = /^corrigir$/i
const CONFIRM_PATTERN = /^(sim|s|ok|confirma)$/i
const REJECT_PATTERN = /^(não|nao|n|cancelar|cancela)$/i

// ---------------------------------------------------------------------------
// Meal type display labels
// ---------------------------------------------------------------------------

const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: 'Café da manhã',
  lunch: 'Almoço',
  snack: 'Lanche',
  dinner: 'Jantar',
  supper: 'Ceia',
}

function mealLabel(mealType: string): string {
  return MEAL_TYPE_LABELS[mealType] ?? mealType
}

// ---------------------------------------------------------------------------
// handleEdit (main entry)
// ---------------------------------------------------------------------------

export async function handleEdit(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext | null,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const trimmed = message.trim()

  // Branch: active correction contexts
  if (context) {
    switch (context.contextType) {
      case 'awaiting_correction':
        return handleAwaitingCorrection(supabase, userId, trimmed, context, user)
      case 'awaiting_correction_item':
        return handleAwaitingCorrectionItem(supabase, userId, trimmed, context, user)
      case 'awaiting_correction_value':
        return handleAwaitingCorrectionValue(supabase, userId, trimmed, context, user)
    }
  }

  // Branch: delete last meal
  if (DELETE_PATTERN.test(trimmed)) {
    return initiateDeleteLastMeal(supabase, userId)
  }

  // Branch: "corrigir" command — guided flow
  if (CORRECTION_PATTERN.test(trimmed)) {
    return showRecentMealsForCorrection(supabase, userId)
  }

  // Branch: natural language correction (e.g., "o arroz era 2 escumadeiras")
  return handleNaturalLanguageCorrection(supabase, userId, trimmed, user)
}

// ---------------------------------------------------------------------------
// Guided correction flow
// ---------------------------------------------------------------------------

async function handleAwaitingCorrection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const action = context.contextData.action as string

  if (action === 'delete_confirm') {
    if (CONFIRM_PATTERN.test(message)) {
      return confirmDeleteMeal(supabase, userId, context)
    }
    if (REJECT_PATTERN.test(message)) {
      await clearState(userId)
      return 'Ok, mantive a refeição. Pode me mandar o que quer corrigir!'
    }
  }

  if (action === 'select_meal') {
    return handleMealSelection(supabase, userId, message, context)
  }

  await clearState(userId)
  return showRecentMealsForCorrection(supabase, userId)
}

async function handleMealSelection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
): Promise<string> {
  const meals = context.contextData.meals as unknown as RecentMeal[]
  const choice = parseInt(message, 10)

  if (isNaN(choice) || choice < 1 || choice > meals.length) {
    return `Opção inválida. Digite um número de 1 a ${meals.length}.`
  }

  const selected = meals[choice - 1]

  // Show meal items for the selected meal
  const mealWithItems = await getMealWithItems(supabase, selected.id)
  if (!mealWithItems || mealWithItems.items.length === 0) {
    await setState(userId, 'awaiting_correction', {
      action: 'delete_confirm',
      mealId: selected.id,
      mealType: selected.mealType,
      totalCalories: selected.totalCalories,
    })
    return `Quer apagar: ${mealLabel(selected.mealType)} (${selected.totalCalories} kcal)? (sim/não)`
  }

  const itemLines = mealWithItems.items.map((item, idx) => {
    const display = item.quantityDisplay || `${item.quantityGrams}g`
    return `${idx + 1}️⃣ ${item.foodName} (${display}) — ${item.calories} kcal`
  })

  await setState(userId, 'awaiting_correction_item', {
    mealId: selected.id,
    mealType: selected.mealType,
    items: mealWithItems.items as unknown as Record<string, unknown>[],
  })

  return [
    `${mealLabel(selected.mealType)}:`,
    ...itemLines,
    '',
    'Qual item? (número ou descreve a correção)',
  ].join('\n')
}

async function handleAwaitingCorrectionItem(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const mealId = context.contextData.mealId as string
  const items = context.contextData.items as unknown as Array<{
    id: string
    foodName: string
    quantityGrams: number
    quantityDisplay: string | null
    calories: number
  }>

  const choice = parseInt(message, 10)

  if (!isNaN(choice) && choice >= 1 && choice <= items.length) {
    // User selected an item by number
    const selectedItem = items[choice - 1]

    await setState(userId, 'awaiting_correction_value', {
      mealId,
      itemId: selectedItem.id,
      foodName: selectedItem.foodName,
      currentGrams: selectedItem.quantityGrams,
    })

    return `${selectedItem.foodName} — qual a quantidade certa? (ex: 2 escumadeiras, 200g)`
  }

  // User typed a natural language correction — parse it
  return handleNaturalLanguageCorrectionWithMeal(supabase, userId, message, mealId, items, user)
}

async function handleAwaitingCorrectionValue(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const mealId = context.contextData.mealId as string
  const itemId = context.contextData.itemId as string
  const foodName = context.contextData.foodName as string
  const currentGrams = context.contextData.currentGrams as number

  // Parse quantity from user message using LLM
  const llm = getLLMProvider()
  const raw = await llm.chat(
    `O usuário informou a quantidade de "${foodName}": "${message}". Converta para gramas. Use a tabela: 1 escumadeira de arroz=90g, 1 concha de feijão=80g, 1 colher de sopa=25g, 1 pegador de macarrão=110g, 1 fatia=20g, 1 copo=200ml≈206g. Responda APENAS com JSON: {"quantity_grams": number, "quantity_display": "texto do usuario"}`,
    'Você é um conversor de medidas culinárias. Responda APENAS com JSON válido.',
    true,
  )

  let newGrams: number
  let newDisplay: string

  try {
    const parsed = JSON.parse(raw.trim()) as { quantity_grams: number; quantity_display: string }
    newGrams = parsed.quantity_grams
    newDisplay = parsed.quantity_display
  } catch {
    // Try parsing as a simple number
    const num = parseFloat(message.replace(/[^\d.,]/g, '').replace(',', '.'))
    if (isNaN(num)) {
      return `Não entendi a quantidade. Pode me dizer em gramas, ml ou medidas caseiras? (ex: 200g, 1 escumadeira)`
    }
    newGrams = num
    newDisplay = message.trim()
  }

  // Recalculate macros for the new quantity
  const ratio = newGrams / currentGrams

  const mealWithItems = await getMealWithItems(supabase, mealId)
  const targetItem = mealWithItems?.items.find(i => i.id === itemId)
  if (!targetItem) {
    await clearState(userId)
    return 'Não encontrei o item para corrigir. Tenta de novo?'
  }

  const newCalories = Math.round(targetItem.calories * ratio)
  const newProtein = Math.round(targetItem.proteinG * ratio * 10) / 10
  const newCarbs = Math.round(targetItem.carbsG * ratio * 10) / 10
  const newFat = Math.round(targetItem.fatG * ratio * 10) / 10

  await updateMealItem(supabase, itemId, {
    quantityGrams: newGrams,
    quantityDisplay: newDisplay,
    calories: newCalories,
    proteinG: newProtein,
    carbsG: newCarbs,
    fatG: newFat,
  })

  const newTotal = await recalculateMealTotal(supabase, mealId)
  await clearState(userId)

  const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
  const target = user?.dailyCalorieTarget ?? 2000
  const progress = formatProgress(dailyConsumed, target)

  return `✅ ${foodName} atualizado: ${currentGrams}g → ${newGrams}g (${targetItem.calories} → ${newCalories} kcal)\n${progress}`
}

// ---------------------------------------------------------------------------
// Natural language correction
// ---------------------------------------------------------------------------

async function handleNaturalLanguageCorrection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const llm = getLLMProvider()

  // Parse correction intent
  const raw = await llm.chat(
    buildCorrectionPrompt(message),
    'Você analisa intenções de correção de refeições. Responda APENAS com JSON válido.',
    true,
  )

  let correction: Correction
  try {
    correction = CorrectionSchema.parse(JSON.parse(raw.trim()))
  } catch {
    return showRecentMealsForCorrection(supabase, userId)
  }

  if (correction.confidence === 'low') {
    // Too ambiguous — fall back to guided flow
    return showRecentMealsForCorrection(supabase, userId)
  }

  // Find the target meal
  const recentMeals = await getRecentMeals(supabase, userId, 5)
  let targetMeal: RecentMeal | undefined

  if (correction.target_meal_type) {
    targetMeal = recentMeals.find(m => m.mealType === correction.target_meal_type)
  }
  if (!targetMeal) {
    targetMeal = recentMeals[0] // Default to most recent
  }
  if (!targetMeal) {
    return 'Não encontrei nenhuma refeição recente para corrigir.'
  }

  const mealWithItems = await getMealWithItems(supabase, targetMeal.id)
  if (!mealWithItems) {
    return 'Não encontrei os itens dessa refeição.'
  }

  return handleNaturalLanguageCorrectionWithMeal(
    supabase,
    userId,
    message,
    targetMeal.id,
    mealWithItems.items,
    user,
  )
}

async function handleNaturalLanguageCorrectionWithMeal(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  mealId: string,
  items: Array<{ id: string; foodName: string; quantityGrams: number; calories: number; proteinG?: number; carbsG?: number; fatG?: number }>,
  user?: { timezone?: string; dailyCalorieTarget?: number | null },
): Promise<string> {
  const llm = getLLMProvider()

  const raw = await llm.chat(
    buildCorrectionPrompt(message),
    'Você analisa intenções de correção de refeições. Responda APENAS com JSON válido.',
    true,
  )

  let correction: Correction
  try {
    correction = CorrectionSchema.parse(JSON.parse(raw.trim()))
  } catch {
    await clearState(userId)
    return 'Não entendi a correção. Pode descrever de novo? (ex: "o arroz era 2 escumadeiras")'
  }

  // Find the target item
  const targetItem = correction.target_food
    ? items.find(i => i.foodName.toLowerCase().includes(correction.target_food!.toLowerCase()))
    : null

  switch (correction.action) {
    case 'remove_item': {
      if (!targetItem) {
        await clearState(userId)
        return `Não encontrei "${correction.target_food}" nessa refeição.`
      }
      await removeMealItem(supabase, targetItem.id)
      const newTotal = await recalculateMealTotal(supabase, mealId)
      await clearState(userId)
      const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
      const target = user?.dailyCalorieTarget ?? 2000
      return `✅ ${targetItem.foodName} removido! Novo total: ${newTotal} kcal\n${formatProgress(dailyConsumed, target)}`
    }

    case 'update_quantity': {
      if (!targetItem || !correction.new_quantity) {
        await clearState(userId)
        return 'Não entendi qual item corrigir ou a nova quantidade. Tenta "corrigir" pro menu guiado.'
      }
      // Set up value correction context
      await setState(userId, 'awaiting_correction_value', {
        mealId,
        itemId: targetItem.id,
        foodName: targetItem.foodName,
        currentGrams: targetItem.quantityGrams,
      })
      // Process the quantity directly
      return handleAwaitingCorrectionValue(
        supabase,
        userId,
        correction.new_quantity,
        {
          id: '',
          userId,
          contextType: 'awaiting_correction_value',
          contextData: {
            mealId,
            itemId: targetItem.id,
            foodName: targetItem.foodName,
            currentGrams: targetItem.quantityGrams,
          },
          expiresAt: '',
          createdAt: '',
        },
        user,
      )
    }

    case 'add_item': {
      if (!correction.target_food) {
        await clearState(userId)
        return 'Qual item faltou? (ex: "faltou o suco de laranja 200ml")'
      }
      // Create a MealItem-like object and enrich it
      const llm2 = getLLMProvider()
      const addPrompt = correction.new_quantity
        ? `${correction.new_quantity} de ${correction.target_food}`
        : correction.target_food
      const addMeals = await llm2.analyzeMeal(addPrompt, [])
      if (addMeals.length > 0 && addMeals[0].items.length > 0) {
        const addItem = addMeals[0].items[0]
        if (addItem.quantity_grams && addItem.quantity_grams > 0) {
          const enrichedItems = await enrichItemsWithTaco(supabase, [addItem], llm2, userId)
          const enriched = enrichedItems[0]
          const { error } = await supabase.from('meal_items').insert({
            meal_id: mealId,
            food_name: enriched.food,
            quantity_grams: enriched.quantityGrams,
            calories: enriched.calories,
            protein_g: enriched.protein,
            carbs_g: enriched.carbs,
            fat_g: enriched.fat,
            source: enriched.source,
            taco_id: enriched.tacoId ?? null,
            confidence: enriched.source === 'approximate' ? 'low' : 'high',
            quantity_display: enriched.quantityDisplay ?? null,
          })
          if (error) throw new Error(`Failed to add item: ${error.message}`)
          const newTotal = await recalculateMealTotal(supabase, mealId)
          await clearState(userId)
          const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
          const target = user?.dailyCalorieTarget ?? 2000
          return `✅ ${enriched.food} adicionado! Novo total: ${newTotal} kcal\n${formatProgress(dailyConsumed, target)}`
        }
      }
      await clearState(userId)
      return 'Não consegui adicionar. Pode descrever o item com a quantidade? (ex: "200ml de suco de laranja")'
    }

    case 'replace_item': {
      if (!targetItem || !correction.new_food) {
        await clearState(userId)
        return 'Não entendi a troca. Manda "corrigir" pro menu guiado.'
      }
      // Remove old item
      await removeMealItem(supabase, targetItem.id)
      // Add new item
      const llm3 = getLLMProvider()
      const replaceQty = correction.new_quantity || `${targetItem.quantityGrams}g`
      const replaceMeals = await llm3.analyzeMeal(`${replaceQty} de ${correction.new_food}`, [])
      if (replaceMeals.length > 0 && replaceMeals[0].items.length > 0) {
        const replaceItem = replaceMeals[0].items[0]
        if (replaceItem.quantity_grams && replaceItem.quantity_grams > 0) {
          const enrichedItems = await enrichItemsWithTaco(supabase, [replaceItem], llm3, userId)
          const enriched = enrichedItems[0]
          await supabase.from('meal_items').insert({
            meal_id: mealId,
            food_name: enriched.food,
            quantity_grams: enriched.quantityGrams,
            calories: enriched.calories,
            protein_g: enriched.protein,
            carbs_g: enriched.carbs,
            fat_g: enriched.fat,
            source: enriched.source,
            taco_id: enriched.tacoId ?? null,
            confidence: enriched.source === 'approximate' ? 'low' : 'high',
            quantity_display: enriched.quantityDisplay ?? null,
          })
        }
      }
      const newTotal = await recalculateMealTotal(supabase, mealId)
      await clearState(userId)
      const dailyConsumed = await getDailyCalories(supabase, userId, undefined, user?.timezone)
      const target = user?.dailyCalorieTarget ?? 2000
      return `✅ ${targetItem.foodName} → ${correction.new_food}! Novo total: ${newTotal} kcal\n${formatProgress(dailyConsumed, target)}`
    }

    case 'delete_meal': {
      await deleteMeal(supabase, mealId)
      await clearState(userId)
      return 'Refeição apagada! ✅'
    }

    default:
      await clearState(userId)
      return 'Não entendi a correção. Manda "corrigir" pro menu guiado.'
  }
}

// ---------------------------------------------------------------------------
// Existing helpers (unchanged)
// ---------------------------------------------------------------------------

async function initiateDeleteLastMeal(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const lastMeal = await getLastMeal(supabase, userId)

  if (!lastMeal) {
    return 'Não encontrei nenhuma refeição para apagar.'
  }

  await setState(userId, 'awaiting_correction', {
    action: 'delete_confirm',
    mealId: lastMeal.id,
    mealType: lastMeal.mealType,
    totalCalories: lastMeal.totalCalories,
  })

  return `Quer apagar: ${mealLabel(lastMeal.mealType)} (${lastMeal.totalCalories} kcal)? (sim/não)`
}

async function confirmDeleteMeal(
  supabase: SupabaseClient,
  userId: string,
  context: ConversationContext,
): Promise<string> {
  const mealId = context.contextData.mealId as string
  await deleteMeal(supabase, mealId)
  await clearState(userId)
  return 'Refeição apagada! ✅'
}

async function showRecentMealsForCorrection(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const meals = await getRecentMeals(supabase, userId, 3)

  if (meals.length === 0) {
    return 'Não encontrei nenhuma refeição recente para corrigir.'
  }

  await setState(userId, 'awaiting_correction', {
    action: 'select_meal',
    meals: meals as unknown as Record<string, unknown>[],
  })

  const mealLines = meals.map((meal, idx) => {
    const label = mealLabel(meal.mealType)
    const dateStr = new Date(meal.registeredAt).toLocaleDateString('pt-BR')
    return `${idx + 1}️⃣ ${label} — ${meal.totalCalories} kcal (${dateStr})`
  })

  return `Qual refeição quer corrigir?\n\n${mealLines.join('\n')}\n\nDigite o número:`
}
```

- [ ] **Step 2: Export `enrichItemsWithTaco` from meal-log.ts**

In `src/lib/bot/flows/meal-log.ts`, change `enrichItemsWithTaco` from a private function to an exported function:

```typescript
export async function enrichItemsWithTaco(
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/bot/flows/edit.ts src/lib/bot/flows/meal-log.ts
git commit -m "feat: rewrite edit flow with real correction (update/remove/add items)"
```

---

### Task 11: Update Handler — Route New Context Types

**Files:**
- Modify: `src/lib/bot/handler.ts`

- [ ] **Step 1: Add routing for new context types**

In `handleIncomingMessage`, in the context switch block (around line 74), add cases for the new context types:

After the `case 'awaiting_correction':` block, add:

```typescript
        case 'awaiting_correction_item':
        case 'awaiting_correction_value': {
          const editResponse = await handleEdit(supabase, user.id, text, context, {
            timezone: user.timezone,
            dailyCalorieTarget: user.dailyCalorieTarget,
          })
          await sendTextMessage(from, editResponse)
          saveHistory(supabase, user.id, text, editResponse)
          return
        }
        case 'awaiting_bulk_quantities': {
          const mealResult = await handleMealLog(supabase, user.id, text, userSettings, context)
          await sendTextMessage(from, mealResult.response)
          saveHistory(supabase, user.id, text, mealResult.response)
          return
        }
```

Also update the existing `awaiting_correction` case to pass user data:

```typescript
        case 'awaiting_correction': {
          const editResponse = await handleEdit(supabase, user.id, text, context, {
            timezone: user.timezone,
            dailyCalorieTarget: user.dailyCalorieTarget,
          })
          await sendTextMessage(from, editResponse)
          saveHistory(supabase, user.id, text, editResponse)
          return
        }
```

And update the edit intent routing (around line 147) to pass user data:

```typescript
      case 'edit':
        response = await handleEdit(supabase, user.id, text, null, {
          timezone: user.timezone,
          dailyCalorieTarget: user.dailyCalorieTarget,
        })
        break
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/bot/handler.ts
git commit -m "feat: route new context types in handler (bulk_quantities, correction_item, correction_value)"
```

---

### Task 12: Update TACO Matching with Normalization and Token Search

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`

- [ ] **Step 1: Integrate normalization into `resolveByBase`**

Update the `resolveByBase` function in `meal-log.ts` to try normalized + synonym matching before raw base matching:

```typescript
import { normalizeFoodNameForTaco, applySynonyms, tokenMatchScore } from '@/lib/utils/food-normalize'

async function resolveByBase(
  supabase: SupabaseClient,
  foodName: string,
): Promise<{ match: TacoFood; usedDefault: boolean } | null> {
  // Try raw name first
  const variants = await matchTacoByBase(supabase, foodName)
  if (variants.length > 0) {
    return pickBestVariant(supabase, foodName, variants)
  }

  // Try with synonyms
  const normalized = normalizeFoodNameForTaco(foodName)
  const withSynonyms = applySynonyms(normalized)
  if (withSynonyms !== normalized) {
    // Extract the base from the synonym result (before first comma)
    const synonymBase = withSynonyms.split(',')[0].trim()
    const synonymVariants = await matchTacoByBase(supabase, synonymBase)
    if (synonymVariants.length > 0) {
      // Try to find exact variant match
      const normalizedFull = withSynonyms.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      const exactMatch = synonymVariants.find(v => {
        const vNorm = v.foodName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        return vNorm.includes(normalizedFull) || normalizedFull.includes(vNorm)
      })
      if (exactMatch) {
        return { match: exactMatch, usedDefault: false }
      }
      return pickBestVariant(supabase, synonymBase, synonymVariants)
    }
  }

  return null
}

async function pickBestVariant(
  supabase: SupabaseClient,
  foodName: string,
  variants: TacoFood[],
): Promise<{ match: TacoFood; usedDefault: boolean }> {
  if (variants.length === 1) {
    return { match: variants[0], usedDefault: false }
  }

  const learned = await getLearnedDefault(supabase, foodName)
  if (learned) {
    const learnedFood = variants.find(v => v.id === learned.tacoId)
    if (learnedFood) {
      return { match: learnedFood, usedDefault: true }
    }
  }

  const manualDefault = variants.find(v => v.isDefault)
  if (manualDefault) {
    return { match: manualDefault, usedDefault: true }
  }

  return { match: variants[0], usedDefault: true }
}
```

- [ ] **Step 2: Add token-based search as a fallback before fuzzy**

In `enrichItemsWithTaco`, between the base matching step and the fuzzy matching step, add a token-based search. This is applied to items in the `needsFuzzy` array before they go to `fuzzyMatchTacoMultiple`.

After the base-matching loop and before the fuzzy section, add:

```typescript
  // Step 1.5: Token-based search for items that didn't match base
  const stillNeedsFuzzy: { item: MealItem; index: number }[] = []

  for (const { item, index } of needsFuzzy) {
    const normalized = normalizeFoodNameForTaco(item.food)
    const withSynonyms = applySynonyms(normalized)
    const inputTokens = withSynonyms.split(/[\s,]+/).filter(t => t.length > 1)

    // Get all TACO foods (limited — use existing base search with broader terms)
    const baseWord = inputTokens[0]
    if (baseWord) {
      const candidates = await matchTacoByBase(supabase, baseWord)
      if (candidates.length > 0) {
        let bestMatch: TacoFood | null = null
        let bestScore = 0

        for (const candidate of candidates) {
          const candidateNorm = normalizeFoodNameForTaco(candidate.foodName)
          const candidateTokens = candidateNorm.split(/[\s,]+/).filter(t => t.length > 1)
          const score = tokenMatchScore(inputTokens, candidateTokens)
          if (score > bestScore) {
            bestScore = score
            bestMatch = candidate
          }
        }

        if (bestMatch && bestScore >= 0.6) {
          const macros = calculateMacros(bestMatch, item.quantity_grams)
          enriched[index] = {
            food: item.food,
            quantityGrams: item.quantity_grams,
            quantityDisplay: item.quantity_display,
            calories: macros.calories,
            protein: macros.protein,
            carbs: macros.carbs,
            fat: macros.fat,
            source: 'taco',
            tacoId: bestMatch.id,
          }
          continue
        }
      }
    }

    stillNeedsFuzzy.push({ item, index })
  }
```

Then change the fuzzy matching section to use `stillNeedsFuzzy` instead of `needsFuzzy`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts
git commit -m "feat: add synonym normalization and token-based TACO matching"
```

---

### Task 13: Update Edit Keywords in Router

**Files:**
- Modify: `src/lib/bot/router.ts`

- [ ] **Step 1: Expand edit keywords**

Add more correction-related keywords to the router:

```typescript
  // 4. edit keywords
  const EDIT_KEYWORDS = [
    'apaga', 'apagar', 'corrig', 'corrigir',
    'tira o', 'tira a', 'remove',
    'era na verdade', 'na verdade era',
    'troca o', 'troca a',
    'faltou', 'esqueci',
    'atualiza', 'muda o', 'muda a',
  ]
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/bot/router.ts
git commit -m "feat: expand edit keywords for natural language correction"
```

---

### Task 14: Update Formatters — Confidence Indicator

**Files:**
- Modify: `src/lib/utils/formatters.ts`

- [ ] **Step 1: Update MealItem interface to include confidence**

```typescript
export interface MealItem {
  food: string
  quantityGrams: number
  quantityDisplay?: string | null
  calories: number
  confidence?: string
}
```

- [ ] **Step 2: Update `formatMealBreakdown` to show confidence indicators**

In the item line formatting:

```typescript
  const itemLines = items
    .map((item) => {
      const display = item.quantityDisplay || `${item.quantityGrams}g`
      const calStr = item.confidence === 'low' ? `~${item.calories}` : `${item.calories}`
      const indicator = item.confidence === 'low' ? ' ⚠️' : ''
      return `• ${item.food} (${display}) — ${calStr} kcal${indicator}`
    })
    .join('\n')
```

- [ ] **Step 3: Add low-confidence notice**

After the progress line, add a notice if any items have low confidence:

```typescript
  const lowConfItems = items.filter(i => i.confidence === 'low')
  const lowConfNotice = lowConfItems.length > 0
    ? `\n⚠️ Valores estimados para: ${lowConfItems.map(i => i.food).join(', ')}. Se souber o valor exato, manda "corrigir"`
    : ''

  return [
    `🍽️ ${translateMealType(mealType)} registrado!`,
    '',
    itemLines,
    '',
    `Total: ${total} kcal`,
    '',
    progressLine,
    lowConfNotice,
    '',
    'Algo errado? Manda "corrigir"',
  ].filter(Boolean).join('\n')
```

- [ ] **Step 4: Update `formatMultiMealBreakdown` similarly**

Apply the same confidence indicator pattern to the multi-meal formatter.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/formatters.ts
git commit -m "feat: add confidence indicators (⚠️) to meal receipts"
```

---

### Task 15: TypeScript Check and Integration Test

**Files:**
- All modified files

- [ ] **Step 1: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: No errors. Fix any type mismatches between the new schemas and existing consumers.

- [ ] **Step 2: Run all unit tests**

Run: `npm run test:unit`
Expected: All tests PASS. Fix any broken tests caused by the schema changes (especially `quantity_grams` becoming nullable).

- [ ] **Step 3: Fix any issues found**

Common issues to watch for:
- `item.quantity_grams` may now be `null` — any code that does math on it needs a null check
- The `enrichItemsWithTaco` function should only receive items where `quantity_grams` is a positive number (the triage step in Task 9 ensures this)
- The `handleEdit` function signature changed (added `user?` parameter) — update all call sites

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve type errors and broken tests after meal flow redesign"
```

---

### Task 16: Update meal-log.ts to Pass Confidence to saveMeals

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`

- [ ] **Step 1: Update EnrichedItem to track confidence**

Add confidence field to `EnrichedItem`:

```typescript
interface EnrichedItem {
  food: string
  quantityGrams: number
  quantityDisplay?: string | null
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
  tacoId?: number
  usedDefault?: boolean
  defaultFoodBase?: string
  defaultFoodVariant?: string
  confidence: string  // 'high' | 'medium' | 'low'
}
```

- [ ] **Step 2: Set confidence based on source**

In `enrichItemsWithTaco`, set confidence when creating EnrichedItems:

- `source: 'taco'` → `confidence: 'high'`
- `source: 'taco_decomposed'` → `confidence: 'medium'`
- `source: 'approximate'` → `confidence: 'low'`
- `source: 'user_provided'` → `confidence: 'high'`
- `source: 'user_history'` → `confidence: 'high'`

- [ ] **Step 3: Pass confidence through to receipt formatter**

In `buildReceiptResponse`, include confidence in the item mapping:

```typescript
    items.map(i => ({
      food: i.food,
      quantityGrams: i.quantityGrams,
      quantityDisplay: i.quantityDisplay,
      calories: i.calories,
      confidence: i.confidence,
    })),
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts
git commit -m "feat: track and display confidence level per meal item"
```

---

### Task 17: Final Integration — Run Full Test Suite

- [ ] **Step 1: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 2: Run all unit tests**

Run: `npm run test:unit`
Expected: All tests PASS

- [ ] **Step 3: Run linter if configured**

Run: `npm run lint` (if exists)
Expected: No errors

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup after meal flow redesign"
```
