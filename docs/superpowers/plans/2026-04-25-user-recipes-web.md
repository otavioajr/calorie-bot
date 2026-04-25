# User Recipes (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to register private recipes (ingredients + final weight + servings), compute aggregated and per-serving macros, and log a meal from a saved recipe — all via the web UI. Bot integration (PR2) is deferred to a separate plan.

**Architecture:** Mirror the existing `meals`/`meal_items` parent–child pattern with two new tables (`user_recipes`, `recipe_ingredients`). RLS uses the same `auth.uid()` subquery chain. Macros are snapshot at creation/edit time. A reusable lib `src/lib/recipes/` holds compute and log-meal logic shared with the future bot flow. Web pages mirror the existing `src/app/(auth)/settings/` structure (server-component data fetch, client-component manual `useState` + `fetch` form, shadcn/ui).

**Tech Stack:** Next.js App Router, TypeScript strict, Supabase (Postgres + RLS + pg_trgm), Zod, shadcn/ui, Vitest. Playwright E2E is deferred until the repo has an isolated E2E auth/data contract.

**Database rollout note:** The active CalorieBot database is Supabase self-hosted in Docker on the VPS (`ubuntu@147.15.89.175`), not a local Supabase project. Do not run `npx supabase db push` from the local machine for this feature. Apply the committed SQL migration on the VPS with a backup, preflight checks, and direct Postgres execution against the Supabase DB container.

**Spec reference:** `docs/superpowers/specs/2026-04-25-user-recipes-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `supabase/migrations/00020_create_user_recipes.sql` | Tables + RLS + indexes + `pg_trgm` extension + adds `'recipe'` to `meal_items.source` CHECK |
| Create | `src/lib/recipes/types.ts` | Shared TS types: `Recipe`, `RecipeIngredient`, `LabelOverride`, input/output shapes |
| Create | `src/lib/recipes/compute.ts` | `computeRecipeMacros(ingredients, totalWeight, servings)` — pure function, no I/O |
| Create | `src/lib/recipes/log-meal.ts` | `logMealFromRecipe(...)` — converts recipe + portions to `meal` + aggregate `meal_item` |
| Create | `src/lib/db/queries/recipes.ts` | CRUD: `createRecipe`, `getRecipesByUser`, `getRecipeWithIngredients`, `updateRecipe`, `deleteRecipe` |
| Create | `src/lib/llm/schemas/recipe-parse.ts` | Zod schema for parsed ingredient list |
| Create | `src/lib/llm/parsers/recipe-ingredients.ts` | Calls LLM, returns parsed + TACO-matched ingredient list |
| Create | `src/app/api/recipes/route.ts` | `GET` (list), `POST` (create) |
| Create | `src/app/api/recipes/[id]/route.ts` | `GET`, `PUT`, `DELETE` |
| Create | `src/app/api/recipes/[id]/log/route.ts` | `POST` (log meal) |
| Create | `src/app/api/recipes/parse-ingredients/route.ts` | `POST` (LLM parse) |
| Create | `src/app/(auth)/recipes/page.tsx` | List page — server component |
| Create | `src/app/(auth)/recipes/new/page.tsx` | Create wizard — server component shell |
| Create | `src/app/(auth)/recipes/[id]/page.tsx` | Detail page — server component |
| Create | `src/components/recipes/RecipeList.tsx` | Client list rendering |
| Create | `src/components/recipes/RecipeWizard.tsx` | Two-phase create/edit form |
| Create | `src/components/recipes/IngredientRow.tsx` | Single ingredient row (editable) |
| Create | `src/components/recipes/LabelOverrideModal.tsx` | Modal to enter label nutrition |
| Create | `src/components/recipes/LogRecipeModal.tsx` | Modal to log a meal |
| Modify | `src/lib/db/queries/meals.ts` | Allow `'recipe'` source in `MealItemInput` (just type widening if needed; no logic change) |
| Test | `tests/unit/recipes/compute.test.ts` | TACO-only, label-only, mixed |
| Test | `tests/unit/recipes/log-meal.test.ts` | Snapshot scaling × portions |
| Test | `tests/unit/db/recipes.test.ts` | CRUD with mocked Supabase |
| Test | `tests/unit/llm/recipe-parse.test.ts` | Zod schema validation |
| Test | `tests/unit/api/recipes.test.ts` | Auth gate + Zod + handler routing |
| Test | `tests/unit/api/recipes-log.test.ts` | Log endpoint behavior |
| Test | `tests/integration/recipes-flow.test.ts` | Deferred until there is an isolated DB/test user contract |
| Test | `tests/e2e/recipes.spec.ts` | Deferred until Playwright config/auth bootstrap/data cleanup exist |

---

## Existing patterns to mirror (read these first)

- **Server-component auth gate:** `src/app/(auth)/settings/page.tsx`
- **Client form (manual `useState` + `fetch`):** `src/components/settings/ProfileForm.tsx`
- **DB CRUD module:** `src/lib/db/queries/meals.ts`
- **Vitest mock pattern (Supabase chain + handler mocks):** `tests/unit/webhook/route.test.ts`
- **Zod schemas:** `src/lib/llm/schemas/meal-analysis.ts`
- **Migration RLS subquery pattern:** `supabase/migrations/00005_create_triggers_and_rls.sql` (the meal_items policies)

---

### Task 1: Create migration for `user_recipes` and `recipe_ingredients`

**Files:**
- Create: `supabase/migrations/00020_create_user_recipes.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 00020_create_user_recipes.sql
-- Adds user_recipes + recipe_ingredients (private per-user recipes)
-- and registers 'recipe' as a valid meal_items source.

