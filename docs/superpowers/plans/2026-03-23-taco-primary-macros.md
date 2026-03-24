# TACO Primary Macros Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TACO table (581 Brazilian foods) the primary source of macronutrients, with the LLM only identifying foods and estimating portions.

**Architecture:** LLM identifies foods + estimates grams → backend fuzzy-matches against `taco_foods` via `pg_trgm` → if no match, LLM decomposes into ingredients → each ingredient matched against TACO → fallback to LLM estimate if all else fails.

**Tech Stack:** TypeScript, Supabase (Postgres + pg_trgm), Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-taco-primary-macros-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/lib/db/queries/taco.ts` | Fuzzy match queries against `taco_foods` |
| Create | `src/lib/llm/prompts/analyze.ts` | Unified meal analysis prompt (replaces approximate.ts + taco.ts) |
| Create | `src/lib/llm/prompts/decompose.ts` | Decomposition prompt for composite foods |
| Create | `src/lib/llm/schemas/decomposition.ts` | Zod schema for decomposition results |
| Create | `supabase/migrations/00008_taco_primary_macros.sql` | pg_trgm, source enum expansion, calorie_mode migration |
| Create | `tests/unit/db/taco.test.ts` | Fuzzy match unit tests |
| Modify | `src/lib/llm/schemas/meal-analysis.ts` | Make macros optional, add `references_previous` |
| Modify | `src/lib/llm/schemas/common.ts` | Remove `approximate` from `CalorieModeSchema` |
| Modify | `src/lib/llm/provider.ts` | Add `decomposeMeal`, simplify `analyzeMeal` signature |
| Modify | `src/lib/llm/providers/openrouter.ts` | Implement new interface, use unified prompt |
| Modify | `src/lib/llm/providers/ollama.ts` | Implement new interface, use unified prompt |
| Modify | `src/lib/llm/index.ts` | Add `decomposeMeal` to fallback proxy |
| Modify | `src/lib/bot/flows/meal-log.ts` | TACO lookup + decomposition orchestration |
| Modify | `src/lib/bot/flows/query.ts` | Use TACO pipeline instead of hardcoded approximate |
| Modify | `src/lib/bot/flows/settings.ts` | Remove approximate option from calorie mode menu |
| Modify | `src/lib/bot/flows/onboarding.ts` | Remove approximate option from onboarding step 8 |
| Modify | `src/lib/db/queries/context.ts` | Add `awaiting_history_selection` state |
| Modify | `src/lib/utils/validators.ts` | Update `validateCalorieMode` to 2 options |
| Modify | `src/lib/utils/formatters.ts` | Add decomposition feedback message formatter |
| Modify | `src/lib/llm/prompts/vision.ts` | Remove TACO context injection (backend handles it) |
| Modify | `scripts/seed-taco.ts` | Replace with 581 foods from extracted JSON |
| Delete | `src/lib/llm/prompts/approximate.ts` | Replaced by `analyze.ts` |
| Delete | `src/lib/llm/prompts/taco.ts` | Replaced by `analyze.ts` (keep `TacoFood` type in db/queries/taco.ts) |
| Modify | `src/lib/bot/handler.ts` | Pass `phone` to `handleMealLog` |
| Modify | `src/lib/db/queries/food-cache.ts` | Repurpose for decomposition cache |
| Create | `src/lib/db/queries/meal-history-search.ts` | Search user's meal history for reuse |
| Modify | `tests/unit/bot/meal-log.test.ts` | Update for TACO lookup flow |
| Modify | `tests/unit/llm/openrouter.test.ts` | Update for new interface |
| Modify | `tests/unit/llm/ollama.test.ts` | Update for new interface |

---

## Task 1: Database Migration — pg_trgm, source enum, calorie_mode

**Files:**
- Create: `supabase/migrations/00008_taco_primary_macros.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Enable pg_trgm for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create GIN index on taco_foods.food_name for trigram similarity
CREATE INDEX idx_taco_foods_food_name_trgm ON taco_foods USING GIN (food_name gin_trgm_ops);

-- Expand meal_items source CHECK constraint
ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
  CHECK (source IN ('approximate','taco','taco_decomposed','manual','user_provided','user_history'));

-- Migrate calorie_mode: approximate -> taco
UPDATE users SET calorie_mode = 'taco' WHERE calorie_mode = 'approximate';

