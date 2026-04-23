# Quoted Meal Type Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make quoted meal edits understand commands that move whole meal to another `meal_type`.

**Architecture:** Extend correction parsing with explicit `change_meal_type` action, then handle that action only in quoted meal edit flow. Update happens on `meals.meal_type`; meal items stay untouched.

**Tech Stack:** TypeScript, Next.js App Router, Supabase query helpers, Vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/lib/llm/schemas/correction.ts` | Add `change_meal_type` action |
| Modify | `src/lib/llm/prompts/correction.ts` | Teach prompt to emit meal-type changes |
| Modify | `src/lib/db/queries/meals.ts` | Add `updateMealType()` helper |
| Modify | `src/lib/bot/flows/edit.ts` | Apply quoted meal-type change and respond |
| Modify | `tests/unit/llm/correction-schema.test.ts` | Cover new schema action |
| Modify | `tests/unit/db/meals-detail.test.ts` | Cover `updateMealType()` helper |
| Modify | `tests/unit/bot/edit.test.ts` | Cover quoted whole-meal move behavior |

### Task 1: Add failing tests for schema and quoted edit flow

**Files:**
- Modify: `tests/unit/llm/correction-schema.test.ts`
- Modify: `tests/unit/bot/edit.test.ts`

- [ ] **Step 1: Write failing schema test**

Add case asserting `CorrectionSchema.parse({ action: 'change_meal_type', target_meal_type: 'breakfast', confidence: 'high' })` succeeds.

- [ ] **Step 2: Write failing quoted edit test**

Add case asserting quoted `trocar para o café da manhã`:
- calls DB helper to update meal type
- does not call item removal or item rename paths
- returns response mentioning old and new meal label

- [ ] **Step 3: Run targeted tests and verify RED**

Run: `npx vitest run tests/unit/llm/correction-schema.test.ts tests/unit/bot/edit.test.ts`

Expected: fail because `change_meal_type` not supported yet.

### Task 2: Add DB helper with failing test first

**Files:**
- Modify: `tests/unit/db/meals-detail.test.ts`
- Modify: `src/lib/db/queries/meals.ts`

- [ ] **Step 1: Write failing DB helper test**

Add case asserting `updateMealType(supabase, 'meal-1', 'breakfast')` updates `meals.meal_type`.

- [ ] **Step 2: Run targeted DB test and verify RED**

Run: `npx vitest run tests/unit/db/meals-detail.test.ts`

Expected: fail because `updateMealType` does not exist yet.

- [ ] **Step 3: Implement minimal DB helper**

Add `updateMealType()` in `src/lib/db/queries/meals.ts`.

- [ ] **Step 4: Re-run DB test and verify GREEN**

Run: `npx vitest run tests/unit/db/meals-detail.test.ts`

Expected: pass.

### Task 3: Implement correction parsing and quoted edit behavior

**Files:**
- Modify: `src/lib/llm/schemas/correction.ts`
- Modify: `src/lib/llm/prompts/correction.ts`
- Modify: `src/lib/bot/flows/edit.ts`

- [ ] **Step 1: Implement minimal schema change**

Add `change_meal_type` to correction action enum.

- [ ] **Step 2: Implement prompt change**

Teach prompt examples and rules to emit `change_meal_type` when user moves whole quoted meal to breakfast/lunch/snack/dinner/supper.

- [ ] **Step 3: Implement quoted edit handling**

Handle `change_meal_type` only when quoted meal context is active. Use `updateMealType()`, preserve items, clear state, recompute daily progress, and short-circuit with “already in this type” when target equals current type.

- [ ] **Step 4: Re-run targeted tests and verify GREEN**

Run: `npx vitest run tests/unit/llm/correction-schema.test.ts tests/unit/bot/edit.test.ts tests/unit/db/meals-detail.test.ts`

Expected: pass.

### Task 4: Final verification

**Files:**
- No new files

- [ ] **Step 1: Run full focused verification**

Run: `npx vitest run tests/unit/llm/correction-schema.test.ts tests/unit/bot/edit.test.ts tests/unit/db/meals-detail.test.ts`

Expected: all pass.

- [ ] **Step 2: Run lint on touched files if repo setup allows**

Run: `npm run lint -- src/lib/llm/schemas/correction.ts src/lib/llm/prompts/correction.ts src/lib/db/queries/meals.ts src/lib/bot/flows/edit.ts tests/unit/llm/correction-schema.test.ts tests/unit/db/meals-detail.test.ts tests/unit/bot/edit.test.ts`

Expected: pass or identify pre-existing lint constraint.