-- 1. Enable pg_trgm for fuzzy matching (used by bot in PR2; harmless if already on).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Parent table.
CREATE TABLE user_recipes (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                        TEXT NOT NULL,
    total_weight_grams          NUMERIC(8,2) NOT NULL CHECK (total_weight_grams > 0),
    servings                    NUMERIC(5,2) NOT NULL CHECK (servings > 0),
    weight_per_serving_grams    NUMERIC(8,2) NOT NULL CHECK (weight_per_serving_grams > 0),
    total_calories              NUMERIC(8,2) NOT NULL DEFAULT 0,
    total_protein_g             NUMERIC(8,2) NOT NULL DEFAULT 0,
    total_carbs_g               NUMERIC(8,2) NOT NULL DEFAULT 0,
    total_fat_g                 NUMERIC(8,2) NOT NULL DEFAULT 0,
    per_serving_calories        NUMERIC(8,2) NOT NULL DEFAULT 0,
    per_serving_protein_g       NUMERIC(8,2) NOT NULL DEFAULT 0,
    per_serving_carbs_g         NUMERIC(8,2) NOT NULL DEFAULT 0,
    per_serving_fat_g           NUMERIC(8,2) NOT NULL DEFAULT 0,
    notes                       TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX user_recipes_user_name_unique
    ON user_recipes (user_id, lower(name));

CREATE INDEX user_recipes_user_id_idx ON user_recipes (user_id);
CREATE INDEX user_recipes_name_trgm_idx ON user_recipes USING gin (name gin_trgm_ops);

-- 3. Child table.
CREATE TABLE recipe_ingredients (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id           UUID NOT NULL REFERENCES user_recipes(id) ON DELETE CASCADE,
    food_name           TEXT NOT NULL,
    quantity_grams      NUMERIC(8,2) NOT NULL CHECK (quantity_grams > 0),
    calories            NUMERIC(8,2) NOT NULL DEFAULT 0,
    protein_g           NUMERIC(8,2) NOT NULL DEFAULT 0,
    carbs_g             NUMERIC(8,2) NOT NULL DEFAULT 0,
    fat_g               NUMERIC(8,2) NOT NULL DEFAULT 0,
    source              TEXT NOT NULL CHECK (source IN ('taco', 'user_label')),
    taco_id             INTEGER REFERENCES taco_foods(id),
    taco_food_base      TEXT,
    taco_food_variant   TEXT,
    label_override      JSONB,
    display_order       SMALLINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX recipe_ingredients_recipe_id_idx ON recipe_ingredients (recipe_id);

-- 4. updated_at trigger on user_recipes (reuse helper if present; fallback inline).
CREATE OR REPLACE FUNCTION set_user_recipes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_recipes_set_updated_at
    BEFORE UPDATE ON user_recipes
    FOR EACH ROW EXECUTE FUNCTION set_user_recipes_updated_at();

-- 5. RLS.
ALTER TABLE user_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_recipes_owner_select" ON user_recipes
    FOR SELECT USING (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );
CREATE POLICY "user_recipes_owner_insert" ON user_recipes
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );
CREATE POLICY "user_recipes_owner_update" ON user_recipes
    FOR UPDATE USING (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );
CREATE POLICY "user_recipes_owner_delete" ON user_recipes
    FOR DELETE USING (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );

CREATE POLICY "recipe_ingredients_owner_select" ON recipe_ingredients
    FOR SELECT USING (
        recipe_id IN (
            SELECT id FROM user_recipes
            WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
        )
    );
CREATE POLICY "recipe_ingredients_owner_insert" ON recipe_ingredients
    FOR INSERT WITH CHECK (
        recipe_id IN (
            SELECT id FROM user_recipes
            WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
        )
    );
CREATE POLICY "recipe_ingredients_owner_update" ON recipe_ingredients
    FOR UPDATE USING (
        recipe_id IN (
            SELECT id FROM user_recipes
            WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
        )
    );
CREATE POLICY "recipe_ingredients_owner_delete" ON recipe_ingredients
    FOR DELETE USING (
        recipe_id IN (
            SELECT id FROM user_recipes
            WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
        )
    );

-- 6. Add 'recipe' to meal_items.source CHECK constraint (used when logging from a saved recipe).
ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
    CHECK (source IN ('approximate', 'taco', 'taco_decomposed', 'manual', 'user_provided', 'user_history', 'off', 'recipe'));
```

- [ ] **Step 2: Apply migration on the VPS Supabase database**

Do not run `npx supabase db push` locally. The database is the self-hosted Supabase stack on the VPS (`ubuntu@147.15.89.175`) running in Docker.

Recommended rollout shape:

```bash
ssh ubuntu@147.15.89.175

# On the VPS, identify the running Supabase database container.
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -E 'supabase|postgres|db'

# Take a timestamped backup before applying the migration.
docker exec <db-container> pg_dump -U postgres -d postgres --format=custom \
  --file=/tmp/caloriebot-before-user-recipes.dump

# Copy/pipe supabase/migrations/00020_create_user_recipes.sql to the VPS,
# then apply it inside the database container.
docker exec -i <db-container> psql -U postgres -d postgres \
  < supabase/migrations/00020_create_user_recipes.sql
```

Expected: migration runs without error; `user_recipes` and `recipe_ingredients` exist in the VPS database; `meal_items_source_check` accepts `'recipe'`.

- [ ] **Step 3: Verify schema and RLS on the VPS**

Run direct SQL through the VPS database container. First verify the structural changes:

```sql
SELECT to_regclass('public.user_recipes') AS user_recipes;
SELECT to_regclass('public.recipe_ingredients') AS recipe_ingredients;

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'meal_items_source_check';

SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE tablename IN ('user_recipes', 'recipe_ingredients')
ORDER BY tablename, policyname;
```

Then verify isolation as two different `auth.uid()` contexts using existing test users, or a disposable user pair created for the rollout:

```sql
-- As user A
INSERT INTO user_recipes (user_id, name, total_weight_grams, servings, weight_per_serving_grams)
VALUES ('<user_a_id>', 'Test', 100, 1, 100);

-- As user B
SELECT * FROM user_recipes;  -- should NOT see user A's row
```

Expected: User B sees zero rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00020_create_user_recipes.sql
git commit -m "feat(db): add user_recipes and recipe_ingredients tables"
```

---

### Task 2: Add shared TypeScript types for recipes

**Files:**
- Create: `src/lib/recipes/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// src/lib/recipes/types.ts
export type IngredientSource = 'taco' | 'user_label'

export interface LabelOverride {
  kcalPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g?: number
  sodiumPer100g?: number
}

export interface RecipeIngredientInput {
  foodName: string
  quantityGrams: number
  source: IngredientSource
  tacoId?: number
  tacoFoodBase?: string
  tacoFoodVariant?: string
  labelOverride?: LabelOverride
  displayOrder: number
}

export interface RecipeIngredient extends RecipeIngredientInput {
  id: string
  recipeId: string
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

export interface CreateRecipeInput {
  userId: string
  name: string
  totalWeightGrams: number
  servings: number
  notes?: string
  ingredients: RecipeIngredientInput[]
}

export interface Recipe {
  id: string
  userId: string
  name: string
  totalWeightGrams: number
  servings: number
  weightPerServingGrams: number
  totalCalories: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
  perServingCalories: number
  perServingProteinG: number
  perServingCarbsG: number
  perServingFatG: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface RecipeWithIngredients extends Recipe {
  ingredients: RecipeIngredient[]
}

export interface ComputedIngredientMacros {
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

export interface ComputedRecipeMacros {
  weightPerServingGrams: number
  totalCalories: number
  totalProteinG: number
  totalCarbsG: number
  totalFatG: number
  perServingCalories: number
  perServingProteinG: number
  perServingCarbsG: number
  perServingFatG: number
  ingredientMacros: ComputedIngredientMacros[]
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/recipes/types.ts
git commit -m "feat(recipes): add shared TS types"
```

---

### Task 3: Implement `computeRecipeMacros` (pure, with TDD)

**Files:**
- Test: `tests/unit/recipes/compute.test.ts`
- Create: `src/lib/recipes/compute.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/recipes/compute.test.ts
import { describe, it, expect } from 'vitest'
import { computeRecipeMacros } from '@/lib/recipes/compute'
import type { TacoFood } from '@/lib/db/queries/taco'

const RICE: TacoFood = {
  id: 1,
  foodName: 'arroz cozido',
  category: null,
  caloriesPer100g: 124,
  proteinPer100g: 2.5,
  carbsPer100g: 26,
  fatPer100g: 0.2,
  fiberPer100g: 1.6,
  foodBase: 'arroz',
  foodVariant: 'cozido',
  isDefault: true,
}

const BEANS: TacoFood = {
  id: 2,
  foodName: 'feijao cozido',
  category: null,
  caloriesPer100g: 76,
  proteinPer100g: 4.8,
  carbsPer100g: 13.6,
  fatPer100g: 0.5,
  fiberPer100g: 8.5,
  foodBase: 'feijao',
  foodVariant: 'cozido',
  isDefault: true,
}

describe('computeRecipeMacros', () => {
  it('aggregates TACO-sourced ingredients and divides by servings', () => {
    const result = computeRecipeMacros({
      ingredients: [
        { foodName: 'arroz', quantityGrams: 200, source: 'taco', tacoFood: RICE, displayOrder: 1 },
        { foodName: 'feijao', quantityGrams: 100, source: 'taco', tacoFood: BEANS, displayOrder: 2 },
      ],
      totalWeightGrams: 300,
      servings: 2,
    })

    // 200g arroz: 248 kcal, 5g P, 52g C, 0.4g F
    // 100g feijao: 76 kcal, 4.8g P, 13.6g C, 0.5g F
    expect(result.totalCalories).toBeCloseTo(324, 1)
    expect(result.totalProteinG).toBeCloseTo(9.8, 1)
    expect(result.totalCarbsG).toBeCloseTo(65.6, 1)
    expect(result.totalFatG).toBeCloseTo(0.9, 1)

    expect(result.perServingCalories).toBeCloseTo(162, 1)
    expect(result.perServingProteinG).toBeCloseTo(4.9, 1)
    expect(result.weightPerServingGrams).toBeCloseTo(150, 1)
  })

  it('uses label_override when source is user_label', () => {
    const result = computeRecipeMacros({
      ingredients: [
        {
          foodName: 'creme de leite',
          quantityGrams: 200,
          source: 'user_label',
          labelOverride: {
            kcalPer100g: 195,
            proteinPer100g: 2.5,
            carbsPer100g: 4,
            fatPer100g: 19,
          },
          displayOrder: 1,
        },
      ],
      totalWeightGrams: 200,
      servings: 1,
    })

    expect(result.totalCalories).toBeCloseTo(390, 1)
    expect(result.totalFatG).toBeCloseTo(38, 1)
  })

  it('mixes TACO and label_override ingredients', () => {
    const result = computeRecipeMacros({
      ingredients: [
        { foodName: 'arroz', quantityGrams: 100, source: 'taco', tacoFood: RICE, displayOrder: 1 },
        {
          foodName: 'creme de leite',
          quantityGrams: 100,
          source: 'user_label',
          labelOverride: { kcalPer100g: 195, proteinPer100g: 2.5, carbsPer100g: 4, fatPer100g: 19 },
          displayOrder: 2,
        },
      ],
      totalWeightGrams: 200,
      servings: 2,
    })

    expect(result.totalCalories).toBeCloseTo(124 + 195, 1)
    expect(result.weightPerServingGrams).toBeCloseTo(100, 1)
  })

  it('handles fractional servings (decimal)', () => {
    const result = computeRecipeMacros({
      ingredients: [
        { foodName: 'arroz', quantityGrams: 100, source: 'taco', tacoFood: RICE, displayOrder: 1 },
      ],
      totalWeightGrams: 100,
      servings: 2.5,
    })
    expect(result.perServingCalories).toBeCloseTo(124 / 2.5, 1)
    expect(result.weightPerServingGrams).toBeCloseTo(40, 1)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/unit/recipes/compute.test.ts`
Expected: FAIL — `computeRecipeMacros` not defined.

- [ ] **Step 3: Implement `compute.ts`**

```typescript
// src/lib/recipes/compute.ts
import type { TacoFood } from '@/lib/db/queries/taco'
import type { ComputedRecipeMacros, IngredientSource, LabelOverride } from './types'

export interface ComputeIngredient {
  foodName: string
  quantityGrams: number
  source: IngredientSource
  tacoFood?: TacoFood
  labelOverride?: LabelOverride
  displayOrder: number
}

export interface ComputeRecipeInput {
  ingredients: ComputeIngredient[]
  totalWeightGrams: number
  servings: number
}

function macrosPer100g(ing: ComputeIngredient): {
  kcal: number
  protein: number
  carbs: number
  fat: number
} {
  if (ing.source === 'user_label') {
    if (!ing.labelOverride) {
      throw new Error(`label_override required for user_label ingredient: ${ing.foodName}`)
    }
    return {
      kcal: ing.labelOverride.kcalPer100g,
      protein: ing.labelOverride.proteinPer100g,
      carbs: ing.labelOverride.carbsPer100g,
      fat: ing.labelOverride.fatPer100g,
    }
  }
  if (!ing.tacoFood) {
    throw new Error(`tacoFood required for taco ingredient: ${ing.foodName}`)
  }
  return {
    kcal: ing.tacoFood.caloriesPer100g,
    protein: ing.tacoFood.proteinPer100g,
    carbs: ing.tacoFood.carbsPer100g,
    fat: ing.tacoFood.fatPer100g,
  }
}

export function computeRecipeMacros(input: ComputeRecipeInput): ComputedRecipeMacros {
  const ingredientMacros = input.ingredients.map((ing) => {
    const per100 = macrosPer100g(ing)
    const factor = ing.quantityGrams / 100
    return {
      calories: round1(per100.kcal * factor),
      proteinG: round1(per100.protein * factor),
      carbsG: round1(per100.carbs * factor),
      fatG: round1(per100.fat * factor),
    }
  })

  const totalCalories = round1(sum(ingredientMacros.map((m) => m.calories)))
  const totalProteinG = round1(sum(ingredientMacros.map((m) => m.proteinG)))
  const totalCarbsG = round1(sum(ingredientMacros.map((m) => m.carbsG)))
  const totalFatG = round1(sum(ingredientMacros.map((m) => m.fatG)))

  const weightPerServingGrams = round1(input.totalWeightGrams / input.servings)
  const perServingCalories = round1(totalCalories / input.servings)
  const perServingProteinG = round1(totalProteinG / input.servings)
  const perServingCarbsG = round1(totalCarbsG / input.servings)
  const perServingFatG = round1(totalFatG / input.servings)

  return {
    weightPerServingGrams,
    totalCalories,
    totalProteinG,
    totalCarbsG,
    totalFatG,
    perServingCalories,
    perServingProteinG,
    perServingCarbsG,
    perServingFatG,
    ingredientMacros,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/unit/recipes/compute.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/recipes/compute.test.ts src/lib/recipes/compute.ts
git commit -m "feat(recipes): add pure macro computation"
```

---

### Task 4: Implement DB query layer (`recipes.ts`) with TDD

**Files:**
- Test: `tests/unit/db/recipes.test.ts`
- Create: `src/lib/db/queries/recipes.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/db/recipes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createRecipe,
  getRecipesByUser,
  getRecipeWithIngredients,
  updateRecipe,
  deleteRecipe,
} from '@/lib/db/queries/recipes'
import type { CreateRecipeInput } from '@/lib/recipes/types'

function buildClient(overrides: Partial<{
  insert: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  order: ReturnType<typeof vi.fn>
}> = {}): { client: any; mocks: any } {
  const mocks = {
    insert: overrides.insert ?? vi.fn().mockReturnThis(),
    select: overrides.select ?? vi.fn().mockReturnThis(),
    update: overrides.update ?? vi.fn().mockReturnThis(),
    delete: overrides.delete ?? vi.fn().mockReturnThis(),
    eq: overrides.eq ?? vi.fn().mockReturnThis(),
    single: overrides.single ?? vi.fn(),
    order: overrides.order ?? vi.fn().mockReturnThis(),
  }
  const fromMock = vi.fn(() => mocks)
  return { client: { from: fromMock }, mocks }
}

const baseInput: CreateRecipeInput = {
  userId: 'user-1',
  name: 'Strogonoff',
  totalWeightGrams: 1000,
  servings: 4,
  ingredients: [
    {
      foodName: 'carne moida',
      quantityGrams: 500,
      source: 'taco',
      tacoId: 100,
      tacoFoodBase: 'carne',
      tacoFoodVariant: 'moida',
      displayOrder: 1,
    },
  ],
}

describe('createRecipe', () => {
  it('inserts user_recipes then recipe_ingredients with computed macros', async () => {
    const insertRecipeSingle = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 'recipe-1' }, error: null })
    const insertIngredients = vi.fn().mockResolvedValueOnce({ error: null })

    const client = {
      from: vi.fn((tbl: string) => {
        if (tbl === 'user_recipes') {
          return {
            insert: () => ({
              select: () => ({ single: insertRecipeSingle }),
            }),
          }
        }
        if (tbl === 'recipe_ingredients') {
          return { insert: insertIngredients }
        }
        throw new Error(`unexpected table: ${tbl}`)
      }),
    }

    const id = await createRecipe(client as any, {
      ...baseInput,
      precomputedMacros: {
        weightPerServingGrams: 250,
        totalCalories: 1000,
        totalProteinG: 100,
        totalCarbsG: 50,
        totalFatG: 30,
        perServingCalories: 250,
        perServingProteinG: 25,
        perServingCarbsG: 12.5,
        perServingFatG: 7.5,
        ingredientMacros: [
          { calories: 1000, proteinG: 100, carbsG: 50, fatG: 30 },
        ],
      },
    })

    expect(id).toBe('recipe-1')
    expect(insertIngredients).toHaveBeenCalledOnce()
  })

  it('throws when recipe insert fails', async () => {
    const client = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'duplicate' } }),
          }),
        }),
      }),
    }
    await expect(
      createRecipe(client as any, {
        ...baseInput,
        precomputedMacros: {
          weightPerServingGrams: 250,
          totalCalories: 0,
          totalProteinG: 0,
          totalCarbsG: 0,
          totalFatG: 0,
          perServingCalories: 0,
          perServingProteinG: 0,
          perServingCarbsG: 0,
          perServingFatG: 0,
          ingredientMacros: [{ calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }],
        },
      }),
    ).rejects.toThrow(/duplicate/)
  })
})

describe('getRecipesByUser', () => {
  it('returns mapped recipes ordered by created_at desc', async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'r1',
                  user_id: 'user-1',
                  name: 'Strogonoff',
                  total_weight_grams: 1000,
                  servings: 4,
                  weight_per_serving_grams: 250,
                  total_calories: 1000,
                  total_protein_g: 100,
                  total_carbs_g: 50,
                  total_fat_g: 30,
                  per_serving_calories: 250,
                  per_serving_protein_g: 25,
                  per_serving_carbs_g: 12.5,
                  per_serving_fat_g: 7.5,
                  notes: null,
                  created_at: '2026-04-25T00:00:00Z',
                  updated_at: '2026-04-25T00:00:00Z',
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    }
    const result = await getRecipesByUser(client as any, 'user-1')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Strogonoff')
    expect(result[0].weightPerServingGrams).toBe(250)
  })
})

describe('deleteRecipe', () => {
  it('deletes by id and user_id (defense-in-depth)', async () => {
    const eqUser = vi.fn().mockResolvedValue({ error: null })
    const eqId = vi.fn().mockReturnValue({ eq: eqUser })
    const del = vi.fn().mockReturnValue({ eq: eqId })
    const client = { from: vi.fn(() => ({ delete: del })) }
    await deleteRecipe(client as any, 'recipe-1', 'user-1')
    expect(del).toHaveBeenCalled()
    expect(eqId).toHaveBeenCalledWith('id', 'recipe-1')
    expect(eqUser).toHaveBeenCalledWith('user_id', 'user-1')
  })
})

describe('getRecipeWithIngredients', () => {
  it('returns recipe joined with ingredients', async () => {
    const client = {
      from: vi.fn((tbl: string) => {
        if (tbl === 'user_recipes') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      id: 'r1',
                      user_id: 'user-1',
                      name: 'X',
                      total_weight_grams: 1000,
                      servings: 4,
                      weight_per_serving_grams: 250,
                      total_calories: 1000,
                      total_protein_g: 100,
                      total_carbs_g: 50,
                      total_fat_g: 30,
                      per_serving_calories: 250,
                      per_serving_protein_g: 25,
                      per_serving_carbs_g: 12.5,
                      per_serving_fat_g: 7.5,
                      notes: null,
                      created_at: '2026-04-25T00:00:00Z',
                      updated_at: '2026-04-25T00:00:00Z',
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (tbl === 'recipe_ingredients') {
          return {
            select: () => ({
              eq: () => ({
                order: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'i1',
                      recipe_id: 'r1',
                      food_name: 'carne moida',
                      quantity_grams: 500,
                      calories: 1000,
                      protein_g: 100,
                      carbs_g: 50,
                      fat_g: 30,
                      source: 'taco',
                      taco_id: 100,
                      taco_food_base: 'carne',
                      taco_food_variant: 'moida',
                      label_override: null,
                      display_order: 1,
                      created_at: '2026-04-25T00:00:00Z',
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }
        }
        throw new Error(`unexpected table: ${tbl}`)
      }),
    }

    const result = await getRecipeWithIngredients(client as any, 'r1', 'user-1')
    expect(result.id).toBe('r1')
    expect(result.ingredients).toHaveLength(1)
    expect(result.ingredients[0].foodName).toBe('carne moida')
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/unit/db/recipes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `recipes.ts`**

```typescript
// src/lib/db/queries/recipes.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateRecipeInput,
  Recipe,
  RecipeIngredient,
  RecipeWithIngredients,
} from '@/lib/recipes/types'
import type { ComputedRecipeMacros } from '@/lib/recipes/types'