-- Update calorie_mode CHECK constraint (if exists) — users table uses VARCHAR, check CLAUDE.md
-- The users table may not have a CHECK constraint on calorie_mode (it's validated in app code).
-- If there is one, update it:
DO $$
BEGIN
  -- Try to drop old constraint if it exists
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_calorie_mode_check;
  -- Add new constraint allowing only taco and manual
  ALTER TABLE users ADD CONSTRAINT users_calorie_mode_check
    CHECK (calorie_mode IN ('taco', 'manual'));
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;
```

- [ ] **Step 2: Verify migration syntax**

Run: `cat supabase/migrations/00008_taco_primary_macros.sql`
Verify: SQL is syntactically valid, no missing semicolons.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00008_taco_primary_macros.sql
git commit -m "feat: add migration for TACO primary macros (pg_trgm, source enum, calorie_mode)"
```

---

## Task 2: TACO Fuzzy Match Query Layer

**Files:**
- Create: `src/lib/db/queries/taco.ts`
- Create: `tests/unit/db/taco.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/unit/db/taco.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fuzzyMatchTaco, fuzzyMatchTacoMultiple, calculateMacros, SIMILARITY_THRESHOLD } from '@/lib/db/queries/taco'

// Mock Supabase client
function createMockSupabase(returnData: unknown[] | null, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: returnData, error })
  return { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('fuzzyMatchTaco', () => {
  it('returns best match when similarity >= threshold', async () => {
    const supabase = createMockSupabase([
      { id: 3, food_name: 'Arroz, tipo 1, cozido', category: 'Cereais e derivados', calories_per_100g: 128, protein_per_100g: 2.5, carbs_per_100g: 28.1, fat_per_100g: 0.2, fiber_per_100g: 1.6, similarity: 0.8 }
    ])

    const result = await fuzzyMatchTaco(supabase, 'arroz branco cozido')
    expect(result).not.toBeNull()
    expect(result!.foodName).toBe('Arroz, tipo 1, cozido')
    expect(result!.caloriesPer100g).toBe(128)
  })

  it('returns null when no match above threshold', async () => {
    const supabase = createMockSupabase([])
    const result = await fuzzyMatchTaco(supabase, 'big mac')
    expect(result).toBeNull()
  })

  it('returns null on database error', async () => {
    const supabase = createMockSupabase(null, { message: 'connection error' })
    const result = await fuzzyMatchTaco(supabase, 'arroz')
    expect(result).toBeNull()
  })
})

describe('fuzzyMatchTacoMultiple', () => {
  it('returns map of matched foods', async () => {
    const supabase = createMockSupabase([
      { id: 3, food_name: 'Arroz, tipo 1, cozido', category: 'Cereais e derivados', calories_per_100g: 128, protein_per_100g: 2.5, carbs_per_100g: 28.1, fat_per_100g: 0.2, fiber_per_100g: 1.6, similarity: 0.8, query_name: 'arroz' },
      { id: 100, food_name: 'Feijão, carioca, cozido', category: 'Leguminosas e derivados', calories_per_100g: 76, protein_per_100g: 4.8, carbs_per_100g: 13.6, fat_per_100g: 0.5, fiber_per_100g: 8.5, similarity: 0.7, query_name: 'feijão' },
    ])

    const result = await fuzzyMatchTacoMultiple(supabase, ['arroz', 'feijão'])
    expect(result.get('arroz')).not.toBeNull()
    expect(result.get('feijão')).not.toBeNull()
  })
})

describe('calculateMacros', () => {
  it('calculates proportional macros based on grams', () => {
    const tacoFood = {
      id: 3,
      foodName: 'Arroz, tipo 1, cozido',
      category: 'Cereais e derivados',
      caloriesPer100g: 128,
      proteinPer100g: 2.5,
      carbsPer100g: 28.1,
      fatPer100g: 0.2,
      fiberPer100g: 1.6,
    }

    const result = calculateMacros(tacoFood, 200)
    expect(result.calories).toBe(256)
    expect(result.protein).toBeCloseTo(5.0)
    expect(result.carbs).toBeCloseTo(56.2)
    expect(result.fat).toBeCloseTo(0.4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/db/taco.test.ts`
Expected: FAIL — module `@/lib/db/queries/taco` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/db/queries/taco.ts
import { SupabaseClient } from '@supabase/supabase-js'

export const SIMILARITY_THRESHOLD = 0.4

export interface TacoFood {
  id: number
  foodName: string
  category: string
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g: number
}

export interface CalculatedMacros {
  calories: number
  protein: number
  carbs: number
  fat: number
}

interface TacoRow {
  id: number
  food_name: string
  category: string
  calories_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  fiber_per_100g: number
  similarity: number
  query_name?: string
}

function rowToTacoFood(row: TacoRow): TacoFood {
  return {
    id: row.id,
    foodName: row.food_name,
    category: row.category,
    caloriesPer100g: row.calories_per_100g,
    proteinPer100g: row.protein_per_100g,
    carbsPer100g: row.carbs_per_100g,
    fatPer100g: row.fat_per_100g,
    fiberPer100g: row.fiber_per_100g,
  }
}

/**
 * Fuzzy match a food name against taco_foods using pg_trgm similarity.
 * Returns the best match above SIMILARITY_THRESHOLD, or null.
 */
export async function fuzzyMatchTaco(
  supabase: SupabaseClient,
  foodName: string,
): Promise<TacoFood | null> {
  const { data, error } = await supabase.rpc('match_taco_food', {
    query_name: foodName.toLowerCase(),
    threshold: SIMILARITY_THRESHOLD,
  })

  if (error || !data || data.length === 0) {
    return null
  }

  return rowToTacoFood(data[0] as TacoRow)
}

/**
 * Batch fuzzy match multiple food names.
 * Returns a Map from query name → TacoFood (or null if no match).
 */
export async function fuzzyMatchTacoMultiple(
  supabase: SupabaseClient,
  foodNames: string[],
): Promise<Map<string, TacoFood | null>> {
  const result = new Map<string, TacoFood | null>()

  if (foodNames.length === 0) return result

  const { data, error } = await supabase.rpc('match_taco_foods_batch', {
    query_names: foodNames.map(n => n.toLowerCase()),
    threshold: SIMILARITY_THRESHOLD,
  })

  // Initialize all as null
  for (const name of foodNames) {
    result.set(name.toLowerCase(), null)
  }

  if (error || !data) return result

  for (const row of data as (TacoRow & { query_name: string })[]) {
    result.set(row.query_name, rowToTacoFood(row))
  }

  return result
}

/**
 * Calculate macros proportional to grams from TACO per-100g data.
 */
export function calculateMacros(tacoFood: TacoFood, grams: number): CalculatedMacros {
  const factor = grams / 100
  return {
    calories: Math.round(tacoFood.caloriesPer100g * factor),
    protein: Math.round(tacoFood.proteinPer100g * factor * 10) / 10,
    carbs: Math.round(tacoFood.carbsPer100g * factor * 10) / 10,
    fat: Math.round(tacoFood.fatPer100g * factor * 10) / 10,
  }
}
```

- [ ] **Step 4: Add Postgres RPC functions to the migration**

Append to `supabase/migrations/00008_taco_primary_macros.sql`:

```sql
-- RPC function: match single food name
CREATE OR REPLACE FUNCTION match_taco_food(query_name TEXT, threshold FLOAT DEFAULT 0.4)
RETURNS TABLE (
  id INT,
  food_name VARCHAR,
  category VARCHAR,
  calories_per_100g DECIMAL,
  protein_per_100g DECIMAL,
  carbs_per_100g DECIMAL,
  fat_per_100g DECIMAL,
  fiber_per_100g DECIMAL,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.food_name, t.category,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g,
    similarity(lower(t.food_name), query_name) AS similarity
  FROM taco_foods t
  WHERE similarity(lower(t.food_name), query_name) >= threshold
  ORDER BY similarity(lower(t.food_name), query_name) DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- RPC function: batch match multiple food names
CREATE OR REPLACE FUNCTION match_taco_foods_batch(query_names TEXT[], threshold FLOAT DEFAULT 0.4)
RETURNS TABLE (
  id INT,
  food_name VARCHAR,
  category VARCHAR,
  calories_per_100g DECIMAL,
  protein_per_100g DECIMAL,
  carbs_per_100g DECIMAL,
  fat_per_100g DECIMAL,
  fiber_per_100g DECIMAL,
  similarity FLOAT,
  query_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (q.name)
    t.id, t.food_name, t.category,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g,
    similarity(lower(t.food_name), q.name) AS similarity,
    q.name AS query_name
  FROM unnest(query_names) AS q(name)
  JOIN taco_foods t ON similarity(lower(t.food_name), q.name) >= threshold
  ORDER BY q.name, similarity(lower(t.food_name), q.name) DESC;
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 5: Run tests**

Run: `npm run test:unit -- tests/unit/db/taco.test.ts`
Expected: PASS (tests mock supabase.rpc)

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/queries/taco.ts tests/unit/db/taco.test.ts supabase/migrations/00008_taco_primary_macros.sql
git commit -m "feat: add TACO fuzzy match query layer with pg_trgm"
```

---

## Task 3: Decomposition Schema and Prompt

**Files:**
- Create: `src/lib/llm/schemas/decomposition.ts`
- Create: `src/lib/llm/prompts/decompose.ts`

- [ ] **Step 1: Write the decomposition schema**

```typescript
// src/lib/llm/schemas/decomposition.ts
import { z } from 'zod'

export const DecomposedItemSchema = z.object({
  food: z.string(),
  quantity_grams: z.coerce.number().positive(),
})

export const DecompositionResultSchema = z.object({
  ingredients: z.array(DecomposedItemSchema).min(1),
})

export type DecomposedItem = z.infer<typeof DecomposedItemSchema>
export type DecompositionResult = z.infer<typeof DecompositionResultSchema>
```

- [ ] **Step 2: Write the decomposition prompt**

```typescript
// src/lib/llm/prompts/decompose.ts
export function buildDecomposePrompt(foodName: string, totalGrams: number): string {
  return `Você é um especialista em composição de alimentos. Sua ÚNICA função é decompor um alimento composto ou preparado nos seus ingredientes básicos.

ALIMENTO: "${foodName}" (${totalGrams}g no total)

REGRAS:
- Decomponha em ingredientes SIMPLES e BÁSICOS (farinha, carne, óleo, arroz, feijão, etc.)
- A soma dos gramas dos ingredientes deve ser aproximadamente igual a ${totalGrams}g
- Use nomes de ingredientes em português do Brasil
- Use nomes genéricos que possam ser encontrados em uma tabela nutricional (ex: "Farinha, de trigo" em vez de "farinha especial")
- Responda APENAS em JSON

FORMATO DE RESPOSTA (JSON):
{
  "ingredients": [
    { "food": "nome do ingrediente", "quantity_grams": 50 }
  ]
}

Responda SOMENTE com o JSON. Não inclua texto antes ou depois do JSON.`
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/schemas/decomposition.ts src/lib/llm/prompts/decompose.ts
git commit -m "feat: add decomposition schema and prompt for composite foods"
```

---

## Task 4: Unified Meal Analysis Prompt

**Files:**
- Create: `src/lib/llm/prompts/analyze.ts`
- Delete: `src/lib/llm/prompts/approximate.ts`
- Delete: `src/lib/llm/prompts/taco.ts`

- [ ] **Step 1: Write the unified prompt**

This prompt is simpler — the LLM focuses on identifying foods and estimating portions. It does NOT calculate macros (backend does that via TACO).

```typescript
// src/lib/llm/prompts/analyze.ts
export function buildAnalyzePrompt(): string {
  return `Você é um identificador de alimentos. Sua ÚNICA função é:
1. Identificar alimentos mencionados na mensagem
2. Estimar quantidades em gramas
3. Classificar o tipo de refeição

Você NÃO precisa calcular calorias ou macronutrientes — isso será feito automaticamente.

REGRAS ABSOLUTAS:
- Responda APENAS em JSON no formato especificado
- SEMPRE escreva os nomes dos alimentos em português do Brasil (ex: "Arroz branco", "Feijão preto", "Frango grelhado")
- NUNCA use nomes de alimentos em inglês — traduza sempre para PT-BR
- NUNCA dê conselhos de saúde, dieta ou nutrição
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
          "quantity_grams": 100,
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

NOTAS SOBRE CAMPOS OPCIONAIS:
- "calories", "protein", "carbs", "fat": incluir SOMENTE se o usuário forneceu valores explícitos. Caso contrário, deixar null.
- "quantity_source": usar "user_provided" quando o usuário informou a quantidade explicitamente.

Responda SOMENTE com o JSON. Não inclua texto antes ou depois do JSON.`
}
```

- [ ] **Step 2: Delete old prompt files**

Delete `src/lib/llm/prompts/approximate.ts` and `src/lib/llm/prompts/taco.ts`.

**Important:** The `TacoFood` interface from `taco.ts` was moved to `src/lib/db/queries/taco.ts` in Task 2. Update any imports that reference it from the old location (handled in later tasks).

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/prompts/analyze.ts
git rm src/lib/llm/prompts/approximate.ts src/lib/llm/prompts/taco.ts
git commit -m "feat: unified meal analysis prompt, remove approximate/taco prompts"
```

---

## Task 5: Update Schemas — MealAnalysis and CalorieMode

**Files:**
- Modify: `src/lib/llm/schemas/meal-analysis.ts`
- Modify: `src/lib/llm/schemas/common.ts`

- [ ] **Step 1: Update MealItemSchema — macros optional, add references**

In `src/lib/llm/schemas/meal-analysis.ts`, replace the schema:

```typescript
import { z } from 'zod'
import { MealTypeSchema, ConfidenceSchema } from './common'

export const MealItemSchema = z.object({
  food: z.string(),
  quantity_grams: z.coerce.number().positive(),
  quantity_source: z.enum(['estimated', 'user_provided']).default('estimated'),
  calories: z.coerce.number().nonnegative().nullable().optional().default(null),
  protein: z.coerce.number().nonnegative().nullable().optional().default(null),
  carbs: z.coerce.number().nonnegative().nullable().optional().default(null),
  fat: z.coerce.number().nonnegative().nullable().optional().default(null),
  confidence: ConfidenceSchema.optional().default('medium'),
})

export const MealAnalysisSchema = z.object({
  meal_type: MealTypeSchema,
  confidence: ConfidenceSchema,
  references_previous: z.boolean().optional().default(false),
  reference_query: z.string().nullable().optional().default(null),
  items: z.array(MealItemSchema).min(1),
  unknown_items: z.array(z.string()).default([]),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().nullable().optional(),
})

export const MultiMealAnalysisSchema = z.object({
  meals: z.array(MealAnalysisSchema).min(1),
})

export type MealItem = z.infer<typeof MealItemSchema>
export type MealAnalysis = z.infer<typeof MealAnalysisSchema>
```

Key changes:
- Removed `taco_match`, `taco_id` from schema (backend handles TACO matching)
- Removed `'taco'` from `quantity_source` enum
- Made `calories`, `protein`, `carbs`, `fat` nullable/optional (default null)
- Added `references_previous` and `reference_query` to `MealAnalysisSchema`

- [ ] **Step 2: Update CalorieModeSchema**

In `src/lib/llm/schemas/common.ts`:

```typescript
import { z } from 'zod'

export const CalorieModeSchema = z.enum(['taco', 'manual'])
export type CalorieMode = z.infer<typeof CalorieModeSchema>

export const MealTypeSchema = z.enum(['breakfast', 'lunch', 'snack', 'dinner', 'supper'])
export type MealType = z.infer<typeof MealTypeSchema>

export const ConfidenceSchema = z.enum(['high', 'medium', 'low'])
export type Confidence = z.infer<typeof ConfidenceSchema>
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/schemas/meal-analysis.ts src/lib/llm/schemas/common.ts
git commit -m "feat: update schemas — macros optional, add references_previous, remove approximate mode"
```

---

## Task 6: Update LLM Provider Interface and Implementations

**Files:**
- Modify: `src/lib/llm/provider.ts`
- Modify: `src/lib/llm/providers/openrouter.ts`
- Modify: `src/lib/llm/providers/ollama.ts`
- Modify: `src/lib/llm/index.ts`
- Modify: `src/lib/llm/prompts/vision.ts`

- [ ] **Step 1: Update provider interface**

Replace `src/lib/llm/provider.ts`:

```typescript
import { MealAnalysis } from './schemas/meal-analysis'
import { ImageAnalysis } from './schemas/image-analysis'
import { DecomposedItem } from './schemas/decomposition'

export type IntentType =
  | 'meal_log'
  | 'summary'
  | 'edit'
  | 'query'
  | 'weight'
  | 'help'
  | 'settings'
  | 'out_of_scope'

export interface LLMProvider {
  analyzeMeal(message: string, history?: { role: string; content: string }[]): Promise<MealAnalysis[]>
  analyzeImage(imageBase64: string, caption: string | undefined): Promise<ImageAnalysis>
  decomposeMeal(foodName: string, grams: number): Promise<DecomposedItem[]>
  classifyIntent(message: string): Promise<IntentType>
  chat(message: string, systemPrompt: string): Promise<string>
}
```

Key changes: removed `mode`, `context` params from `analyzeMeal` and `analyzeImage`. Added `decomposeMeal`.

- [ ] **Step 2: Update OpenRouter provider**

In `src/lib/llm/providers/openrouter.ts`:

1. Replace imports at top:
```typescript
import { buildAnalyzePrompt } from '../prompts/analyze'
import { buildDecomposePrompt } from '../prompts/decompose'
// Remove: buildApproximatePrompt, buildTacoPrompt, TacoFood, CalorieMode
```

2. Replace `analyzeMeal` method (line 61-87):
```typescript
  async analyzeMeal(message: string, history?: { role: string; content: string }[]): Promise<MealAnalysis[]> {
    const systemPrompt = buildAnalyzePrompt()

    const rawContent = await this.callAPI(this.mealModel, systemPrompt, message, true, history)
    const parsed = this.parseJSON(rawContent)
    const result = this.parseMealResponse(parsed)

    if (result) return result

    // Retry once on validation failure
    const retryContent = await this.callAPI(this.mealModel, systemPrompt, message, true, history)
    const retryParsed = this.parseJSON(retryContent)
    const retryResult = this.parseMealResponse(retryParsed)

    if (retryResult) return retryResult

    throw new Error('MealAnalysis validation failed after retry')
  }
```

3. Replace `analyzeImage` method (line 105-132) — remove `mode` and `context` params:
```typescript
  async analyzeImage(imageBase64: string, caption: string | undefined): Promise<ImageAnalysis> {
    const systemPrompt = buildVisionPrompt()
    const captionText = caption || 'Analise esta imagem.'

    const rawContent = await this.callVisionAPI(this.visionModel, systemPrompt, imageBase64, captionText)
    const parsed = this.parseJSON(rawContent)
    const validated = ImageAnalysisSchema.safeParse(parsed)

    if (validated.success) return validated.data

    const retryContent = await this.callVisionAPI(this.visionModel, systemPrompt, imageBase64, captionText)
    const retryParsed = this.parseJSON(retryContent)
    const retryValidated = ImageAnalysisSchema.safeParse(retryParsed)

    if (retryValidated.success) return retryValidated.data

    throw new Error(`ImageAnalysis validation failed after retry: ${retryValidated.error.message}`)
  }
```

4. Add `decomposeMeal` method:
```typescript
  async decomposeMeal(foodName: string, grams: number): Promise<DecomposedItem[]> {
    const systemPrompt = buildDecomposePrompt(foodName, grams)
    const rawContent = await this.callAPI(this.mealModel, systemPrompt, `Decompor: ${foodName} (${grams}g)`, true)
    const parsed = this.parseJSON(rawContent)
    const validated = DecompositionResultSchema.safeParse(parsed)

    if (validated.success) return validated.data.ingredients

    // Retry once
    const retryContent = await this.callAPI(this.mealModel, systemPrompt, `Decompor: ${foodName} (${grams}g)`, true)
    const retryParsed = this.parseJSON(retryContent)
    const retryValidated = DecompositionResultSchema.safeParse(retryParsed)

    if (retryValidated.success) return retryValidated.data.ingredients

    throw new Error('Decomposition validation failed after retry')
  }
```

5. Add imports for decomposition:
```typescript
import { DecomposedItem, DecompositionResultSchema } from '../schemas/decomposition'
```

- [ ] **Step 3: Update Ollama provider**

Same changes as OpenRouter but in `src/lib/llm/providers/ollama.ts`. Mirror the pattern:
- Replace imports (same as OpenRouter step 2.1)
- Replace `analyzeMeal` — remove `mode`/`context` params, use `buildAnalyzePrompt()`
- Replace `analyzeImage` — remove `mode`/`context` params, use `buildVisionPrompt()`
- Add `decomposeMeal` method (same logic but using Ollama's `callAPI`)
- Add decomposition imports

- [ ] **Step 4: Update vision prompt — remove TACO context injection**

Replace `src/lib/llm/prompts/vision.ts`:

```typescript
export function buildVisionPrompt(): string {
  return `Você é um analisador nutricional visual. Analise a imagem enviada.

PRIMEIRO: Identifique o tipo de imagem:
- "food": foto de comida/prato/refeição
- "nutrition_label": foto de tabela nutricional/rótulo de embalagem

SE COMIDA:
1. Identifique os alimentos visíveis
2. Estime quantidades em gramas
3. Calcule calorias e macros por item
4. Se houver texto/caption do usuário, use como contexto adicional

SE TABELA NUTRICIONAL:
1. Extraia os dados por porção
2. Retorne como um único item com os valores da tabela
3. Use o nome do produto como nome do item (se visível)

REGRAS ABSOLUTAS:
- Responda APENAS em JSON no formato especificado
- SEMPRE escreva os nomes dos alimentos em português do Brasil (ex: "Arroz branco", "Feijão preto", "Frango grelhado")
- NUNCA use nomes de alimentos em inglês — traduza sempre para PT-BR
- NUNCA invente valores — se não conseguir identificar, retorne needs_clarification: true
- Se a imagem estiver ilegível ou não contiver comida/tabela, retorne needs_clarification: true
- NUNCA dê conselhos de saúde, dieta ou nutrição
- NUNCA sugira alimentos ou substituições

FORMATO DE RESPOSTA (JSON):
{
  "image_type": "food|nutrition_label",
  "meal_type": "breakfast|lunch|snack|dinner|supper",
  "confidence": "high|medium|low",
  "items": [
    {
      "food": "nome do alimento",
      "quantity_grams": 100,
      "quantity_source": "estimated",
      "calories": 200,
      "protein": 10.0,
      "carbs": 25.0,
      "fat": 5.0,
      "confidence": "high|medium|low"
    }
  ],
  "unknown_items": [],
  "needs_clarification": false,
  "clarification_question": null
}

Responda SOMENTE com o JSON. Não inclua texto antes ou depois do JSON.`
}
```

Key change: removed `mode` and `context` params, removed TACO context injection, removed CalorieMode import.

- [ ] **Step 5: Update fallback proxy**

In `src/lib/llm/index.ts`, add `decomposeMeal` to the proxy:

```typescript
function createFallbackProxy(primary: LLMProvider, fallback: LLMProvider): LLMProvider {
  return {
    async analyzeMeal(...args) {
      try { return await primary.analyzeMeal(...args) }
      catch { return await fallback.analyzeMeal(...args) }
    },
    async analyzeImage(...args) {
      try { return await primary.analyzeImage(...args) }
      catch { return await fallback.analyzeImage(...args) }
    },
    async decomposeMeal(...args) {
      try { return await primary.decomposeMeal(...args) }
      catch { return await fallback.decomposeMeal(...args) }
    },
    async classifyIntent(...args) {
      try { return await primary.classifyIntent(...args) }
      catch { return await fallback.classifyIntent(...args) }
    },
    async chat(...args) {
      try { return await primary.chat(...args) }
      catch { return await fallback.chat(...args) }
    },
  }
}
```

Also remove unused imports from `index.ts` if any.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/provider.ts src/lib/llm/providers/openrouter.ts src/lib/llm/providers/ollama.ts src/lib/llm/index.ts src/lib/llm/prompts/vision.ts
git commit -m "feat: update LLM provider interface — add decomposeMeal, simplify analyzeMeal"
```

---

## Task 7: Update Meal-Log Flow — TACO Lookup + Decomposition

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`
- Modify: `src/lib/utils/formatters.ts`
- Modify: `src/lib/db/queries/context.ts`

- [ ] **Step 1: Add `awaiting_history_selection` to context types**

In `src/lib/db/queries/context.ts`, add to both `CONTEXT_TTLS` and `ContextType`:

```typescript
export const CONTEXT_TTLS: Record<ContextType, number> = {
  onboarding: 1440,
  awaiting_confirmation: 5,
  awaiting_clarification: 10,
  awaiting_correction: 10,
  awaiting_weight: 5,
  awaiting_label_portions: 5,
  awaiting_history_selection: 5,
  settings_menu: 5,
  settings_change: 5,
  awaiting_reset_confirmation: 5,
}

export type ContextType =
  | 'onboarding'
  | 'awaiting_confirmation'
  | 'awaiting_clarification'
  | 'awaiting_correction'
  | 'awaiting_weight'
  | 'awaiting_label_portions'
  | 'awaiting_history_selection'
  | 'settings_menu'
  | 'settings_change'
  | 'awaiting_reset_confirmation'
```

- [ ] **Step 2: Add decomposition feedback formatter**

Add to `src/lib/utils/formatters.ts`:

```typescript
export function formatDecompositionFeedback(foodNames: string[]): string {
  if (foodNames.length === 1) {
    return `Não encontrei "${foodNames[0]}" na Tabela TACO. Vou decompor nos ingredientes, um momento... 🔍`
  }
  const list = foodNames.join(', ')
  return `Não encontrei ${list} na Tabela TACO. Vou decompor nos ingredientes, um momento... 🔍`
}
```

- [ ] **Step 3: Rewrite meal-log.ts with TACO pipeline**

Replace the `analyzeAndConfirm` function in `src/lib/bot/flows/meal-log.ts`. The core change: after LLM returns food items, do TACO lookup, then decompose if needed.

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState, clearState } from '@/lib/bot/state'
import type { ConversationContext } from '@/lib/bot/state'
import { createMeal, getDailyCalories } from '@/lib/db/queries/meals'
import { formatMealBreakdown, formatMultiMealBreakdown, formatProgress, formatDecompositionFeedback } from '@/lib/utils/formatters'
import { getRecentMessages } from '@/lib/db/queries/message-history'
import { fuzzyMatchTacoMultiple, calculateMacros, TacoFood } from '@/lib/db/queries/taco'
import { sendWhatsAppMessage } from '@/lib/whatsapp/client'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MealLogResult {
  response: string
  completed: boolean
}

// ---------------------------------------------------------------------------
// Confirmation keywords
// ---------------------------------------------------------------------------

const CONFIRM_PATTERN = /^(sim|s|ok|confirma)$/i
const REJECT_PATTERN = /^(corrigir|não|nao|n)$/i

// ---------------------------------------------------------------------------
// Types for enriched items
// ---------------------------------------------------------------------------

interface EnrichedItem {
  food: string
  quantityGrams: number
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
  tacoId?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalCaloriesFromEnriched(items: EnrichedItem[]): number {
  return Math.round(items.reduce((sum, item) => sum + item.calories, 0))
}

function getMealsFromContext(contextData: Record<string, unknown>): { meals: MealAnalysis[]; enrichedMeals: EnrichedItem[][] } {
  const meals = (contextData.mealAnalyses ?? (contextData.mealAnalysis ? [contextData.mealAnalysis] : [])) as MealAnalysis[]
  const enrichedMeals = (contextData.enrichedMeals ?? []) as EnrichedItem[][]
  return { meals, enrichedMeals }
}

function buildConfirmationResponse(
  meals: MealAnalysis[],
  enrichedMeals: EnrichedItem[][],
  dailyConsumedSoFar: number,
  dailyTarget: number,
): string {
  if (meals.length === 1 && enrichedMeals.length === 1) {
    const analysis = meals[0]
    const items = enrichedMeals[0]
    const total = totalCaloriesFromEnriched(items)

    return formatMealBreakdown(
      analysis.meal_type,
      items.map(i => ({ food: i.food, quantityGrams: i.quantityGrams, calories: i.calories })),
      total,
      dailyConsumedSoFar,
      dailyTarget,
    )
  }

  const mealSections = meals.map((analysis, idx) => ({
    mealType: analysis.meal_type,
    items: enrichedMeals[idx].map(i => ({ food: i.food, quantityGrams: i.quantityGrams, calories: i.calories })),
    total: totalCaloriesFromEnriched(enrichedMeals[idx]),
  }))

  return formatMultiMealBreakdown(mealSections, dailyConsumedSoFar, dailyTarget)
}

// ---------------------------------------------------------------------------
// TACO enrichment — the core new logic
// ---------------------------------------------------------------------------

async function enrichItemsWithTaco(
  supabase: SupabaseClient,
  items: MealItem[],
  llm: ReturnType<typeof getLLMProvider>,
  userId: string,
  phone?: string,
): Promise<EnrichedItem[]> {
  // Step 1: Batch fuzzy match all items against TACO
  const foodNames = items.map(i => i.food)
  const tacoMatches = await fuzzyMatchTacoMultiple(supabase, foodNames)

  const enriched: EnrichedItem[] = []
  const needsDecomposition: { item: MealItem; index: number }[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const tacoMatch = tacoMatches.get(item.food.toLowerCase())

    if (tacoMatch) {
      // Direct TACO match — use TACO macros
      const macros = calculateMacros(tacoMatch, item.quantity_grams)
      enriched.push({
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        source: 'taco',
        tacoId: tacoMatch.id,
      })
    } else if (item.calories !== null && item.calories !== undefined && item.calories > 0) {
      // User provided explicit macros — respect them
      enriched.push({
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: item.calories,
        protein: item.protein ?? 0,
        carbs: item.carbs ?? 0,
        fat: item.fat ?? 0,
        source: 'user_provided',
      })
    } else {
      needsDecomposition.push({ item, index: i })
      enriched.push(null as unknown as EnrichedItem) // placeholder
    }
  }

  // Step 2: Decompose items that didn't match TACO
  if (needsDecomposition.length > 0 && phone) {
    const feedbackNames = needsDecomposition.map(d => d.item.food)
    const feedbackMsg = formatDecompositionFeedback(feedbackNames)
    await sendWhatsAppMessage(phone, feedbackMsg)
  }

  for (const { item, index } of needsDecomposition) {
    try {
      const ingredients = await llm.decomposeMeal(item.food, item.quantity_grams)

      // Match each ingredient against TACO
      const ingredientNames = ingredients.map(ig => ig.food)
      const ingredientMatches = await fuzzyMatchTacoMultiple(supabase, ingredientNames)

      let totalCal = 0, totalProt = 0, totalCarbs = 0, totalFat = 0

      for (const ig of ingredients) {
        const match = ingredientMatches.get(ig.food.toLowerCase())
        if (match) {
          const macros = calculateMacros(match, ig.quantity_grams)
          totalCal += macros.calories
          totalProt += macros.protein
          totalCarbs += macros.carbs
          totalFat += macros.fat
        } else {
          // Ingredient not in TACO — ask LLM for estimate of this specific ingredient
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
            // Silently skip — better partial data than crash
          }
        }
      }

      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: Math.round(totalCal),
        protein: Math.round(totalProt * 10) / 10,
        carbs: Math.round(totalCarbs * 10) / 10,
        fat: Math.round(totalFat * 10) / 10,
        source: totalCal > 0 ? 'taco_decomposed' : 'approximate',
      }
    } catch {
      // Decomposition failed — fall back to approximate (no macros available)
      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleMealLog(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  user: { calorieMode: string; dailyCalorieTarget: number | null; phone?: string },
  context: ConversationContext | null,
): Promise<MealLogResult> {
  const trimmed = message.trim()

  if (context?.contextType === 'awaiting_confirmation') {
    if (CONFIRM_PATTERN.test(trimmed)) {
      return handleConfirmation(supabase, userId, context, user)
    }
    if (REJECT_PATTERN.test(trimmed)) {
      return handleRejection(userId)
    }
  }

  if (context?.contextType === 'awaiting_clarification') {
    const originalMessage = context.contextData.originalMessage as string
    const combined = `${originalMessage}\n${trimmed}`
    return analyzeAndConfirm(supabase, userId, combined, trimmed, user)
  }

  return analyzeAndConfirm(supabase, userId, trimmed, trimmed, user)
}

// ---------------------------------------------------------------------------
// Confirmation handler
// ---------------------------------------------------------------------------

async function handleConfirmation(
  supabase: SupabaseClient,
  userId: string,
  context: ConversationContext,
  user: { calorieMode: string; dailyCalorieTarget: number | null },
): Promise<MealLogResult> {
  const { meals, enrichedMeals } = getMealsFromContext(context.contextData)
  const originalMessage = context.contextData.originalMessage as string

  for (let i = 0; i < meals.length; i++) {
    const analysis = meals[i]
    const items = enrichedMeals[i] ?? []

    await createMeal(supabase, {
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
      })),
    })
  }

  await clearState(userId)

  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000
  const progressLine = formatProgress(dailyConsumed, target)
  const label = meals.length > 1 ? 'Refeições registradas' : 'Refeição registrada'

  return { response: `${label}! ✅\n\n${progressLine}`, completed: true }
}

// ---------------------------------------------------------------------------
// Rejection handler
// ---------------------------------------------------------------------------

async function handleRejection(userId: string): Promise<MealLogResult> {
  await clearState(userId)
  return {
    response: 'Ok! O que quer corrigir? Pode me mandar a refeição novamente com as correções.',
    completed: false,
  }
}

// ---------------------------------------------------------------------------
// Analyze meal with LLM, enrich with TACO, show confirmation
// ---------------------------------------------------------------------------

async function analyzeAndConfirm(
  supabase: SupabaseClient,
  userId: string,
  messageToAnalyze: string,
  originalMessage: string,
  user: { calorieMode: string; dailyCalorieTarget: number | null; phone?: string },
): Promise<MealLogResult> {
  const llm = getLLMProvider()
  const history = await getRecentMessages(supabase, userId)

  const meals: MealAnalysis[] = await llm.analyzeMeal(messageToAnalyze, history)

  // Check clarification/unknown across all meals
  for (const result of meals) {
    if (result.needs_clarification) {
      await setState(userId, 'awaiting_clarification', { originalMessage })
      return {
        response: result.clarification_question ?? 'Pode me dar mais detalhes sobre a refeição?',
        completed: false,
      }
    }
    if (result.unknown_items.length > 0) {
      await setState(userId, 'awaiting_clarification', { originalMessage })
      const itemList = result.unknown_items.join(', ')
      return {
        response: `Não consegui identificar: ${itemList}. Pode me dizer as calorias ou quantas gramas?`,
        completed: false,
      }
    }
  }

  // Enrich all meal items with TACO data
  const enrichedMeals: EnrichedItem[][] = []
  for (const meal of meals) {
    const enriched = await enrichItemsWithTaco(supabase, meal.items, llm, userId, user.phone)
    enrichedMeals.push(enriched)
  }

  // Show breakdown and ask for confirmation
  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000

  const response = buildConfirmationResponse(meals, enrichedMeals, dailyConsumed, target)

  await setState(userId, 'awaiting_confirmation', {
    mealAnalyses: meals as unknown as Record<string, unknown>,
    enrichedMeals: enrichedMeals as unknown as Record<string, unknown>,
    originalMessage,
  })

  return { response, completed: false }
}
```

**Note:** This requires `sendWhatsAppMessage` to be importable. Check if it exists in `src/lib/whatsapp/client.ts`. If the handler is called from the webhook which already has the phone number, it may need to be passed through. The `user.phone` field may need to be added to the handler signature — verify against `src/lib/bot/handler.ts` to see how `handleMealLog` is called.

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: Fix any type errors from the interface changes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts src/lib/utils/formatters.ts src/lib/db/queries/context.ts
git commit -m "feat: meal-log TACO enrichment pipeline with decomposition fallback"
```

---

## Task 8: Update Query Flow

**Files:**
- Modify: `src/lib/bot/flows/query.ts`

- [ ] **Step 1: Update query.ts to use TACO pipeline**

The query flow should also enrich items with TACO data. Replace the `handleQuery` function:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLLMProvider } from '@/lib/llm/index'
import type { MealAnalysis, MealItem } from '@/lib/llm/schemas/meal-analysis'
import { setState } from '@/lib/bot/state'
import { fuzzyMatchTacoMultiple, calculateMacros } from '@/lib/db/queries/taco'

function round(n: number): number {
  return Math.round(n * 10) / 10
}

interface EnrichedQueryItem {
  food: string
  quantityGrams: number
  calories: number
  protein: number
  carbs: number
  fat: number
}

function formatItem(item: EnrichedQueryItem): string {
  const protStr = `${round(item.protein)}g proteína`
  const carbStr = `${round(item.carbs)}g carbos`
  const fatStr = `${round(item.fat)}g gordura`
  const qty = item.quantityGrams ? `~${item.quantityGrams}g` : ''
  const qtyPart = qty ? `(${qty})` : ''
  return `🔍 ${item.food}${qtyPart ? ' ' + qtyPart : ''}: ${Math.round(item.calories)} kcal, ${protStr} | ${carbStr} | ${fatStr}`
}

function formatTotal(items: EnrichedQueryItem[]): string {
  const totalCal = Math.round(items.reduce((sum, i) => sum + i.calories, 0))
  const totalProt = round(items.reduce((sum, i) => sum + i.protein, 0))
  const totalCarbs = round(items.reduce((sum, i) => sum + i.carbs, 0))
  const totalFat = round(items.reduce((sum, i) => sum + i.fat, 0))
  return `📊 Total: ${totalCal} kcal | ${totalProt}g proteína | ${totalCarbs}g carbos | ${totalFat}g gordura`
}

export async function handleQuery(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<string> {
  const llm = getLLMProvider()
  const meals: MealAnalysis[] = await llm.analyzeMeal(message)

  const allItems = meals.flatMap(m => m.items)

  // Enrich with TACO
  const foodNames = allItems.map(i => i.food)
  const tacoMatches = await fuzzyMatchTacoMultiple(supabase, foodNames)

  const enriched: EnrichedQueryItem[] = allItems.map(item => {
    const match = tacoMatches.get(item.food.toLowerCase())
    if (match) {
      const macros = calculateMacros(match, item.quantity_grams)
      return { food: item.food, quantityGrams: item.quantity_grams, ...macros }
    }
    // No TACO match — use LLM values if available, otherwise zeros
    return {
      food: item.food,
      quantityGrams: item.quantity_grams,
      calories: item.calories ?? 0,
      protein: item.protein ?? 0,
      carbs: item.carbs ?? 0,
      fat: item.fat ?? 0,
    }
  })

  const itemLines = enriched.map(formatItem)
  const totalLine = enriched.length > 1 ? [formatTotal(enriched)] : []

  const lines = [...itemLines, ...totalLine, '', 'Quer registrar como uma refeição? (sim/não)']
  const response = lines.join('\n')

  await setState(userId, 'awaiting_confirmation', {
    mealAnalysis: meals[0] as unknown as Record<string, unknown>,
    originalMessage: message,
  })

  return response
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/bot/flows/query.ts
git commit -m "feat: query flow uses TACO pipeline for macros lookup"
```

---

## Task 9: Remove `approximate` from Settings, Onboarding, Validators

**Files:**
- Modify: `src/lib/bot/flows/settings.ts`
- Modify: `src/lib/bot/flows/onboarding.ts`
- Modify: `src/lib/utils/validators.ts`

- [ ] **Step 1: Update validators.ts**

Replace `validateCalorieMode` (lines 182-203):

```typescript
export function validateCalorieMode(
  input: string,
): ValidationResult<'taco' | 'manual'> {
  const key = normalize(input)

  if (key === '1' || key === 'taco') {
    return { valid: true, value: 'taco' }
  }

  if (key === '2' || key === 'manual') {
    return { valid: true, value: 'manual' }
  }

  return {
    valid: false,
    error: 'Opção inválida. Digite 1 (TACO) ou 2 (manual).',
  }
}
```

- [ ] **Step 2: Update settings.ts**

1. Change `CalorieModeValue` type (line 16):
```typescript
type CalorieModeValue = 'taco' | 'manual'
```

2. Remove `approximate` from `MODE_LABELS` (lines 30-33):
```typescript
const MODE_LABELS: Record<CalorieModeValue, string> = {
  taco: 'TACO (tabela nutricional brasileira)',
  manual: 'Manual',
}
```

3. Change default in line 88:
```typescript
const calorieMode = user.calorieMode ?? 'taco'
```

4. Update `applyCalorieModeChange` modeMap (lines 262-268):
```typescript
  const modeMap: Record<string, CalorieModeValue> = {
    '1': 'taco',
    taco: 'taco',
    '2': 'manual',
    manual: 'manual',
  }

  const newMode = modeMap[message.toLowerCase()]

  if (!newMode) {
    return 'Modo inválido. Digite 1 (TACO) ou 2 (manual).'
  }
```

5. Update `buildCalorieModeSubMenu` (lines 398-407):
```typescript
function buildCalorieModeSubMenu(currentMode: string): string {
  const current = MODE_LABELS[currentMode as CalorieModeValue] ?? currentMode
  return [
    `⚙️ Qual modo de cálculo? (atual: ${current})`,
    '',
    '1️⃣ TACO (tabela nutricional brasileira)',
    '2️⃣ Manual (você define tudo)',
  ].join('\n')
}
```

- [ ] **Step 3: Update onboarding.ts**

Change `MSG_ASK_CALORIE_MODE` (line 43):
```typescript
const MSG_ASK_CALORIE_MODE = `Como quer que eu calcule as calorias?\n1️⃣ Tabela TACO — uso a tabela oficial brasileira (mais preciso)\n2️⃣ Manual — você me envia a tabela nutricional (precisão total)`
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors. All `CalorieMode` references should be consistent.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/flows/settings.ts src/lib/bot/flows/onboarding.ts src/lib/utils/validators.ts
git commit -m "feat: remove approximate calorie mode, simplify to taco/manual"
```

---

## Task 10: Update TACO Seed Script

**Files:**
- Modify: `scripts/seed-taco.ts`

- [ ] **Step 1: Update seed script to use extracted JSON**

Replace the contents of `scripts/seed-taco.ts` to read from `docs/taco_foods_extracted.json` (581 foods):

```typescript
// scripts/seed-taco.ts
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseServiceKey)

interface TacoEntry {
  number: number
  name: string
  category: string
  energy_kcal: number
  protein_per_100g: number
  lipids_per_100g: number
  carbs_per_100g: number
  fiber_per_100g: number
}

async function seed() {
  const jsonPath = path.resolve(__dirname, '../docs/taco_foods_extracted.json')
  const rawData = fs.readFileSync(jsonPath, 'utf-8')
  const foods: TacoEntry[] = JSON.parse(rawData)

  console.log(`Seeding ${foods.length} TACO foods...`)

  // Clear existing data
  const { error: deleteError } = await supabase.from('taco_foods').delete().neq('id', 0)
  if (deleteError) {
    console.error('Error clearing taco_foods:', deleteError.message)
    return
  }

  // Insert in batches of 50
  const batchSize = 50
  let inserted = 0

  for (let i = 0; i < foods.length; i += batchSize) {
    const batch = foods.slice(i, i + batchSize).map(f => ({
      id: f.number,
      food_name: f.name,
      category: f.category,
      calories_per_100g: f.energy_kcal,
      protein_per_100g: f.protein_per_100g,
      carbs_per_100g: f.carbs_per_100g,
      fat_per_100g: f.lipids_per_100g,
      fiber_per_100g: f.fiber_per_100g,
      sodium_per_100g: 0, // not extracted from PDF centesimal pages
    }))

    const { error } = await supabase.from('taco_foods').upsert(batch, { onConflict: 'id' })
    if (error) {
      console.error(`Error inserting batch at ${i}:`, error.message)
    } else {
      inserted += batch.length
    }
  }

  console.log(`Done! Inserted ${inserted} of ${foods.length} foods.`)
}

seed().catch(console.error)
```

- [ ] **Step 2: Commit**

```bash
git add scripts/seed-taco.ts
git commit -m "feat: update TACO seed script with 581 foods from 4th edition PDF"
```

---

## Task 11: Update Tests

**Files:**
- Modify: `tests/unit/bot/meal-log.test.ts`
- Modify: `tests/unit/llm/openrouter.test.ts`
- Modify: `tests/unit/llm/ollama.test.ts`

- [ ] **Step 1: Update meal-log tests**

The meal-log tests need significant updates because:
- `analyzeMeal` no longer takes `mode` or `context` params
- Items now go through TACO enrichment
- Mocks need to include `fuzzyMatchTacoMultiple` and `calculateMacros`

Key changes to mock setup:
- Add mock for `@/lib/db/queries/taco` (fuzzyMatchTacoMultiple, calculateMacros)
- Update `analyzeMeal` mock calls to not pass `mode`/`context`
- Update context data structure to include `enrichedMeals`
- Update assertions for `createMeal` calls to check `source: 'taco'`

This is a large test file (~527 lines). Update the mocks at the top and adjust individual test assertions. The test structure stays the same — the behavior being tested (confirmation, rejection, clarification, multi-meal) is the same, just the data flow is different.

- [ ] **Step 2: Update openrouter tests**

In `tests/unit/llm/openrouter.test.ts`:
- Update `analyzeMeal` calls: remove `mode` and `context` params
- Add test for `decomposeMeal` method
- Update mock response format (macros are optional now)
- Verify the unified `buildAnalyzePrompt()` is used instead of mode-branching

- [ ] **Step 3: Update ollama tests**

Same changes as openrouter tests but for `tests/unit/llm/ollama.test.ts`.

- [ ] **Step 4: Run all tests**

Run: `npm run test:unit`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/bot/meal-log.test.ts tests/unit/llm/openrouter.test.ts tests/unit/llm/ollama.test.ts
git commit -m "test: update tests for TACO primary macros pipeline"
```

---

## Task 12: Update handler.ts — Pass phone to handleMealLog

**Files:**
- Modify: `src/lib/bot/handler.ts`

- [ ] **Step 1: Find where handleMealLog is called**

Read `src/lib/bot/handler.ts` and find all calls to `handleMealLog`. The `from` variable (phone number) should already be available from the webhook payload.

- [ ] **Step 2: Add phone to the user object passed to handleMealLog**

In every call to `handleMealLog`, add `phone: from` to the user object:

```typescript
// Before:
const result = await handleMealLog(supabase, userId, message, { calorieMode, dailyCalorieTarget }, context)

// After:
const result = await handleMealLog(supabase, userId, message, { calorieMode, dailyCalorieTarget, phone: from }, context)
```

Apply this to ALL calls to `handleMealLog` in the handler (there may be multiple — for meal_log intent, awaiting_confirmation, awaiting_clarification).

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/bot/handler.ts
git commit -m "feat: pass phone number to handleMealLog for decomposition feedback"
```

---

## Task 13: History Reuse — Search and Select from Previous Meals

**Files:**
- Create: `src/lib/db/queries/meal-history-search.ts`
- Modify: `src/lib/bot/flows/meal-log.ts`

- [ ] **Step 1: Write the meal history search module**

```typescript
// src/lib/db/queries/meal-history-search.ts
import { SupabaseClient } from '@supabase/supabase-js'

export interface HistoryMatch {
  mealId: string
  foodName: string
  quantityGrams: number
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
  tacoId: number | null
  registeredAt: string
  originalMessage: string
}

/**
 * Search a user's previous meal_items by food name (ILIKE).
 * Falls back to searching meals.original_message if no item match.
 * Returns up to 3 most recent matches.
 */
export async function searchMealHistory(
  supabase: SupabaseClient,
  userId: string,
  query: string,
): Promise<HistoryMatch[]> {
  // First: search by meal_items.food_name
  const { data: itemData } = await supabase
    .from('meal_items')
    .select(`
      id, food_name, quantity_grams, calories, protein_g, carbs_g, fat_g, source, taco_id, created_at,
      meals!inner(id, user_id, original_message, registered_at)
    `)
    .eq('meals.user_id', userId)
    .ilike('food_name', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(3)

  if (itemData && itemData.length > 0) {
    return itemData.map((row: Record<string, unknown>) => {
      const meal = row.meals as Record<string, unknown>
      return {
        mealId: meal.id as string,
        foodName: row.food_name as string,
        quantityGrams: row.quantity_grams as number,
        calories: row.calories as number,
        protein: row.protein_g as number,
        carbs: row.carbs_g as number,
        fat: row.fat_g as number,
        source: row.source as string,
        tacoId: row.taco_id as number | null,
        registeredAt: meal.registered_at as string,
        originalMessage: meal.original_message as string,
      }
    })
  }

  // Fallback: search by meals.original_message
  const { data: mealData } = await supabase
    .from('meals')
    .select(`
      id, original_message, registered_at,
      meal_items(food_name, quantity_grams, calories, protein_g, carbs_g, fat_g, source, taco_id)
    `)
    .eq('user_id', userId)
    .ilike('original_message', `%${query}%`)
    .order('registered_at', { ascending: false })
    .limit(3)

  if (!mealData || mealData.length === 0) return []

  return mealData.map((meal: Record<string, unknown>) => {
    const items = meal.meal_items as Record<string, unknown>[]
    const firstItem = items?.[0] ?? {}
    return {
      mealId: meal.id as string,
      foodName: firstItem.food_name as string ?? 'Refeição',
      quantityGrams: firstItem.quantity_grams as number ?? 0,
      calories: firstItem.calories as number ?? 0,
      protein: firstItem.protein_g as number ?? 0,
      carbs: firstItem.carbs_g as number ?? 0,
      fat: firstItem.fat_g as number ?? 0,
      source: firstItem.source as string ?? 'approximate',
      tacoId: firstItem.taco_id as number | null ?? null,
      registeredAt: meal.registered_at as string,
      originalMessage: meal.original_message as string,
    }
  })
}
```

- [ ] **Step 2: Add history reuse handling to meal-log.ts**

In `handleMealLog`, add handling for `awaiting_history_selection` context and integrate the `references_previous` detection in `analyzeAndConfirm`.

Add to the top of `handleMealLog` (after `awaiting_confirmation` and `awaiting_clarification` checks):

```typescript
  // Branch: user is selecting from history matches
  if (context?.contextType === 'awaiting_history_selection') {
    return handleHistorySelection(supabase, userId, trimmed, context, user)
  }
```

In `analyzeAndConfirm`, after clarification checks but before TACO enrichment, add:

```typescript
  // Check for history references
  for (const meal of meals) {
    if (meal.references_previous && meal.reference_query) {
      const matches = await searchMealHistory(supabase, userId, meal.reference_query)
      if (matches.length === 0) {
        // No history found — fall through to normal TACO pipeline
        continue
      }
      if (matches.length === 1) {
        // Single match — use it directly, but ask confirmation
        const match = matches[0]
        const enrichedMeals = [[{
          food: match.foodName,
          quantityGrams: match.quantityGrams,
          calories: match.calories,
          protein: match.protein,
          carbs: match.carbs,
          fat: match.fat,
          source: 'user_history',
          tacoId: match.tacoId ?? undefined,
        }]]
        const dailyConsumed = await getDailyCalories(supabase, userId)
        const target = user.dailyCalorieTarget ?? 2000
        const response = buildConfirmationResponse(meals, enrichedMeals, dailyConsumed, target)
        await setState(userId, 'awaiting_confirmation', {
          mealAnalyses: meals as unknown as Record<string, unknown>,
          enrichedMeals: enrichedMeals as unknown as Record<string, unknown>,
          originalMessage,
        })
        return { response, completed: false }
      }
      // Multiple matches — present options
      const options = matches.map((m, i) => {
        const date = new Date(m.registeredAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
        return `${i + 1}️⃣ ${m.foodName} — ${m.calories}kcal (${date})`
      })
      await setState(userId, 'awaiting_history_selection', {
        matches: matches as unknown as Record<string, unknown>,
        meals: meals as unknown as Record<string, unknown>,
        originalMessage,
      })
      return {
        response: `Encontrei esses registros de ${meal.reference_query}:\n${options.join('\n')}\nQual deles?`,
        completed: false,
      }
    }
  }
```

Add the `handleHistorySelection` function:

```typescript
async function handleHistorySelection(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  context: ConversationContext,
  user: { calorieMode: string; dailyCalorieTarget: number | null },
): Promise<MealLogResult> {
  const matches = context.contextData.matches as HistoryMatch[]
  const meals = context.contextData.meals as MealAnalysis[]
  const originalMessage = context.contextData.originalMessage as string

  const choice = parseInt(message.trim(), 10)
  if (isNaN(choice) || choice < 1 || choice > matches.length) {
    return { response: `Opção inválida. Digite um número de 1 a ${matches.length}.`, completed: false }
  }

  const match = matches[choice - 1]
  const enrichedMeals = [[{
    food: match.foodName,
    quantityGrams: match.quantityGrams,
    calories: match.calories,
    protein: match.protein,
    carbs: match.carbs,
    fat: match.fat,
    source: 'user_history',
    tacoId: match.tacoId ?? undefined,
  }]]

  const dailyConsumed = await getDailyCalories(supabase, userId)
  const target = user.dailyCalorieTarget ?? 2000
  const response = buildConfirmationResponse(meals, enrichedMeals, dailyConsumed, target)

  await setState(userId, 'awaiting_confirmation', {
    mealAnalyses: meals as unknown as Record<string, unknown>,
    enrichedMeals: enrichedMeals as unknown as Record<string, unknown>,
    originalMessage,
  })

  return { response, completed: false }
}
```

Add the import at the top of meal-log.ts:
```typescript
import { searchMealHistory, HistoryMatch } from '@/lib/db/queries/meal-history-search'
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/queries/meal-history-search.ts src/lib/bot/flows/meal-log.ts
git commit -m "feat: history reuse — search and select from previous meals"
```

---

## Task 14: Decomposition Cache via food_cache

**Files:**
- Modify: `src/lib/db/queries/food-cache.ts`
- Modify: `src/lib/bot/flows/meal-log.ts` (enrichItemsWithTaco)

- [ ] **Step 1: Add decomposition cache functions to food-cache.ts**

Add to `src/lib/db/queries/food-cache.ts`:

```typescript
export interface CachedDecomposition {
  foodName: string
  ingredients: { food: string; quantity_grams: number }[]
}

/**
 * Lookup cached decomposition for a composite food.
 */
export async function lookupDecomposition(
  supabase: SupabaseClient,
  foodName: string,
): Promise<CachedDecomposition | null> {
  const normalized = normalizeFoodName(foodName)

  const { data, error } = await supabase
    .from('food_cache')
    .select('*')
    .eq('food_name_normalized', normalized)
    .eq('source', 'decomposition')
    .single()

  if (error || !data) return null

  // Increment hit count fire-and-forget
  supabase
    .from('food_cache')
    .update({ hit_count: ((data as Record<string, unknown>).hit_count as number) + 1 })
    .eq('food_name_normalized', normalized)

  const typicalPortion = data.typical_portion_grams as number | null
  // The ingredients are stored as JSON in a convention field
  // We store them in the calories_per_100g field as a JSON string (repurposed)
  // Better approach: use a JSONB column. For now, return null and let caller decompose.
  // TODO: Add a `decomposition_data JSONB` column to food_cache in a future migration
  return null
}

/**
 * Cache a decomposition result.
 */
export async function cacheDecomposition(
  supabase: SupabaseClient,
  foodName: string,
  ingredients: { food: string; quantity_grams: number }[],
): Promise<void> {
  const normalized = normalizeFoodName(foodName)

  // For now, we store the decomposition as a food_cache entry
  // with source='decomposition' — the macros are the summed values
  // Full ingredient list storage requires schema change (deferred)
  await supabase
    .from('food_cache')
    .upsert({
      food_name_normalized: normalized,
      calories_per_100g: 0, // placeholder — actual macros computed at lookup time
      source: 'decomposition',
    }, { onConflict: 'food_name_normalized' })
}
```

**Note:** Full decomposition caching with ingredient lists requires adding a `decomposition_data JSONB` column to `food_cache`. This is deferred to a follow-up migration to keep this task focused. The current implementation provides the cache lookup structure.

- [ ] **Step 2: Integrate cache in enrichItemsWithTaco**

In the decomposition section of `enrichItemsWithTaco` in `meal-log.ts`, before calling `llm.decomposeMeal`, check the cache:

```typescript
import { lookupDecomposition, cacheDecomposition } from '@/lib/db/queries/food-cache'

// In the needsDecomposition loop, before calling llm.decomposeMeal:
const cached = await lookupDecomposition(supabase, item.food)
// If cached, use cached ingredients (when fully implemented)
// For now, always decompose and cache the result
const ingredients = await llm.decomposeMeal(item.food, item.quantity_grams)
await cacheDecomposition(supabase, item.food, ingredients)
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/queries/food-cache.ts src/lib/bot/flows/meal-log.ts
git commit -m "feat: decomposition cache scaffold in food_cache"
```

---

## Task 15: Fix Remaining Imports and References

**Files:**
- Any file that imports from deleted `prompts/approximate.ts` or `prompts/taco.ts`

- [ ] **Step 1: Search for stale imports**

Run: `grep -r "prompts/approximate" src/ tests/` and `grep -r "prompts/taco" src/ tests/`

Fix any remaining imports to point to `prompts/analyze.ts` or `db/queries/taco.ts` (for TacoFood type).

- [ ] **Step 2: Search for stale CalorieMode references**

Run: `grep -r "'approximate'" src/` — verify no code references the removed mode except the `meal_items.source` CHECK constraint (which keeps `approximate` as a valid value for fallback items).

- [ ] **Step 3: Run full type check and tests**

Run: `npx tsc --noEmit && npm run test:unit`
Expected: No errors, all tests pass.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve stale imports after TACO primary macros refactor"
```

---

## Task 16: Deploy Migration and Seed

**Files:** None (operational task)

- [ ] **Step 1: Apply migration to Supabase**

Run the migration against the production Supabase instance. This enables `pg_trgm`, creates the GIN index, expands the source enum, migrates calorie_mode values, and creates the RPC functions.

Use the Supabase MCP tools or `npx supabase db push`.

- [ ] **Step 2: Run seed script**

Run: `npx tsx scripts/seed-taco.ts`
Expected: "Done! Inserted 581 of 581 foods."

- [ ] **Step 3: Verify deployment**

Run: `git push` (triggers Vercel deploy per project convention)

- [ ] **Step 4: Test manually**

Send a WhatsApp message to the bot: "almocei arroz e feijão"
Expected: Bot responds with TACO-based macros for arroz and feijão.

Send: "comi uma coxinha"
Expected: Bot sends decomposition feedback, then responds with decomposed macros.
