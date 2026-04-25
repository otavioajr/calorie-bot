# User Recipes — Design Spec

**Date:** 2026-04-25
**Status:** Approved
**Implementation plans:**
- PR1 (web): `docs/superpowers/plans/2026-04-25-user-recipes-web.md`
- PR2 (bot): TBD — separate plan written after PR1 merges

**Operational note:** The active CalorieBot database runs on the VPS (`ubuntu@147.15.89.175`) as a self-hosted Supabase Docker stack. PR1 migrations must be applied and verified there with backup/preflight; local `npx supabase db push` is not the rollout path for this project.

---

## Context

Today CalorieBot estimates meal macros via TACO + LLM for every meal, with no distinction between repeated home-cooked dishes and one-off meals. This causes recurring error on home recipes the user makes often (e.g., the user's specific strogonoff has macros distinct from the generic estimate).

**Solution:** let the user register private recipes (visible only to themselves) with precise ingredients, post-cooking final weight, and number of servings. The system computes aggregate and per-serving macros. When the user later registers a meal whose dish corresponds to a saved recipe, the bot asks "homemade or from outside?" and uses the precise recipe macros if homemade.

**Expected outcome:** significantly higher accuracy for recurring meals, with low effort for the user (register once, use forever).

**Phasing:** PR1 ships web CRUD + web logging. PR2 adds bot detection and disambiguation.

---

## Goals

- Per-user private recipe registration (web only in MVP)
- Ingredients via free text, LLM-parsed, refined in an editable list
- Per-ingredient nutrition-label override when the user has a label
- Aggregate and per-serving macro computation, snapshotted at create/edit
- Log a meal from a recipe (web and bot)
- Bot detects a saved recipe during meal-log and offers "homemade or from outside?"
- Users do not see other users' recipes (RLS)

## Non-goals

- Social sharing of recipes
- Public recipe database
- Recipes with photos (potential later release)
- Cooking instructions / preparation steps
- Importing a recipe from a URL

---

## Architecture

**New tables (PR1):**
- `user_recipes` (parent) — one row per recipe
- `recipe_ingredients` (child, FK CASCADE) — multiple rows per recipe
- Structural mirror of `meals` ↔ `meal_items`

**RLS:** standard `auth.uid() → users.auth_id → users.id → user_recipes.user_id → recipe_ingredients.recipe_id` chain. Policies are direct copies of the meal/meal_items pattern.

**Macros snapshot:** computed and stored at create/edit time. Same convention as today's `meals`. Editing recomputes. Meals already logged from a recipe are NOT affected (they have their own snapshot in `meal_items`).

**Shared layers (`src/lib/recipes/`):**
- `compute.ts` — macro aggregation (TACO or label_override)
- `log-meal.ts` — converts recipe + portions into a `meal` + aggregate `meal_item`. Used by web (`POST /api/recipes/[id]/log`) and bot (PR2).
- `match.ts` (PR2) — fuzzy match of dish name vs the user's recipes via `pg_trgm`.

**Reuse of existing code:**
- `src/lib/llm/` — existing LLM pipeline, Zod schemas
- `src/lib/db/queries/taco.ts` — `fuzzyMatchTaco`, `pickBestVariant`, `calculateMacros`
- `src/lib/utils/food-normalize.ts` — accent strip + synonyms
- `src/lib/db/utils.ts` — `snakeToCamel` / `camelToSnake` / `fromDB` / `toDB`
- `src/lib/auth/` — cookie gate
- `src/lib/bot/flows/meal-log.ts` — extended in PR2

**UI stack:** mirror existing `src/app/(auth)/settings/` and `src/components/settings/ProfileForm.tsx` — Server Components for shells, client components with manual `useState` + `fetch` for forms (no react-hook-form), shadcn/ui primitives.

---

## Data Model

### `user_recipes`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK users(id) ON DELETE CASCADE | |
| `name` | TEXT NOT NULL | |
| `total_weight_grams` | NUMERIC(8,2) CHECK > 0 | post-cooking final weight, declared by user |
| `servings` | NUMERIC(5,2) CHECK > 0 | accepts decimals |
| `weight_per_serving_grams` | NUMERIC(8,2) | = total_weight_grams / servings |
| `total_calories` | NUMERIC(8,2) | snapshot |
| `total_protein_g` | NUMERIC(8,2) | |
| `total_carbs_g` | NUMERIC(8,2) | |
| `total_fat_g` | NUMERIC(8,2) | |
| `per_serving_calories` | NUMERIC(8,2) | |
| `per_serving_protein_g` | NUMERIC(8,2) | |
| `per_serving_carbs_g` | NUMERIC(8,2) | |
| `per_serving_fat_g` | NUMERIC(8,2) | |
| `notes` | TEXT NULL | optional user note |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ DEFAULT now() | trigger on update |

**Constraints / indexes:**
- `UNIQUE (user_id, lower(name))` — prevents duplicate names per user
- `INDEX (user_id)` — list queries
- `INDEX gin (name gin_trgm_ops)` — bot fuzzy match (PR2)
- Migration enables the `pg_trgm` extension if not already on

### `recipe_ingredients`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `recipe_id` | UUID FK user_recipes(id) ON DELETE CASCADE | |
| `food_name` | TEXT NOT NULL | name as typed by the user |
| `quantity_grams` | NUMERIC(8,2) CHECK > 0 | |
| `calories` | NUMERIC(8,2) | row snapshot |
| `protein_g` | NUMERIC(8,2) | |
| `carbs_g` | NUMERIC(8,2) | |
| `fat_g` | NUMERIC(8,2) | |
| `source` | TEXT CHECK IN ('taco', 'user_label') | macro origin |
| `taco_id` | INTEGER NULL FK taco_foods(id) | when source='taco' |
| `taco_food_base` | TEXT NULL | display "arroz integral cozido" |
| `taco_food_variant` | TEXT NULL | |
| `label_override` | JSONB NULL | `{kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g?, sodium_per_100g?}` when source='user_label' |
| `display_order` | SMALLINT NOT NULL | preserves input order |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

### `meal_items` modification

- Add `'recipe'` to the `source` CHECK constraint (currently `'approximate' | 'taco' | 'taco_decomposed' | 'manual' | 'user_provided' | 'user_history' | 'off'`)
- Identifies entries created from a saved recipe
- `meals.llm_response` JSONB carries `{source: 'recipe', recipe_id, recipe_name, portions}` for traceability

### Macro computation (in `src/lib/recipes/compute.ts`)

```
for each ingredient:
  if source = 'user_label':
    macros_per_100g = label_override
  else:
    macros_per_100g = TACO row by taco_id

  ingredient.calories = macros_per_100g.kcal * (quantity_grams / 100)
  (same for protein/carbs/fat)

recipe.total_<macro> = SUM(ingredients.<macro>)
recipe.per_serving_<macro> = total / servings
recipe.weight_per_serving_grams = total_weight_grams / servings
```

**Final weight ≠ sum of ingredient weights:** ignored. Cooking evaporates water; weight drops but kcal are preserved. Macros = direct sum. Per-serving weight uses only the user-declared `total_weight_grams`.

---

## Web Flow (PR1)

### List — `/(auth)/recipes`
- Server Component reads `caloriebot-user-id` cookie
- Loads user recipes via `getRecipesByUser(userId)`
- Cards with name, weight/serving, kcal/serving, "X ingredients" badge
- Empty state with "create first recipe" CTA
- "+ New Recipe" button in the header

### Creation — `/(auth)/recipes/new`

Single-page form with two visual phases:

**Phase A (always visible):**
- `recipe name` input (e.g., "Strogonoff de Carne")
- `ingredients` textarea — free text (e.g., "200g rice, 100g beans, 150g chicken breast")
- "Analyze ingredients" button

**Phase B (appears after successful parse):**
- `POST /api/recipes/parse-ingredients` with the text → reuses the `meal-log` pipeline (LLM parse + TACO match)
- Editable list. Each row:
  - Name (text)
  - Grams (number)
  - TACO match dropdown (shows `food_base — variant`, alternative variants via `pickBestVariant`)
  - Macros computed live (kcal/p/c/f)
  - "Use nutrition label" button → modal with inputs `kcal_per_100g`, `protein_per_100g`, `carbs_per_100g`, `fat_per_100g`, optional `fiber_per_100g` and `sodium_per_100g`. Saves to `label_override`, switches `source` to `'user_label'`, recomputes the row.
  - Remove row button
- "+ add manual ingredient" button (blank row)
- `final post-cooking weight (g)` and `servings` inputs (decimal)
- Live preview: weight/serving, kcal/serving, macros/serving
- "Save" button → `POST /api/recipes` → redirect to `/recipes/[id]`

### Detail — `/(auth)/recipes/[id]`
- Header: name + `edit` and `delete` buttons
- Stats: total weight, servings, weight/serving, total macros, per-serving macros
- Ingredient table (name, grams, source badge `'TACO'`/`'label'`, macros)
- Big **"Register meal"** button → modal:
  - `how many servings` input (default 1, decimal)
  - `meal type` select (breakfast/lunch/snack/dinner/supper)
  - Datetime picker (default now, in the user's timezone)
  - Submit → `POST /api/recipes/[id]/log` → creates `meal` + aggregate `meal_item` → redirect to `/history`

### Edit
Reuses the `new` page populated via `GET /api/recipes/[id]`. `PUT` instead of `POST`. Recomputes the snapshot.

### Delete
Confirm dialog → `DELETE` → redirect to list. Hard delete. Previously logged meals are preserved (they have their own snapshot in `meal_items`).

### API Endpoints (PR1)

| Method | Route | Body |
|---|---|---|
| GET | `/api/recipes` | — |
| POST | `/api/recipes` | `{name, ingredients[], totalWeightGrams, servings, notes?}` |
| GET | `/api/recipes/[id]` | — |
| PUT | `/api/recipes/[id]` | `{name, ingredients[], totalWeightGrams, servings, notes?}` |
| DELETE | `/api/recipes/[id]` | — |
| POST | `/api/recipes/[id]/log` | `{servingsConsumed, mealType, registeredAt}` |
| POST | `/api/recipes/parse-ingredients` | `{text}` |

All validated with Zod, gated by cookie. Stack: shadcn/ui + manual `useState` + `fetch` (matching `src/components/settings/ProfileForm.tsx`).

---

## Bot Flow (PR2 — separate plan)

### Modified pipeline

```
Text/photo received
  → handleIncomingMessage / handleIncomingImage (existing)
  → LLM meal parse (existing) → {dish_name, items[], photo_grams_estimate?}
  → matchUserRecipes(userId, dish_name)        ← NEW
  → matches above threshold?
       yes → set conversation_state.recipe_disambiguation, bail and send question
       no  → existing TACO flow (unchanged)
```

**Bypass:** if the original message contains keywords `da rua|restaurante|comprei|pedi|delivery`, skip match and continue with the existing TACO flow.

### `src/lib/recipes/match.ts`
- `matchUserRecipes(userId, dishName)`:
  - Accent-strip via `food-normalize`
  - Query: `SELECT id, name, similarity(name, $1) AS sim FROM user_recipes WHERE user_id = $2 AND similarity(name, $1) > 0.4 ORDER BY sim DESC LIMIT 3`
  - Returns `[{id, name, similarity}]`
- Skip match if `dishName.length < 4`

### `src/lib/bot/flows/recipe-disambiguation.ts`
- Handler for the `recipe_disambiguation` context
- Stored in existing `conversation_context` table with `context_type = 'recipe_disambiguation'`
- Payload: `{ candidates: [{id, name}], parsed_meal: {...}, photo: {grams_estimate?, message_id?} | null, original_text: string }`
- Bot message:
  - 1 candidate: `"Vi sua receita 'Strogonoff de Carne'. Caseira ou da rua?"`
  - 2+ candidates: `"Achei suas receitas: 1) Strogonoff de Carne, 2) Strogonoff de Frango. Qual? (1/2 ou 'da rua')"`
- Reply:
  - `"caseira"` / `"sim"` / `"1"` → selects (single or first)
  - `"2"` etc → selects N
  - `"da rua"` / `"rua"` / `"não"` → continues TACO flow with the saved `parsed_meal`, clears state
  - Invalid reply → asks again

### Determining portions on the "homemade" path

```
if photo.grams_estimate exists:
   portions = grams_estimate / recipe.weight_per_serving_grams
   log via logMealFromRecipe()
   bot sends: "Registrei 1.3 porções (~325g) de Strogonoff de Carne. 494 kcal."
else if original text has explicit grams (regex "(\d+)\s?g"):
   portions = grams / recipe.weight_per_serving_grams
   log directly
else:
   bot asks "Quantas porções? (ou em gramas)"
   sub-state recipe_log_portions with {recipe_id, parsed_meal_meta}
   user replies number/grams → log
```

### `src/lib/recipes/log-meal.ts` (PR1, reused in PR2)

Single aggregate `meal_item` (not one item per recipe ingredient): cleaner history (`"Strogonoff de Carne — 1.3 servings, 494 kcal"`). Detail tracing via `llm_response.recipe_id`.

### Edge cases

- Recipe deleted between match and bot reply → graceful fallback to TACO flow
- Recipe edited between match and reply → use current snapshot at log time
- False positive (recipe "arroz" matches any lunch) → threshold 0.4 + skip if `dishName.length < 4`. Tunable.
- Multiple users with the same recipe name → RLS isolated
- User replies something unexpected during disambiguation → bot re-asks the same question

---

## Phasing and PRs

### PR1 — Web CRUD + log

**New files:**
- `supabase/migrations/00020_create_user_recipes.sql`
- `src/lib/db/queries/recipes.ts`
- `src/lib/recipes/{types,compute,log-meal}.ts`
- `src/lib/llm/schemas/recipe-parse.ts`
- `src/lib/llm/parsers/recipe-ingredients.ts`
- `src/app/(auth)/recipes/{page,new/page,[id]/page}.tsx`
- `src/app/api/recipes/{route,[id]/route,[id]/log/route,parse-ingredients/route}.ts`
- `src/components/recipes/{RecipeList,RecipeWizard,IngredientRow,LabelOverrideModal,LogRecipeModal}.tsx`

**Modified files:**
- `src/lib/db/queries/meals.ts` — widen `MealItemInput.source` to include `'recipe'` if currently narrow
- `meal_items.source` CHECK constraint via migration

### PR2 — Bot integration

**New files:**
- `src/lib/recipes/match.ts`
- `src/lib/bot/flows/recipe-disambiguation.ts`

**Modified files:**
- `src/lib/bot/flows/meal-log.ts` — call `matchUserRecipes` before TACO; bypass on keywords
- `src/lib/bot/state.ts` (or equivalent router) — register `recipe_disambiguation` and `recipe_log_portions` contexts

---

## Tests

**PR1 (Vitest):**
- `tests/unit/recipes/compute.test.ts` — pure TACO, pure label_override, mixed
- `tests/unit/recipes/log-meal.test.ts` — aggregate `meal_item` correct × portions (incl. decimal)
- `tests/unit/db/recipes.test.ts` — CRUD with mocked Supabase
- `tests/unit/llm/recipe-parse.test.ts` — Zod schema validation
- `tests/unit/api/recipes.test.ts` — auth gate, Zod, handler routing
- `tests/unit/api/recipes-id.test.ts` — GET/PUT/DELETE
- `tests/unit/api/recipes-log.test.ts` — log endpoint
- `tests/unit/api/recipes-parse.test.ts` — parse endpoint
- Integration flow tests are deferred until there is an isolated DB/test-user contract.
- Playwright E2E is deferred until the repo has `playwright.config.*`, auth bootstrap, disposable recipe data, and deterministic cleanup.

**PR2 (Vitest):**
- `tests/unit/recipes/match.test.ts` — thresholds, accent strip, top N, short-name skip
- `tests/unit/bot/flows/recipe-disambiguation.test.ts` — every reply branch (homemade/outside/invalid/multi-candidate)
- `tests/integration/bot-recipe-flow.test.ts` — text + photo, with/without match, keyword bypass
- Mocks: WhatsApp via MSW (`tests/mocks/`), LLM via fixtures

---

## End-to-End Verification

**PR1:**
1. Apply `supabase/migrations/00020_create_user_recipes.sql` on the VPS Supabase DB after backup/preflight
2. Verify `user_recipes`, `recipe_ingredients`, RLS policies, and `meal_items_source_check` directly in the VPS database
3. `npm run dev` + valid user cookie (auth via OTP)
4. Navigate `/recipes/new`. Create "Strogonoff de Carne":
   - Text: "500g ground beef, 200g onion, 150g mushroom, 200g cream"
   - Mark 1 ingredient with override (e.g., cream with packaging label)
   - Final weight 1000g, 4 servings
5. Verify the macro preview matches a manual calculation
6. Save → redirect to detail. Inspect the row in the VPS database
7. "Register meal" → 1 serving, lunch, now → confirm an entry appears in `/history`
8. Edit recipe → change to 5 servings → previous meal snapshot is preserved
9. Delete recipe → confirm cascade in `recipe_ingredients`, but meals preserved
10. Run focused recipe tests, targeted lint, `npm run build`, and type-check; document any unrelated baseline `tsc` failures

**PR2:**
1. Bot locally via ngrok
2. Text: "comi strogonoff" → bot asks "caseira ou da rua?" → "caseira" → bot asks portions → "1" → logs 1 serving
3. Text: "comi 300g de strogonoff" → "caseira" → logs 1.2 servings automatically (no prompt)
4. Photo of strogonoff plate → bot detects + asks → "caseira" → logs portions via `photo.grams_estimate / weight_per_serving_grams`
5. Text: "comi strogonoff da rua" → bypasses match (keyword), normal TACO flow
6. Recipe absent / different name → normal TACO flow (zero regression)
7. 2+ recipes with similar name → bot lists numbered → user picks
8. `npm test` + `npm run test:integration`