type DbRecipeRow = {
  id: string
  user_id: string
  name: string
  total_weight_grams: number
  servings: number
  weight_per_serving_grams: number
  total_calories: number
  total_protein_g: number
  total_carbs_g: number
  total_fat_g: number
  per_serving_calories: number
  per_serving_protein_g: number
  per_serving_carbs_g: number
  per_serving_fat_g: number
  notes: string | null
  created_at: string
  updated_at: string
}

type DbIngredientRow = {
  id: string
  recipe_id: string
  food_name: string
  quantity_grams: number
  calories: number
  protein_g: number
  carbs_g: number
  fat_g: number
  source: 'taco' | 'user_label'
  taco_id: number | null
  taco_food_base: string | null
  taco_food_variant: string | null
  label_override: Record<string, number> | null
  display_order: number
  created_at: string
}

function rowToRecipe(row: DbRecipeRow): Recipe {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    totalWeightGrams: Number(row.total_weight_grams),
    servings: Number(row.servings),
    weightPerServingGrams: Number(row.weight_per_serving_grams),
    totalCalories: Number(row.total_calories),
    totalProteinG: Number(row.total_protein_g),
    totalCarbsG: Number(row.total_carbs_g),
    totalFatG: Number(row.total_fat_g),
    perServingCalories: Number(row.per_serving_calories),
    perServingProteinG: Number(row.per_serving_protein_g),
    perServingCarbsG: Number(row.per_serving_carbs_g),
    perServingFatG: Number(row.per_serving_fat_g),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToIngredient(row: DbIngredientRow): RecipeIngredient {
  return {
    id: row.id,
    recipeId: row.recipe_id,
    foodName: row.food_name,
    quantityGrams: Number(row.quantity_grams),
    calories: Number(row.calories),
    proteinG: Number(row.protein_g),
    carbsG: Number(row.carbs_g),
    fatG: Number(row.fat_g),
    source: row.source,
    tacoId: row.taco_id ?? undefined,
    tacoFoodBase: row.taco_food_base ?? undefined,
    tacoFoodVariant: row.taco_food_variant ?? undefined,
    labelOverride: row.label_override
      ? {
          kcalPer100g: Number(row.label_override.kcal_per_100g ?? row.label_override.kcalPer100g),
          proteinPer100g: Number(
            row.label_override.protein_per_100g ?? row.label_override.proteinPer100g,
          ),
          carbsPer100g: Number(
            row.label_override.carbs_per_100g ?? row.label_override.carbsPer100g,
          ),
          fatPer100g: Number(row.label_override.fat_per_100g ?? row.label_override.fatPer100g),
          fiberPer100g:
            row.label_override.fiber_per_100g != null
              ? Number(row.label_override.fiber_per_100g)
              : undefined,
          sodiumPer100g:
            row.label_override.sodium_per_100g != null
              ? Number(row.label_override.sodium_per_100g)
              : undefined,
        }
      : undefined,
    displayOrder: row.display_order,
  }
}

export interface CreateRecipeWithMacrosInput extends CreateRecipeInput {
  precomputedMacros: ComputedRecipeMacros
}

export async function createRecipe(
  supabase: SupabaseClient,
  input: CreateRecipeWithMacrosInput,
): Promise<string> {
  const { data: row, error } = await supabase
    .from('user_recipes')
    .insert({
      user_id: input.userId,
      name: input.name,
      total_weight_grams: input.totalWeightGrams,
      servings: input.servings,
      weight_per_serving_grams: input.precomputedMacros.weightPerServingGrams,
      total_calories: input.precomputedMacros.totalCalories,
      total_protein_g: input.precomputedMacros.totalProteinG,
      total_carbs_g: input.precomputedMacros.totalCarbsG,
      total_fat_g: input.precomputedMacros.totalFatG,
      per_serving_calories: input.precomputedMacros.perServingCalories,
      per_serving_protein_g: input.precomputedMacros.perServingProteinG,
      per_serving_carbs_g: input.precomputedMacros.perServingCarbsG,
      per_serving_fat_g: input.precomputedMacros.perServingFatG,
      notes: input.notes ?? null,
    })
    .select('id')
    .single()

  if (error || !row) {
    throw new Error(`Failed to create recipe: ${error?.message ?? 'no row returned'}`)
  }

  const recipeId = (row as { id: string }).id

  if (input.ingredients.length > 0) {
    const rows = input.ingredients.map((ing, i) => ({
      recipe_id: recipeId,
      food_name: ing.foodName,
      quantity_grams: ing.quantityGrams,
      calories: input.precomputedMacros.ingredientMacros[i].calories,
      protein_g: input.precomputedMacros.ingredientMacros[i].proteinG,
      carbs_g: input.precomputedMacros.ingredientMacros[i].carbsG,
      fat_g: input.precomputedMacros.ingredientMacros[i].fatG,
      source: ing.source,
      taco_id: ing.tacoId ?? null,
      taco_food_base: ing.tacoFoodBase ?? null,
      taco_food_variant: ing.tacoFoodVariant ?? null,
      label_override: ing.labelOverride
        ? {
            kcal_per_100g: ing.labelOverride.kcalPer100g,
            protein_per_100g: ing.labelOverride.proteinPer100g,
            carbs_per_100g: ing.labelOverride.carbsPer100g,
            fat_per_100g: ing.labelOverride.fatPer100g,
            fiber_per_100g: ing.labelOverride.fiberPer100g ?? null,
            sodium_per_100g: ing.labelOverride.sodiumPer100g ?? null,
          }
        : null,
      display_order: ing.displayOrder,
    }))

    const { error: ingError } = await supabase.from('recipe_ingredients').insert(rows)
    if (ingError) {
      throw new Error(`Failed to insert ingredients: ${ingError.message}`)
    }
  }

  return recipeId
}

export async function getRecipesByUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<Recipe[]> {
  const { data, error } = await supabase
    .from('user_recipes')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to load recipes: ${error.message}`)
  }
  return ((data ?? []) as DbRecipeRow[]).map(rowToRecipe)
}

export async function getRecipeWithIngredients(
  supabase: SupabaseClient,
  recipeId: string,
  userId: string,
): Promise<RecipeWithIngredients> {
  const { data: recipeRow, error: recipeErr } = await supabase
    .from('user_recipes')
    .select('*')
    .eq('id', recipeId)
    .eq('user_id', userId)
    .single()

  if (recipeErr || !recipeRow) {
    throw new Error(`Recipe not found: ${recipeErr?.message ?? recipeId}`)
  }

  const { data: ingRows, error: ingErr } = await supabase
    .from('recipe_ingredients')
    .select('*')
    .eq('recipe_id', recipeId)
    .order('display_order', { ascending: true })

  if (ingErr) {
    throw new Error(`Failed to load ingredients: ${ingErr.message}`)
  }

  return {
    ...rowToRecipe(recipeRow as DbRecipeRow),
    ingredients: ((ingRows ?? []) as DbIngredientRow[]).map(rowToIngredient),
  }
}

export async function updateRecipe(
  supabase: SupabaseClient,
  recipeId: string,
  userId: string,
  input: CreateRecipeWithMacrosInput,
): Promise<void> {
  const { error } = await supabase
    .from('user_recipes')
    .update({
      name: input.name,
      total_weight_grams: input.totalWeightGrams,
      servings: input.servings,
      weight_per_serving_grams: input.precomputedMacros.weightPerServingGrams,
      total_calories: input.precomputedMacros.totalCalories,
      total_protein_g: input.precomputedMacros.totalProteinG,
      total_carbs_g: input.precomputedMacros.totalCarbsG,
      total_fat_g: input.precomputedMacros.totalFatG,
      per_serving_calories: input.precomputedMacros.perServingCalories,
      per_serving_protein_g: input.precomputedMacros.perServingProteinG,
      per_serving_carbs_g: input.precomputedMacros.perServingCarbsG,
      per_serving_fat_g: input.precomputedMacros.perServingFatG,
      notes: input.notes ?? null,
    })
    .eq('id', recipeId)
    .eq('user_id', userId)

  if (error) {
    throw new Error(`Failed to update recipe: ${error.message}`)
  }

  const { error: delErr } = await supabase
    .from('recipe_ingredients')
    .delete()
    .eq('recipe_id', recipeId)

  if (delErr) {
    throw new Error(`Failed to clear ingredients: ${delErr.message}`)
  }

  if (input.ingredients.length > 0) {
    const rows = input.ingredients.map((ing, i) => ({
      recipe_id: recipeId,
      food_name: ing.foodName,
      quantity_grams: ing.quantityGrams,
      calories: input.precomputedMacros.ingredientMacros[i].calories,
      protein_g: input.precomputedMacros.ingredientMacros[i].proteinG,
      carbs_g: input.precomputedMacros.ingredientMacros[i].carbsG,
      fat_g: input.precomputedMacros.ingredientMacros[i].fatG,
      source: ing.source,
      taco_id: ing.tacoId ?? null,
      taco_food_base: ing.tacoFoodBase ?? null,
      taco_food_variant: ing.tacoFoodVariant ?? null,
      label_override: ing.labelOverride
        ? {
            kcal_per_100g: ing.labelOverride.kcalPer100g,
            protein_per_100g: ing.labelOverride.proteinPer100g,
            carbs_per_100g: ing.labelOverride.carbsPer100g,
            fat_per_100g: ing.labelOverride.fatPer100g,
            fiber_per_100g: ing.labelOverride.fiberPer100g ?? null,
            sodium_per_100g: ing.labelOverride.sodiumPer100g ?? null,
          }
        : null,
      display_order: ing.displayOrder,
    }))
    const { error: insErr } = await supabase.from('recipe_ingredients').insert(rows)
    if (insErr) {
      throw new Error(`Failed to insert ingredients: ${insErr.message}`)
    }
  }
}

export async function deleteRecipe(
  supabase: SupabaseClient,
  recipeId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('user_recipes')
    .delete()
    .eq('id', recipeId)
    .eq('user_id', userId)

  if (error) {
    throw new Error(`Failed to delete recipe: ${error.message}`)
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run tests/unit/db/recipes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/db/recipes.test.ts src/lib/db/queries/recipes.ts
git commit -m "feat(recipes): add DB query layer with CRUD"
```

---

### Task 5: Implement `logMealFromRecipe` helper with TDD

**Files:**
- Test: `tests/unit/recipes/log-meal.test.ts`
- Create: `src/lib/recipes/log-meal.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/recipes/log-meal.test.ts
import { describe, it, expect, vi } from 'vitest'
import { logMealFromRecipe } from '@/lib/recipes/log-meal'

vi.mock('@/lib/db/queries/meals', () => ({
  createMeal: vi.fn().mockResolvedValue('meal-1'),
}))

vi.mock('@/lib/db/queries/recipes', () => ({
  getRecipeWithIngredients: vi.fn().mockResolvedValue({
    id: 'recipe-1',
    userId: 'user-1',
    name: 'Strogonoff',
    totalWeightGrams: 1000,
    servings: 4,
    weightPerServingGrams: 250,
    totalCalories: 1600,
    totalProteinG: 120,
    totalCarbsG: 80,
    totalFatG: 60,
    perServingCalories: 400,
    perServingProteinG: 30,
    perServingCarbsG: 20,
    perServingFatG: 15,
    notes: null,
    createdAt: '2026-04-25T00:00:00Z',
    updatedAt: '2026-04-25T00:00:00Z',
    ingredients: [],
  }),
}))

import { createMeal } from '@/lib/db/queries/meals'

describe('logMealFromRecipe', () => {
  it('creates a meal with a single aggregate item scaled by portions', async () => {
    const supabase = {} as any
    const mealId = await logMealFromRecipe(supabase, {
      userId: 'user-1',
      recipeId: 'recipe-1',
      portionsConsumed: 1.5,
      mealType: 'lunch',
      registeredAt: new Date('2026-04-25T12:00:00Z'),
      sourceMessage: 'log via web',
    })

    expect(mealId).toBe('meal-1')
    expect(createMeal).toHaveBeenCalledOnce()
    const callArg = (createMeal as any).mock.calls[0][1]

    expect(callArg.userId).toBe('user-1')
    expect(callArg.mealType).toBe('lunch')
    expect(callArg.totalCalories).toBeCloseTo(600, 1) // 400 × 1.5
    expect(callArg.items).toHaveLength(1)
    expect(callArg.items[0].foodName).toBe('Strogonoff')
    expect(callArg.items[0].quantityGrams).toBeCloseTo(375, 1) // 250 × 1.5
    expect(callArg.items[0].calories).toBeCloseTo(600, 1)
    expect(callArg.items[0].source).toBe('recipe')
    expect(callArg.llmResponse).toMatchObject({
      source: 'recipe',
      recipe_id: 'recipe-1',
      recipe_name: 'Strogonoff',
      portions: 1.5,
    })
  })

  it('rejects portionsConsumed <= 0', async () => {
    const supabase = {} as any
    await expect(
      logMealFromRecipe(supabase, {
        userId: 'user-1',
        recipeId: 'recipe-1',
        portionsConsumed: 0,
        mealType: 'lunch',
        registeredAt: new Date(),
        sourceMessage: 'x',
      }),
    ).rejects.toThrow(/portions/i)
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run tests/unit/recipes/log-meal.test.ts`
Expected: FAIL — `logMealFromRecipe` not defined.

- [ ] **Step 3: Implement `log-meal.ts`**

```typescript
// src/lib/recipes/log-meal.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMeal } from '@/lib/db/queries/meals'
import { getRecipeWithIngredients } from '@/lib/db/queries/recipes'

export interface LogMealFromRecipeInput {
  userId: string
  recipeId: string
  portionsConsumed: number
  mealType: string
  registeredAt: Date
  sourceMessage: string
}

export async function logMealFromRecipe(
  supabase: SupabaseClient,
  input: LogMealFromRecipeInput,
): Promise<string> {
  if (input.portionsConsumed <= 0) {
    throw new Error('portionsConsumed must be > 0')
  }

  const recipe = await getRecipeWithIngredients(supabase, input.recipeId, input.userId)

  const totalCalories = round1(recipe.perServingCalories * input.portionsConsumed)
  const totalProtein = round1(recipe.perServingProteinG * input.portionsConsumed)
  const totalCarbs = round1(recipe.perServingCarbsG * input.portionsConsumed)
  const totalFat = round1(recipe.perServingFatG * input.portionsConsumed)
  const totalGrams = round1(recipe.weightPerServingGrams * input.portionsConsumed)

  return createMeal(supabase, {
    userId: input.userId,
    mealType: input.mealType,
    totalCalories,
    originalMessage: input.sourceMessage,
    llmResponse: {
      source: 'recipe',
      recipe_id: recipe.id,
      recipe_name: recipe.name,
      portions: input.portionsConsumed,
    },
    items: [
      {
        foodName: recipe.name,
        quantityGrams: totalGrams,
        calories: totalCalories,
        proteinG: totalProtein,
        carbsG: totalCarbs,
        fatG: totalFat,
        source: 'recipe',
        confidence: 'high',
      },
    ],
  })
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
```

- [ ] **Step 4: Verify `MealItemInput.source` accepts the string `'recipe'`**

Open `src/lib/db/queries/meals.ts` and confirm `MealItemInput.source` is typed as `string` (not a narrow union). If it is a narrow union, widen it to include `'recipe'`. Type-check: `npx tsc --noEmit`.

- [ ] **Step 5: Run tests, verify GREEN**

Run: `npx vitest run tests/unit/recipes/log-meal.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/recipes/log-meal.test.ts src/lib/recipes/log-meal.ts src/lib/db/queries/meals.ts
git commit -m "feat(recipes): add logMealFromRecipe helper"
```

---

### Task 6: Add LLM parser for ingredient text with TDD

**Files:**
- Create: `src/lib/llm/schemas/recipe-parse.ts`
- Create: `src/lib/llm/parsers/recipe-ingredients.ts`
- Test: `tests/unit/llm/recipe-parse.test.ts`

- [ ] **Step 1: Write failing schema test**

```typescript
// tests/unit/llm/recipe-parse.test.ts
import { describe, it, expect } from 'vitest'
import { RecipeParseSchema } from '@/lib/llm/schemas/recipe-parse'

describe('RecipeParseSchema', () => {
  it('accepts valid ingredient list', () => {
    const parsed = RecipeParseSchema.parse({
      ingredients: [
        { food: 'arroz', quantity_grams: 200 },
        { food: 'feijao', quantity_grams: 100 },
      ],
    })
    expect(parsed.ingredients).toHaveLength(2)
  })

  it('coerces string numbers', () => {
    const parsed = RecipeParseSchema.parse({
      ingredients: [{ food: 'arroz', quantity_grams: '200' as unknown as number }],
    })
    expect(parsed.ingredients[0].quantityGrams).toBe(200)
  })

  it('rejects empty ingredient list', () => {
    expect(() => RecipeParseSchema.parse({ ingredients: [] })).toThrow()
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run tests/unit/llm/recipe-parse.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement schema**

```typescript
// src/lib/llm/schemas/recipe-parse.ts
import { z } from 'zod'

export const RecipeParseIngredientSchema = z
  .object({
    food: z.string().min(1),
    quantity_grams: z.coerce.number().positive(),
  })
  .transform((v) => ({
    food: v.food,
    quantityGrams: v.quantity_grams,
  }))

export const RecipeParseSchema = z.object({
  ingredients: z.array(RecipeParseIngredientSchema).min(1),
})

export type RecipeParseIngredient = z.infer<typeof RecipeParseIngredientSchema>
export type RecipeParse = z.infer<typeof RecipeParseSchema>
```

- [ ] **Step 4: Run, verify GREEN**

Run: `npx vitest run tests/unit/llm/recipe-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement parser that wraps existing LLM client**

```typescript
// src/lib/llm/parsers/recipe-ingredients.ts
import { callLLMJson } from '@/lib/llm/client'
import { RecipeParseSchema, type RecipeParseIngredient } from '@/lib/llm/schemas/recipe-parse'

const SYSTEM_PROMPT = `Voce eh um parser estruturado. Recebe lista textual de ingredientes em portugues e retorna JSON com cada ingrediente em gramas.
Regras:
- Se quantidade vier em outra unidade (xicara, colher, kg), CONVERTA para gramas usando estimativas razoaveis.
- "1 cebola media" ~= 110g; "1 dente de alho" ~= 5g; "1 xicara cha" ~= 240g; "1 colher sopa" ~= 15g.
- NUNCA invente ingredientes que nao estejam no texto.
- Responda apenas JSON valido no formato: {"ingredients":[{"food":"...","quantity_grams":N}]}.`

export async function parseRecipeIngredients(text: string): Promise<RecipeParseIngredient[]> {
  const response = await callLLMJson({
    system: SYSTEM_PROMPT,
    user: text,
    schema: RecipeParseSchema,
  })
  return response.ingredients
}
```

> **Note:** If `callLLMJson` is named differently in this repo, look in `src/lib/llm/` for the JSON-mode wrapper. The existing `meal-log.ts` flow shows the call site convention. Mirror it.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/unit/llm/recipe-parse.test.ts src/lib/llm/schemas/recipe-parse.ts src/lib/llm/parsers/recipe-ingredients.ts
git commit -m "feat(recipes): add LLM parser for ingredient text"
```

---

### Task 7: Implement `POST /api/recipes/parse-ingredients` route

**Files:**
- Create: `src/app/api/recipes/parse-ingredients/route.ts`
- Test: `tests/unit/api/recipes-parse.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/api/recipes-parse.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}))

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: vi.fn(),
}))

const mockParseIngredients = vi.fn()
vi.mock('@/lib/llm/parsers/recipe-ingredients', () => ({
  parseRecipeIngredients: mockParseIngredients,
}))

const mockFuzzyMatchTaco = vi.fn()
vi.mock('@/lib/db/queries/taco', () => ({
  fuzzyMatchTaco: mockFuzzyMatchTaco,
  calculateMacros: vi.fn().mockReturnValue({ calories: 124, protein: 2.5, carbs: 26, fat: 0.2 }),
}))

import { POST } from '@/app/api/recipes/parse-ingredients/route'
import { cookies } from 'next/headers'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/recipes/parse-ingredients', () => {
  it('returns 401 when cookie missing', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => undefined })
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ text: 'arroz' }) })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns parsed ingredients with TACO matches', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    mockParseIngredients.mockResolvedValueOnce([{ food: 'arroz', quantityGrams: 200 }])
    mockFuzzyMatchTaco.mockResolvedValueOnce({
      id: 1,
      foodName: 'arroz cozido',
      foodBase: 'arroz',
      foodVariant: 'cozido',
      caloriesPer100g: 124,
      proteinPer100g: 2.5,
      carbsPer100g: 26,
      fatPer100g: 0.2,
      fiberPer100g: 1.6,
      isDefault: true,
      category: null,
    })
    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ text: '200g arroz' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ingredients).toHaveLength(1)
    expect(body.ingredients[0].source).toBe('taco')
    expect(body.ingredients[0].tacoId).toBe(1)
  })

  it('returns 400 on invalid body', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({}) })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run tests/unit/api/recipes-parse.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement route**

```typescript
// src/app/api/recipes/parse-ingredients/route.ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { parseRecipeIngredients } from '@/lib/llm/parsers/recipe-ingredients'
import { fuzzyMatchTaco, calculateMacros } from '@/lib/db/queries/taco'

const BodySchema = z.object({ text: z.string().min(3).max(2000) })

interface ParsedIngredientResponse {
  foodName: string
  quantityGrams: number
  source: 'taco' | 'unknown'
  tacoId?: number
  tacoFoodBase?: string
  tacoFoodVariant?: string
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parseResult = BodySchema.safeParse(body)
  if (!parseResult.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const supabase = createServiceRoleClient()

  let parsed
  try {
    parsed = await parseRecipeIngredients(parseResult.data.text)
  } catch (e) {
    return NextResponse.json(
      { error: 'parse_failed', detail: (e as Error).message },
      { status: 502 },
    )
  }

  const enriched: ParsedIngredientResponse[] = []
  for (const ing of parsed) {
    const taco = await fuzzyMatchTaco(supabase, ing.food)
    if (taco) {
      const macros = calculateMacros(taco, ing.quantityGrams)
      enriched.push({
        foodName: ing.food,
        quantityGrams: ing.quantityGrams,
        source: 'taco',
        tacoId: taco.id,
        tacoFoodBase: taco.foodBase,
        tacoFoodVariant: taco.foodVariant,
        calories: macros.calories,
        proteinG: macros.protein,
        carbsG: macros.carbs,
        fatG: macros.fat,
      })
    } else {
      enriched.push({
        foodName: ing.food,
        quantityGrams: ing.quantityGrams,
        source: 'unknown',
        calories: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
      })
    }
  }

  return NextResponse.json({ ingredients: enriched })
}
```

- [ ] **Step 4: Run, verify GREEN**

Run: `npx vitest run tests/unit/api/recipes-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/api/recipes-parse.test.ts src/app/api/recipes/parse-ingredients/route.ts
git commit -m "feat(recipes): add /api/recipes/parse-ingredients endpoint"
```

---

### Task 8: Implement `GET /api/recipes` and `POST /api/recipes`

**Files:**
- Create: `src/app/api/recipes/route.ts`
- Test: `tests/unit/api/recipes.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/api/recipes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({ cookies: vi.fn() }))
vi.mock('@/lib/db/supabase', () => ({ createServiceRoleClient: vi.fn() }))

const mockGetRecipesByUser = vi.fn()
const mockCreateRecipe = vi.fn()
vi.mock('@/lib/db/queries/recipes', () => ({
  getRecipesByUser: mockGetRecipesByUser,
  createRecipe: mockCreateRecipe,
}))

const mockFuzzyMatchTaco = vi.fn()
vi.mock('@/lib/db/queries/taco', () => ({
  fuzzyMatchTaco: mockFuzzyMatchTaco,
}))

import { GET, POST } from '@/app/api/recipes/route'
import { cookies } from 'next/headers'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/recipes', () => {
  it('401 without cookie', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => undefined })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns user recipes', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    mockGetRecipesByUser.mockResolvedValueOnce([{ id: 'r1', name: 'X' }])
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.recipes).toHaveLength(1)
  })
})

describe('POST /api/recipes', () => {
  it('400 on invalid body', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({}) })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('creates recipe and returns id', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    mockFuzzyMatchTaco.mockResolvedValue({
      id: 1,
      foodName: 'arroz',
      foodBase: 'arroz',
      foodVariant: 'cozido',
      caloriesPer100g: 124,
      proteinPer100g: 2.5,
      carbsPer100g: 26,
      fatPer100g: 0.2,
      fiberPer100g: 1.6,
      isDefault: true,
      category: null,
    })
    mockCreateRecipe.mockResolvedValueOnce('recipe-1')

    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({
        name: 'X',
        totalWeightGrams: 100,
        servings: 1,
        ingredients: [
          {
            foodName: 'arroz',
            quantityGrams: 100,
            source: 'taco',
            tacoId: 1,
            tacoFoodBase: 'arroz',
            tacoFoodVariant: 'cozido',
            displayOrder: 1,
          },
        ],
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe('recipe-1')
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run tests/unit/api/recipes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement route**

```typescript
// src/app/api/recipes/route.ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { getRecipesByUser, createRecipe } from '@/lib/db/queries/recipes'
import { fuzzyMatchTaco } from '@/lib/db/queries/taco'
import { computeRecipeMacros, type ComputeIngredient } from '@/lib/recipes/compute'

const LabelOverrideSchema = z.object({
  kcalPer100g: z.number().nonnegative(),
  proteinPer100g: z.number().nonnegative(),
  carbsPer100g: z.number().nonnegative(),
  fatPer100g: z.number().nonnegative(),
  fiberPer100g: z.number().nonnegative().optional(),
  sodiumPer100g: z.number().nonnegative().optional(),
})

const IngredientInputSchema = z
  .object({
    foodName: z.string().min(1),
    quantityGrams: z.number().positive(),
    source: z.enum(['taco', 'user_label']),
    tacoId: z.number().int().optional(),
    tacoFoodBase: z.string().optional(),
    tacoFoodVariant: z.string().optional(),
    labelOverride: LabelOverrideSchema.optional(),
    displayOrder: z.number().int().nonnegative(),
  })
  .refine(
    (v) => (v.source === 'taco' ? v.tacoId != null : v.labelOverride != null),
    'taco source requires tacoId; user_label requires labelOverride',
  )

const CreateRecipeSchema = z.object({
  name: z.string().min(1).max(120),
  totalWeightGrams: z.number().positive(),
  servings: z.number().positive(),
  notes: z.string().max(1000).optional(),
  ingredients: z.array(IngredientInputSchema).min(1).max(50),
})

export async function GET() {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const supabase = createServiceRoleClient()
  const recipes = await getRecipesByUser(supabase, userId)
  return NextResponse.json({ recipes })
}

export async function POST(req: Request) {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = CreateRecipeSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', detail: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const supabase = createServiceRoleClient()

  // Build compute input — fetch TACO rows for taco-sourced ingredients.
  const computeIngredients: ComputeIngredient[] = []
  for (const ing of parsed.data.ingredients) {
    if (ing.source === 'taco') {
      // Re-fetch by name to get full TacoFood row (taco_id alone could be passed but
      // we keep the lookup to ensure consistent macros even if client lied).
      const taco = await fuzzyMatchTaco(supabase, ing.foodName)
      if (!taco) {
        return NextResponse.json(
          { error: 'taco_not_found', foodName: ing.foodName },
          { status: 422 },
        )
      }
      computeIngredients.push({
        foodName: ing.foodName,
        quantityGrams: ing.quantityGrams,
        source: 'taco',
        tacoFood: taco,
        displayOrder: ing.displayOrder,
      })
    } else {
      computeIngredients.push({
        foodName: ing.foodName,
        quantityGrams: ing.quantityGrams,
        source: 'user_label',
        labelOverride: ing.labelOverride!,
        displayOrder: ing.displayOrder,
      })
    }
  }

  const macros = computeRecipeMacros({
    ingredients: computeIngredients,
    totalWeightGrams: parsed.data.totalWeightGrams,
    servings: parsed.data.servings,
  })

  try {
    const id = await createRecipe(supabase, {
      userId,
      name: parsed.data.name,
      totalWeightGrams: parsed.data.totalWeightGrams,
      servings: parsed.data.servings,
      notes: parsed.data.notes,
      ingredients: parsed.data.ingredients,
      precomputedMacros: macros,
    })
    return NextResponse.json({ id }, { status: 201 })
  } catch (e) {
    const msg = (e as Error).message
    if (/duplicate/i.test(msg)) {
      return NextResponse.json({ error: 'duplicate_name' }, { status: 409 })
    }
    return NextResponse.json({ error: 'create_failed', detail: msg }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run, verify GREEN**

Run: `npx vitest run tests/unit/api/recipes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/api/recipes.test.ts src/app/api/recipes/route.ts
git commit -m "feat(recipes): add GET/POST /api/recipes endpoints"
```

---

### Task 9: Implement `GET/PUT/DELETE /api/recipes/[id]`

**Files:**
- Create: `src/app/api/recipes/[id]/route.ts`
- Test: `tests/unit/api/recipes-id.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/api/recipes-id.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({ cookies: vi.fn() }))
vi.mock('@/lib/db/supabase', () => ({ createServiceRoleClient: vi.fn() }))

const mockGet = vi.fn()
const mockUpdate = vi.fn()
const mockDelete = vi.fn()
vi.mock('@/lib/db/queries/recipes', () => ({
  getRecipeWithIngredients: mockGet,
  updateRecipe: mockUpdate,
  deleteRecipe: mockDelete,
}))
vi.mock('@/lib/db/queries/taco', () => ({
  fuzzyMatchTaco: vi.fn().mockResolvedValue({
    id: 1,
    foodName: 'arroz',
    foodBase: 'arroz',
    foodVariant: 'cozido',
    caloriesPer100g: 124,
    proteinPer100g: 2.5,
    carbsPer100g: 26,
    fatPer100g: 0.2,
    fiberPer100g: 1.6,
    isDefault: true,
    category: null,
  }),
}))

import { GET, PUT, DELETE } from '@/app/api/recipes/[id]/route'
import { cookies } from 'next/headers'

beforeEach(() => vi.clearAllMocks())

const ctx = { params: Promise.resolve({ id: 'recipe-1' }) }

describe('GET /api/recipes/[id]', () => {
  it('returns recipe with ingredients', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    mockGet.mockResolvedValueOnce({ id: 'recipe-1', name: 'X', ingredients: [] })
    const res = await GET(new Request('http://x'), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.recipe.id).toBe('recipe-1')
  })

  it('404 when not found', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    mockGet.mockRejectedValueOnce(new Error('Recipe not found: x'))
    const res = await GET(new Request('http://x'), ctx)
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/recipes/[id]', () => {
  it('deletes recipe', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    mockDelete.mockResolvedValueOnce(undefined)
    const res = await DELETE(new Request('http://x'), ctx)
    expect(res.status).toBe(204)
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run tests/unit/api/recipes-id.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement route**

```typescript
// src/app/api/recipes/[id]/route.ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/db/supabase'
import {
  getRecipeWithIngredients,
  updateRecipe,
  deleteRecipe,
} from '@/lib/db/queries/recipes'
import { fuzzyMatchTaco } from '@/lib/db/queries/taco'
import { computeRecipeMacros, type ComputeIngredient } from '@/lib/recipes/compute'

const LabelOverrideSchema = z.object({
  kcalPer100g: z.number().nonnegative(),
  proteinPer100g: z.number().nonnegative(),
  carbsPer100g: z.number().nonnegative(),
  fatPer100g: z.number().nonnegative(),
  fiberPer100g: z.number().nonnegative().optional(),
  sodiumPer100g: z.number().nonnegative().optional(),
})

const IngredientInputSchema = z.object({
  foodName: z.string().min(1),
  quantityGrams: z.number().positive(),
  source: z.enum(['taco', 'user_label']),
  tacoId: z.number().int().optional(),
  tacoFoodBase: z.string().optional(),
  tacoFoodVariant: z.string().optional(),
  labelOverride: LabelOverrideSchema.optional(),
  displayOrder: z.number().int().nonnegative(),
})

const UpdateRecipeSchema = z.object({
  name: z.string().min(1).max(120),
  totalWeightGrams: z.number().positive(),
  servings: z.number().positive(),
  notes: z.string().max(1000).optional(),
  ingredients: z.array(IngredientInputSchema).min(1).max(50),
})

type RouteCtx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const supabase = createServiceRoleClient()
  try {
    const recipe = await getRecipeWithIngredients(supabase, id, userId)
    return NextResponse.json({ recipe })
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
}

export async function PUT(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = UpdateRecipeSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', detail: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const supabase = createServiceRoleClient()

  const computeIngredients: ComputeIngredient[] = []
  for (const ing of parsed.data.ingredients) {
    if (ing.source === 'taco') {
      const taco = await fuzzyMatchTaco(supabase, ing.foodName)
      if (!taco) {
        return NextResponse.json(
          { error: 'taco_not_found', foodName: ing.foodName },
          { status: 422 },
        )
      }
      computeIngredients.push({
        foodName: ing.foodName,
        quantityGrams: ing.quantityGrams,
        source: 'taco',
        tacoFood: taco,
        displayOrder: ing.displayOrder,
      })
    } else {
      computeIngredients.push({
        foodName: ing.foodName,
        quantityGrams: ing.quantityGrams,
        source: 'user_label',
        labelOverride: ing.labelOverride!,
        displayOrder: ing.displayOrder,
      })
    }
  }

  const macros = computeRecipeMacros({
    ingredients: computeIngredients,
    totalWeightGrams: parsed.data.totalWeightGrams,
    servings: parsed.data.servings,
  })

  try {
    await updateRecipe(supabase, id, userId, {
      userId,
      name: parsed.data.name,
      totalWeightGrams: parsed.data.totalWeightGrams,
      servings: parsed.data.servings,
      notes: parsed.data.notes,
      ingredients: parsed.data.ingredients,
      precomputedMacros: macros,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: 'update_failed', detail: (e as Error).message },
      { status: 500 },
    )
  }
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const supabase = createServiceRoleClient()
  try {
    await deleteRecipe(supabase, id, userId)
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return NextResponse.json(
      { error: 'delete_failed', detail: (e as Error).message },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 4: Run, verify GREEN**

Run: `npx vitest run tests/unit/api/recipes-id.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/api/recipes-id.test.ts src/app/api/recipes/[id]/route.ts
git commit -m "feat(recipes): add GET/PUT/DELETE /api/recipes/[id]"
```

---

### Task 10: Implement `POST /api/recipes/[id]/log`

**Files:**
- Create: `src/app/api/recipes/[id]/log/route.ts`
- Test: `tests/unit/api/recipes-log.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/api/recipes-log.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({ cookies: vi.fn() }))
vi.mock('@/lib/db/supabase', () => ({ createServiceRoleClient: vi.fn() }))

const mockLog = vi.fn()
vi.mock('@/lib/recipes/log-meal', () => ({
  logMealFromRecipe: mockLog,
}))

import { POST } from '@/app/api/recipes/[id]/log/route'
import { cookies } from 'next/headers'

beforeEach(() => vi.clearAllMocks())

const ctx = { params: Promise.resolve({ id: 'recipe-1' }) }

describe('POST /api/recipes/[id]/log', () => {
  it('401 without cookie', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => undefined })
    const req = new Request('http://x', { method: 'POST', body: '{}' })
    const res = await POST(req, ctx)
    expect(res.status).toBe(401)
  })

  it('400 on invalid body', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({}) })
    const res = await POST(req, ctx)
    expect(res.status).toBe(400)
  })

  it('logs meal and returns id', async () => {
    ;(cookies as any).mockResolvedValue({ get: () => ({ value: 'user-1' }) })
    mockLog.mockResolvedValueOnce('meal-1')
    const req = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({
        servingsConsumed: 1.5,
        mealType: 'lunch',
        registeredAt: '2026-04-25T12:00:00Z',
      }),
    })
    const res = await POST(req, ctx)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.mealId).toBe('meal-1')
    expect(mockLog).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1',
      recipeId: 'recipe-1',
      portionsConsumed: 1.5,
      mealType: 'lunch',
      registeredAt: new Date('2026-04-25T12:00:00Z'),
      sourceMessage: 'log via web',
    })
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run tests/unit/api/recipes-log.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement route**

```typescript
// src/app/api/recipes/[id]/log/route.ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { logMealFromRecipe } from '@/lib/recipes/log-meal'

const BodySchema = z.object({
  servingsConsumed: z.number().positive(),
  mealType: z.enum(['breakfast', 'lunch', 'snack', 'dinner', 'supper']),
  registeredAt: z.string().datetime(),
})

type RouteCtx = { params: Promise<{ id: string }> }

export async function POST(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', detail: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const supabase = createServiceRoleClient()
  try {
    const mealId = await logMealFromRecipe(supabase, {
      userId,
      recipeId: id,
      portionsConsumed: parsed.data.servingsConsumed,
      mealType: parsed.data.mealType,
      registeredAt: new Date(parsed.data.registeredAt),
      sourceMessage: 'log via web',
    })
    return NextResponse.json({ mealId }, { status: 201 })
  } catch (e) {
    return NextResponse.json(
      { error: 'log_failed', detail: (e as Error).message },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 4: Run, verify GREEN**

Run: `npx vitest run tests/unit/api/recipes-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/api/recipes-log.test.ts src/app/api/recipes/[id]/log/route.ts
git commit -m "feat(recipes): add /api/recipes/[id]/log endpoint"
```

---

### Task 11: Build `RecipeWizard` client component

**Files:**
- Create: `src/components/recipes/RecipeWizard.tsx`
- Create: `src/components/recipes/IngredientRow.tsx`
- Create: `src/components/recipes/LabelOverrideModal.tsx`

This task is UI-heavy and not unit-tested at the component level (E2E covers it later). Type-check + manual smoke test.

- [ ] **Step 1: Implement `LabelOverrideModal`**

```typescript
// src/components/recipes/LabelOverrideModal.tsx
"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { LabelOverride } from "@/lib/recipes/types"

interface Props {
  open: boolean
  initial?: LabelOverride
  onClose: () => void
  onSave: (override: LabelOverride) => void
}

export function LabelOverrideModal({ open, initial, onClose, onSave }: Props) {
  const [kcal, setKcal] = useState(initial?.kcalPer100g?.toString() ?? "")
  const [protein, setProtein] = useState(initial?.proteinPer100g?.toString() ?? "")
  const [carbs, setCarbs] = useState(initial?.carbsPer100g?.toString() ?? "")
  const [fat, setFat] = useState(initial?.fatPer100g?.toString() ?? "")
  const [fiber, setFiber] = useState(initial?.fiberPer100g?.toString() ?? "")
  const [sodium, setSodium] = useState(initial?.sodiumPer100g?.toString() ?? "")

  function handleSave() {
    const required = [kcal, protein, carbs, fat]
    if (required.some((v) => v === "" || isNaN(Number(v)))) {
      return
    }
    onSave({
      kcalPer100g: Number(kcal),
      proteinPer100g: Number(protein),
      carbsPer100g: Number(carbs),
      fatPer100g: Number(fat),
      fiberPer100g: fiber === "" ? undefined : Number(fiber),
      sodiumPer100g: sodium === "" ? undefined : Number(sodium),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tabela nutricional do produto (por 100g)</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>kcal *</Label>
            <Input value={kcal} onChange={(e) => setKcal(e.target.value)} type="number" step="0.1" />
          </div>
          <div>
            <Label>Proteína (g) *</Label>
            <Input value={protein} onChange={(e) => setProtein(e.target.value)} type="number" step="0.1" />
          </div>
          <div>
            <Label>Carboidrato (g) *</Label>
            <Input value={carbs} onChange={(e) => setCarbs(e.target.value)} type="number" step="0.1" />
          </div>
          <div>
            <Label>Gordura (g) *</Label>
            <Input value={fat} onChange={(e) => setFat(e.target.value)} type="number" step="0.1" />
          </div>
          <div>
            <Label>Fibra (g)</Label>
            <Input value={fiber} onChange={(e) => setFiber(e.target.value)} type="number" step="0.1" />
          </div>
          <div>
            <Label>Sódio (mg)</Label>
            <Input value={sodium} onChange={(e) => setSodium(e.target.value)} type="number" step="0.1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave}>Aplicar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Implement `IngredientRow`**

```typescript
// src/components/recipes/IngredientRow.tsx
"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { LabelOverrideModal } from "./LabelOverrideModal"
import type { LabelOverride } from "@/lib/recipes/types"

export interface IngredientRowState {
  foodName: string
  quantityGrams: number
  source: "taco" | "user_label"
  tacoId?: number
  tacoFoodBase?: string
  tacoFoodVariant?: string
  labelOverride?: LabelOverride
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

interface Props {
  index: number
  value: IngredientRowState
  onChange: (next: IngredientRowState) => void
  onRemove: () => void
  onRecompute: (
    foodName: string,
    grams: number,
    override?: LabelOverride,
  ) => Promise<Partial<IngredientRowState>>
}

export function IngredientRow({ index, value, onChange, onRemove, onRecompute }: Props) {
  const [labelOpen, setLabelOpen] = useState(false)
  const [name, setName] = useState(value.foodName)
  const [grams, setGrams] = useState(value.quantityGrams.toString())

  async function commit() {
    const partial = await onRecompute(name, Number(grams), value.labelOverride)
    onChange({ ...value, ...partial, foodName: name, quantityGrams: Number(grams) })
  }

  async function applyLabel(override: LabelOverride) {
    setLabelOpen(false)
    const partial = await onRecompute(name, Number(grams), override)
    onChange({
      ...value,
      ...partial,
      foodName: name,
      quantityGrams: Number(grams),
      source: "user_label",
      labelOverride: override,
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b py-2">
      <span className="w-6 text-sm text-muted-foreground">{index + 1}.</span>
      <Input
        className="flex-1 min-w-40"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        placeholder="ingrediente"
      />
      <Input
        className="w-24"
        value={grams}
        onChange={(e) => setGrams(e.target.value)}
        onBlur={commit}
        type="number"
        step="1"
      />
      <span className="text-xs text-muted-foreground w-20">g</span>
      <span className="w-16 text-sm">{Math.round(value.calories)} kcal</span>
      <span
        className={`text-xs px-2 py-0.5 rounded ${
          value.source === "user_label" ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-900"
        }`}
      >
        {value.source === "user_label" ? "rótulo" : "TACO"}
      </span>
      <Button size="sm" variant="outline" onClick={() => setLabelOpen(true)}>
        rótulo
      </Button>
      <Button size="sm" variant="ghost" onClick={onRemove}>
        ✕
      </Button>
      <LabelOverrideModal
        open={labelOpen}
        initial={value.labelOverride}
        onClose={() => setLabelOpen(false)}
        onSave={applyLabel}
      />
    </div>
  )
}
```

- [ ] **Step 3: Implement `RecipeWizard`**

```typescript
// src/components/recipes/RecipeWizard.tsx
"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { IngredientRow, type IngredientRowState } from "./IngredientRow"
import type { LabelOverride, RecipeWithIngredients } from "@/lib/recipes/types"

interface Props {
  initial?: RecipeWithIngredients
}

export function RecipeWizard({ initial }: Props) {
  const router = useRouter()
  const [name, setName] = useState(initial?.name ?? "")
  const [ingredientText, setIngredientText] = useState("")
  const [ingredients, setIngredients] = useState<IngredientRowState[]>(
    initial?.ingredients.map((i) => ({
      foodName: i.foodName,
      quantityGrams: i.quantityGrams,
      source: i.source,
      tacoId: i.tacoId,
      tacoFoodBase: i.tacoFoodBase,
      tacoFoodVariant: i.tacoFoodVariant,
      labelOverride: i.labelOverride,
      calories: i.calories,
      proteinG: i.proteinG,
      carbsG: i.carbsG,
      fatG: i.fatG,
    })) ?? [],
  )
  const [totalWeight, setTotalWeight] = useState(initial?.totalWeightGrams.toString() ?? "")
  const [servings, setServings] = useState(initial?.servings.toString() ?? "")
  const [notes, setNotes] = useState(initial?.notes ?? "")
  const [parseLoading, setParseLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleParse() {
    setParseLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/recipes/parse-ingredients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ingredientText }),
      })
      if (!res.ok) {
        const j = await res.json()
        throw new Error(j.error ?? "parse_failed")
      }
      const data = await res.json()
      setIngredients(
        data.ingredients.map((it: any) => ({
          foodName: it.foodName,
          quantityGrams: it.quantityGrams,
          source: it.source === "taco" ? "taco" : "user_label",
          tacoId: it.tacoId,
          tacoFoodBase: it.tacoFoodBase,
          tacoFoodVariant: it.tacoFoodVariant,
          labelOverride: undefined,
          calories: it.calories,
          proteinG: it.proteinG,
          carbsG: it.carbsG,
          fatG: it.fatG,
        })),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setParseLoading(false)
    }
  }

  async function recomputeRow(
    foodName: string,
    grams: number,
    override?: LabelOverride,
  ): Promise<Partial<IngredientRowState>> {
    if (override) {
      const factor = grams / 100
      return {
        calories: Math.round(override.kcalPer100g * factor),
        proteinG: Math.round(override.proteinPer100g * factor * 10) / 10,
        carbsG: Math.round(override.carbsPer100g * factor * 10) / 10,
        fatG: Math.round(override.fatPer100g * factor * 10) / 10,
      }
    }
    const res = await fetch("/api/recipes/parse-ingredients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${grams}g ${foodName}` }),
    })
    if (!res.ok) return {}
    const data = await res.json()
    const row = data.ingredients[0]
    if (!row) return {}
    return {
      tacoId: row.tacoId,
      tacoFoodBase: row.tacoFoodBase,
      tacoFoodVariant: row.tacoFoodVariant,
      source: row.source === "taco" ? "taco" : "user_label",
      calories: row.calories,
      proteinG: row.proteinG,
      carbsG: row.carbsG,
      fatG: row.fatG,
    }
  }

  function addManualRow() {
    setIngredients((curr) => [
      ...curr,
      {
        foodName: "",
        quantityGrams: 0,
        source: "taco",
        calories: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
      },
    ])
  }

  const totalKcal = ingredients.reduce((s, i) => s + i.calories, 0)
  const sv = Number(servings) || 1
  const tw = Number(totalWeight) || 0

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const payload = {
        name,
        totalWeightGrams: Number(totalWeight),
        servings: Number(servings),
        notes: notes || undefined,
        ingredients: ingredients.map((it, i) => ({
          foodName: it.foodName,
          quantityGrams: it.quantityGrams,
          source: it.source,
          tacoId: it.tacoId,
          tacoFoodBase: it.tacoFoodBase,
          tacoFoodVariant: it.tacoFoodVariant,
          labelOverride: it.labelOverride,
          displayOrder: i,
        })),
      }
      const url = initial ? `/api/recipes/${initial.id}` : "/api/recipes"
      const method = initial ? "PUT" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const j = await res.json()
        throw new Error(j.error ?? "save_failed")
      }
      const data = await res.json()
      const id = initial ? initial.id : data.id
      router.push(`/recipes/${id}`)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Receita</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Nome da receita</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {!initial && (
            <div>
              <Label>Ingredientes (texto livre)</Label>
              <textarea
                className="w-full min-h-24 rounded border p-2"
                value={ingredientText}
                onChange={(e) => setIngredientText(e.target.value)}
                placeholder="200g arroz, 100g feijão, 150g peito de frango..."
              />
              <Button onClick={handleParse} disabled={parseLoading || !ingredientText.trim()}>
                {parseLoading ? "Analisando..." : "Analisar ingredientes"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {ingredients.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Ingredientes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {ingredients.map((row, i) => (
                <IngredientRow
                  key={i}
                  index={i}
                  value={row}
                  onChange={(next) => {
                    setIngredients((curr) => curr.map((r, idx) => (idx === i ? next : r)))
                  }}
                  onRemove={() => {
                    setIngredients((curr) => curr.filter((_, idx) => idx !== i))
                  }}
                  onRecompute={recomputeRow}
                />
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={addManualRow} className="mt-3">
              + ingrediente manual
            </Button>
          </CardContent>
        </Card>
      )}

      {ingredients.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Rendimento</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Peso final pós-cocção (g)</Label>
                <Input
                  type="number"
                  step="1"
                  value={totalWeight}
                  onChange={(e) => setTotalWeight(e.target.value)}
                />
              </div>
              <div>
                <Label>Porções</Label>
                <Input
                  type="number"
                  step="0.5"
                  value={servings}
                  onChange={(e) => setServings(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Notas (opcional)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            {tw > 0 && sv > 0 && (
              <div className="rounded bg-muted p-3 text-sm">
                <div>Peso/porção: <strong>{(tw / sv).toFixed(0)}g</strong></div>
                <div>kcal/porção: <strong>{(totalKcal / sv).toFixed(0)}</strong></div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {error && <div className="text-sm text-destructive">Erro: {error}</div>}

      <div className="flex gap-2">
        <Button
          onClick={handleSave}
          disabled={
            saving ||
            !name ||
            ingredients.length === 0 ||
            !totalWeight ||
            !servings
          }
        >
          {saving ? "Salvando..." : initial ? "Atualizar" : "Salvar receita"}
        </Button>
        <Button variant="outline" onClick={() => router.back()}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/recipes/RecipeWizard.tsx src/components/recipes/IngredientRow.tsx src/components/recipes/LabelOverrideModal.tsx
git commit -m "feat(recipes): add RecipeWizard, IngredientRow, LabelOverrideModal components"
```

---

### Task 12: Build `RecipeList` and `LogRecipeModal` client components

**Files:**
- Create: `src/components/recipes/RecipeList.tsx`
- Create: `src/components/recipes/LogRecipeModal.tsx`

- [ ] **Step 1: Implement `RecipeList`**

```typescript
// src/components/recipes/RecipeList.tsx
"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { Recipe } from "@/lib/recipes/types"

interface Props {
  recipes: Recipe[]
}

export function RecipeList({ recipes }: Props) {
  if (recipes.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-3">
          <p className="text-muted-foreground">Você ainda não cadastrou nenhuma receita.</p>
          <Link href="/recipes/new">
            <Button>Criar primeira receita</Button>
          </Link>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-3">
      {recipes.map((r) => (
        <Link key={r.id} href={`/recipes/${r.id}`}>
          <Card className="hover:bg-muted/40 transition">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">{r.name}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <div>{r.weightPerServingGrams.toFixed(0)}g/porção · {r.perServingCalories.toFixed(0)} kcal/porção</div>
              <div>P {r.perServingProteinG.toFixed(1)}g · C {r.perServingCarbsG.toFixed(1)}g · G {r.perServingFatG.toFixed(1)}g</div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Implement `LogRecipeModal`**

```typescript
// src/components/recipes/LogRecipeModal.tsx
"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface Props {
  recipeId: string
  open: boolean
  onClose: () => void
}

const MEAL_TYPES = [
  { value: "breakfast", label: "Café da manhã" },
  { value: "lunch", label: "Almoço" },
  { value: "snack", label: "Lanche" },
  { value: "dinner", label: "Jantar" },
  { value: "supper", label: "Ceia" },
]

export function LogRecipeModal({ recipeId, open, onClose }: Props) {
  const router = useRouter()
  const [servings, setServings] = useState("1")
  const [mealType, setMealType] = useState("lunch")
  const [registeredAt, setRegisteredAt] = useState(() => {
    const d = new Date()
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLog() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/recipes/${recipeId}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          servingsConsumed: Number(servings),
          mealType,
          registeredAt: new Date(registeredAt).toISOString(),
        }),
      })
      if (!res.ok) {
        const j = await res.json()
        throw new Error(j.error ?? "log_failed")
      }
      onClose()
      router.push("/history")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar refeição a partir da receita</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Quantas porções</Label>
            <Input
              type="number"
              step="0.1"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
            />
          </div>
          <div>
            <Label>Tipo de refeição</Label>
            <Select value={mealType} onValueChange={setMealType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEAL_TYPES.map((mt) => (
                  <SelectItem key={mt.value} value={mt.value}>
                    {mt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Data e hora</Label>
            <Input
              type="datetime-local"
              value={registeredAt}
              onChange={(e) => setRegisteredAt(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">Erro: {error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleLog} disabled={loading || Number(servings) <= 0}>
            {loading ? "Registrando..." : "Registrar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Type-check + commit**

Run: `npx tsc --noEmit`
Expected: PASS.

```bash
git add src/components/recipes/RecipeList.tsx src/components/recipes/LogRecipeModal.tsx
git commit -m "feat(recipes): add RecipeList and LogRecipeModal components"
```

---

### Task 13: Build the three pages (list, new, detail)

**Files:**
- Create: `src/app/(auth)/recipes/page.tsx`
- Create: `src/app/(auth)/recipes/new/page.tsx`
- Create: `src/app/(auth)/recipes/[id]/page.tsx`

- [ ] **Step 1: Implement list page**

```typescript
// src/app/(auth)/recipes/page.tsx
import Link from "next/link"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { Button } from "@/components/ui/button"
import { createServiceRoleClient } from "@/lib/db/supabase"
import { getRecipesByUser } from "@/lib/db/queries/recipes"
import { RecipeList } from "@/components/recipes/RecipeList"

export default async function RecipesPage() {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value
  if (!userId) redirect("/")

  const supabase = createServiceRoleClient()
  const recipes = await getRecipesByUser(supabase, userId)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Minhas receitas</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Receitas privadas com macros precisos para suas refeições caseiras
          </p>
        </div>
        <Link href="/recipes/new">
          <Button>+ Nova receita</Button>
        </Link>
      </div>
      <RecipeList recipes={recipes} />
    </div>
  )
}
```

- [ ] **Step 2: Implement new (create) page**

```typescript
// src/app/(auth)/recipes/new/page.tsx
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { RecipeWizard } from "@/components/recipes/RecipeWizard"

export default async function NewRecipePage() {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value
  if (!userId) redirect("/")

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Nova receita</h1>
      <RecipeWizard />
    </div>
  )
}
```

- [ ] **Step 3: Implement detail page**

```typescript
// src/app/(auth)/recipes/[id]/page.tsx
"use client"

// Detail page is client-component because of the log/delete modals.
// Auth check is enforced server-side by the API routes; an unauthenticated
// hit on the page falls through to fetch errors which redirect.
import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { LogRecipeModal } from "@/components/recipes/LogRecipeModal"
import { RecipeWizard } from "@/components/recipes/RecipeWizard"
import type { RecipeWithIngredients } from "@/lib/recipes/types"

export default function RecipeDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [recipe, setRecipe] = useState<RecipeWithIngredients | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    let mounted = true
    fetch(`/api/recipes/${params.id}`)
      .then((r) => {
        if (r.status === 404) {
          router.replace("/recipes")
          return null
        }
        if (!r.ok) throw new Error("load_failed")
        return r.json()
      })
      .then((j) => {
        if (mounted && j) setRecipe(j.recipe as RecipeWithIngredients)
      })
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [params.id, router])

  async function handleDelete() {
    const res = await fetch(`/api/recipes/${params.id}`, { method: "DELETE" })
    if (res.ok) router.push("/recipes")
  }

  if (loading) return <p className="text-muted-foreground">Carregando...</p>
  if (!recipe) return null

  if (editing) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Editar receita</h1>
        <RecipeWizard initial={recipe} />
        <Button variant="outline" onClick={() => setEditing(false)}>Cancelar edição</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{recipe.name}</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setEditing(true)}>Editar</Button>
          <Button variant="destructive" onClick={() => setConfirmDelete(true)}>Deletar</Button>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Resumo</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-muted-foreground">Peso total</div>
            <div className="font-semibold">{recipe.totalWeightGrams.toFixed(0)}g</div>
          </div>
          <div>
            <div className="text-muted-foreground">Porções</div>
            <div className="font-semibold">{recipe.servings}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Peso/porção</div>
            <div className="font-semibold">{recipe.weightPerServingGrams.toFixed(0)}g</div>
          </div>
          <div>
            <div className="text-muted-foreground">kcal/porção</div>
            <div className="font-semibold">{recipe.perServingCalories.toFixed(0)}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Ingredientes</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left">Ingrediente</th>
                <th className="text-right">g</th>
                <th className="text-right">kcal</th>
                <th className="text-right">P</th>
                <th className="text-right">C</th>
                <th className="text-right">G</th>
                <th className="text-right">fonte</th>
              </tr>
            </thead>
            <tbody>
              {recipe.ingredients.map((i) => (
                <tr key={i.id} className="border-t">
                  <td>{i.foodName}</td>
                  <td className="text-right">{i.quantityGrams.toFixed(0)}</td>
                  <td className="text-right">{i.calories.toFixed(0)}</td>
                  <td className="text-right">{i.proteinG.toFixed(1)}</td>
                  <td className="text-right">{i.carbsG.toFixed(1)}</td>
                  <td className="text-right">{i.fatG.toFixed(1)}</td>
                  <td className="text-right">
                    <span className="text-xs">{i.source === "user_label" ? "rótulo" : "TACO"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Button size="lg" className="w-full" onClick={() => setLogOpen(true)}>
        Registrar refeição
      </Button>

      <LogRecipeModal recipeId={recipe.id} open={logOpen} onClose={() => setLogOpen(false)} />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deletar receita?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação remove a receita e seus ingredientes. Refeições já registradas a partir dessa receita são preservadas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Deletar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(auth\)/recipes/
git commit -m "feat(recipes): add list, new, detail pages"
```

---

### Task 14: Defer E2E happy path until test infrastructure exists

**Files:**
- None in PR1.

This repository currently has a `test:e2e` script and Playwright dependencies, but it does not have `playwright.config.*`, a `tests/e2e/` directory, an auth bootstrap fixture, or an isolated recipe test database/user. The production-like database is on the VPS. A browser test that writes recipes today would either depend on live remote rows or need a fake cookie against the VPS database, which is not a reliable or safe PR1 verification path.

- [ ] **Step 1: Record the deferral**

Defer the full browser happy path until one of these contracts exists:

1. local Supabase test stack with migrations and disposable seed data;
2. isolated VPS test database/schema with cleanup;
3. dedicated seeded test user plus authenticated bootstrap and deterministic cleanup.

- [ ] **Step 2: Use focused coverage for PR1**

Run the recipe-focused Vitest suite and targeted lint for the files changed in PR1. This gives deterministic coverage for API handlers, DB query helpers, parser/schema validation, macro computation, logging, and UI component state without writing to the live VPS database.

Expected: focused recipe tests and targeted lint pass.

---

### Task 15: Final verification

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 2: Run recipe-focused unit tests**

Run:

```bash
npx vitest run \
  tests/unit/api/recipes-id.test.ts \
  tests/unit/api/recipes.test.ts \
  tests/unit/api/recipes-log.test.ts \
  tests/unit/api/recipes-parse.test.ts \
  tests/unit/db/recipes.test.ts \
  tests/unit/recipes/log-meal.test.ts \
  tests/unit/recipes/compute.test.ts \
  tests/unit/components/recipes/recipe-detail-client.test.tsx \
  tests/unit/components/recipes/recipe-list-log-modal.test.tsx \
  tests/unit/components/recipes/ingredient-row.test.tsx \
  tests/unit/llm/recipe-parse.test.ts
```

Expected: All recipe tests green.

- [ ] **Step 3: Run production build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Run type-check and document baseline failures**

Run: `npx tsc --noEmit --pretty false`
Expected: no recipe-related errors. If existing bot test fixture errors remain, list them as baseline noise instead of blocking PR1.

- [ ] **Step 5: Manual smoke test after VPS migration**

Follow the full PR1 verification flow from the spec (`docs/superpowers/specs/2026-04-25-user-recipes-design.md` → "Verificação End-to-End → PR1"). Confirm:
1. Wizard creates recipe with TACO ingredients + 1 label-override ingredient
2. Detail shows correct macros
3. Logging from the recipe creates a `meal` row visible in `/history`
4. Editing the recipe (change servings) recomputes per-serving macros
5. The previously logged meal is unchanged after edit
6. Deleting the recipe cascades to ingredients but preserves logged meals

- [ ] **Step 6: Open PR**

```bash
git push -u origin feat/user-recipes-web
gh pr create --title "feat(recipes): private user recipes — web CRUD + meal log" --body "$(cat <<'EOF'
## Summary
- Adds `user_recipes` and `recipe_ingredients` tables (RLS, pg_trgm) + `'recipe'` source on `meal_items`
- Web UI: list / create / edit / delete / log meal at `/recipes/*`
- Reusable `src/lib/recipes/{compute,log-meal}` helpers ready for bot integration in PR2

## Test plan
- [ ] Recipe-focused Vitest suite
- [ ] Targeted lint for recipe files
- [ ] `npm run build`
- [ ] `npx tsc --noEmit --pretty false` (document unrelated baseline errors, if any)
- [ ] Manual: full wizard → detail → log → edit → delete flow per spec
EOF
)"
```

---

## Self-review

After completing all tasks:

1. **Spec coverage:** every section of the spec (data model, web UX, API endpoints, snapshot semantics, label override, RLS) has a corresponding task above. PR2 (bot integration) is intentionally not covered here — separate plan.
2. **Type consistency:** `Recipe`, `RecipeIngredient`, `RecipeWithIngredients`, `IngredientSource`, `LabelOverride`, `ComputedRecipeMacros`, `ComputeIngredient`, `LogMealFromRecipeInput` are all referenced consistently across types.ts, compute.ts, log-meal.ts, queries/recipes.ts, and the API routes.
3. **No placeholders:** all code is concrete; no TBD, no "similar to". The one looser instruction is "find `callLLMJson` in `src/lib/llm/`" because the exact wrapper name varies — that hint is enough to navigate.

## Out-of-scope (next plan)

- Bot recipe detection during meal-log
- `recipe_disambiguation` and `recipe_log_portions` conversation contexts
- `pg_trgm` similarity match in `src/lib/recipes/match.ts`
- "caseira ou da rua" message flow
