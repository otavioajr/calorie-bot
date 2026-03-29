# Macros Calculation & TDEE Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add macro targets (protein, fat, carbs) based on max healthy weight (BMI 24.9), update activity factors, add athlete level, show macros in WhatsApp messages, and allow manual macro editing on the web.

**Architecture:** Extend `calculateAll` in `tdee.ts` to compute max weight and macros. Add DB columns via migration. Update onboarding finalization and meal-log progress to include macros. New `/recalcular` WhatsApp command. Extend ProfileForm with macro editing and auto-rebalancing.

**Tech Stack:** TypeScript, Next.js, Supabase (Postgres), Vitest

---

### Task 1: Update activity factors and add athlete level in `tdee.ts`

**Files:**
- Modify: `src/lib/calc/tdee.ts:1-10`
- Test: `tests/unit/calc/tdee.test.ts`

- [ ] **Step 1: Write failing tests for new factors and athlete level**

In `tests/unit/calc/tdee.test.ts`, replace the `calculateTDEE` describe block and add a test for athlete:

```typescript
describe('calculateTDEE', () => {
  const tmb = 1748.75

  it('returns correct TDEE for sedentary', () => {
    // 1748.75 * 1.4 = 2448.25
    expect(calculateTDEE(tmb, 'sedentary')).toBe(2448.25)
  })

  it('returns correct TDEE for light', () => {
    // 1748.75 * 1.5 = 2623.13
    expect(calculateTDEE(tmb, 'light')).toBe(2623.13)
  })

  it('returns correct TDEE for moderate', () => {
    // 1748.75 * 1.6 = 2798
    expect(calculateTDEE(tmb, 'moderate')).toBe(2798)
  })

  it('returns correct TDEE for intense', () => {
    // 1748.75 * 1.7 = 2972.88
    expect(calculateTDEE(tmb, 'intense')).toBe(2972.88)
  })

  it('returns correct TDEE for athlete', () => {
    // 1748.75 * 1.8 = 3147.75
    expect(calculateTDEE(tmb, 'athlete')).toBe(3147.75)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/calc/tdee.test.ts`
Expected: FAIL — factors differ, `athlete` not in type

- [ ] **Step 3: Update types and factors in `tdee.ts`**

In `src/lib/calc/tdee.ts`, update:

```typescript
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'intense' | 'athlete'

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.4,
  light: 1.5,
  moderate: 1.6,
  intense: 1.7,
  athlete: 1.8,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/calc/tdee.test.ts`
Expected: `calculateTDEE` tests PASS, but `calculateAll` test will FAIL (uses `moderate` with old factor)

- [ ] **Step 5: Update `calculateAll` test for new moderate factor**

In `tests/unit/calc/tdee.test.ts`, update the `calculateAll` test:

```typescript
describe('calculateAll', () => {
  it('returns correct tmb, tdee, and dailyTarget for integration case', () => {
    // Male, 80kg, 175cm, 30yo, moderate, lose
    // tmb: 1748.75, tdee: 1748.75 * 1.6 = 2798, dailyTarget: 2798 - 500 = 2298
    const result = calculateAll({
      sex: 'male',
      weightKg: 80,
      heightCm: 175,
      age: 30,
      activityLevel: 'moderate',
      goal: 'lose',
    })

    expect(result.tmb).toBe(1748.75)
    expect(result.tdee).toBe(2798)
    expect(result.dailyTarget).toBe(2298)
  })
})
```

- [ ] **Step 6: Run all tdee tests**

Run: `npm run test:unit -- tests/unit/calc/tdee.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/calc/tdee.ts tests/unit/calc/tdee.test.ts
git commit -m "feat: update activity factors and add athlete level"
```

---

### Task 2: Add `calculateMaxWeight` and `calculateMacros` to `tdee.ts`

**Files:**
- Modify: `src/lib/calc/tdee.ts`
- Test: `tests/unit/calc/tdee.test.ts`

- [ ] **Step 1: Write failing tests for `calculateMaxWeight`**

Add to `tests/unit/calc/tdee.test.ts`:

```typescript
import {
  calculateTMB,
  calculateTDEE,
  calculateDailyTarget,
  calculateAll,
  calculateMaxWeight,
  calculateMacros,
  recalcMacrosFromTarget,
} from '@/lib/calc/tdee'

describe('calculateMaxWeight', () => {
  it('returns correct max weight for 175cm', () => {
    // 24.9 * (1.75)^2 = 24.9 * 3.0625 = 76.26
    expect(calculateMaxWeight(175)).toBe(76.26)
  })

  it('returns correct max weight for 160cm', () => {
    // 24.9 * (1.60)^2 = 24.9 * 2.56 = 63.74
    expect(calculateMaxWeight(160)).toBe(63.74)
  })

  it('returns correct max weight for 190cm', () => {
    // 24.9 * (1.90)^2 = 24.9 * 3.61 = 89.89
    expect(calculateMaxWeight(190)).toBe(89.89)
  })
})
```

- [ ] **Step 2: Write failing tests for `calculateMacros`**

Add to `tests/unit/calc/tdee.test.ts`:

```typescript
describe('calculateMacros', () => {
  it('returns correct macros for male with 76kg max weight and 2298 target', () => {
    // protein: 76 * 2 = 152g (608 kcal)
    // fat: 76g (684 kcal)
    // carbs: (2298 - 608 - 684) / 4 = 1006 / 4 = 251.5 → 252g
    const result = calculateMacros({
      sex: 'male',
      maxWeightKg: 76,
      dailyTarget: 2298,
    })

    expect(result.proteinG).toBe(152)
    expect(result.fatG).toBe(76)
    expect(result.carbsG).toBe(252)
  })

  it('returns correct macros for female with 64kg max weight and 1800 target', () => {
    // protein: 64 * 1.6 = 102.4 → 102g (408 kcal)
    // fat: 64g (576 kcal)
    // carbs: (1800 - 408 - 576) / 4 = 816 / 4 = 204g
    const result = calculateMacros({
      sex: 'female',
      maxWeightKg: 64,
      dailyTarget: 1800,
    })

    expect(result.proteinG).toBe(102)
    expect(result.fatG).toBe(64)
    expect(result.carbsG).toBe(204)
  })

  it('returns 0 carbs when protein + fat exceed target', () => {
    const result = calculateMacros({
      sex: 'male',
      maxWeightKg: 100,
      dailyTarget: 1000,
    })

    // protein: 200g (800 kcal), fat: 100g (900 kcal) = 1700 > 1000
    expect(result.proteinG).toBe(200)
    expect(result.fatG).toBe(100)
    expect(result.carbsG).toBe(0)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/calc/tdee.test.ts`
Expected: FAIL — functions don't exist yet

- [ ] **Step 4: Implement `calculateMaxWeight` and `calculateMacros`**

Add to `src/lib/calc/tdee.ts`:

```typescript
export function calculateMaxWeight(heightCm: number): number {
  const heightM = heightCm / 100
  return round2(24.9 * heightM * heightM)
}

export function calculateMacros(params: {
  sex: Sex
  maxWeightKg: number
  dailyTarget: number
}): { proteinG: number; fatG: number; carbsG: number } {
  const proteinMultiplier = params.sex === 'male' ? 2 : 1.6
  const proteinG = Math.round(params.maxWeightKg * proteinMultiplier)
  const fatG = Math.round(params.maxWeightKg)

  const proteinKcal = proteinG * 4
  const fatKcal = fatG * 9
  const remainingKcal = params.dailyTarget - proteinKcal - fatKcal
  const carbsG = Math.max(0, Math.round(remainingKcal / 4))

  return { proteinG, fatG, carbsG }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/calc/tdee.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/calc/tdee.ts tests/unit/calc/tdee.test.ts
git commit -m "feat: add calculateMaxWeight and calculateMacros"
```

---

### Task 3: Add `recalcMacrosFromTarget` and update `calculateAll`

**Files:**
- Modify: `src/lib/calc/tdee.ts`
- Test: `tests/unit/calc/tdee.test.ts`

- [ ] **Step 1: Write failing tests for `recalcMacrosFromTarget`**

Add to `tests/unit/calc/tdee.test.ts`:

```typescript
describe('recalcMacrosFromTarget', () => {
  it('scales all macros proportionally when target increases', () => {
    // 2000 → 2200 = +10%
    const result = recalcMacrosFromTarget(
      { proteinG: 150, fatG: 80, carbsG: 200 },
      2000,
      2200,
    )

    // 150 * 1.1 = 165, 80 * 1.1 = 88, 200 * 1.1 = 220
    expect(result.proteinG).toBe(165)
    expect(result.fatG).toBe(88)
    expect(result.carbsG).toBe(220)
  })

  it('scales all macros proportionally when target decreases', () => {
    // 2000 → 1800 = -10%
    const result = recalcMacrosFromTarget(
      { proteinG: 150, fatG: 80, carbsG: 200 },
      2000,
      1800,
    )

    // 150 * 0.9 = 135, 80 * 0.9 = 72, 200 * 0.9 = 180
    expect(result.proteinG).toBe(135)
    expect(result.fatG).toBe(72)
    expect(result.carbsG).toBe(180)
  })

  it('returns zeros when old target is 0', () => {
    const result = recalcMacrosFromTarget(
      { proteinG: 150, fatG: 80, carbsG: 200 },
      0,
      2000,
    )

    expect(result.proteinG).toBe(0)
    expect(result.fatG).toBe(0)
    expect(result.carbsG).toBe(0)
  })
})
```

- [ ] **Step 2: Write failing test for updated `calculateAll`**

Replace the existing `calculateAll` test in `tests/unit/calc/tdee.test.ts`:

```typescript
describe('calculateAll', () => {
  it('returns tmb, tdee, dailyTarget, maxWeightKg, and macros', () => {
    // Male, 80kg, 175cm, 30yo, moderate, lose
    // tmb: 1748.75
    // tdee: 1748.75 * 1.6 = 2798
    // dailyTarget: 2798 - 500 = 2298
    // maxWeight: 24.9 * 1.75^2 = 76.26
    // protein: round(76.26 * 2) = 153g (612 kcal)
    // fat: round(76.26) = 76g (684 kcal)
    // carbs: (2298 - 612 - 684) / 4 = 1002 / 4 = 250.5 → 251g
    const result = calculateAll({
      sex: 'male',
      weightKg: 80,
      heightCm: 175,
      age: 30,
      activityLevel: 'moderate',
      goal: 'lose',
    })

    expect(result.tmb).toBe(1748.75)
    expect(result.tdee).toBe(2798)
    expect(result.dailyTarget).toBe(2298)
    expect(result.maxWeightKg).toBe(76.26)
    expect(result.proteinG).toBe(153)
    expect(result.fatG).toBe(76)
    expect(result.carbsG).toBe(251)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/calc/tdee.test.ts`
Expected: FAIL — `recalcMacrosFromTarget` doesn't exist, `calculateAll` doesn't return macros

- [ ] **Step 4: Implement `recalcMacrosFromTarget` and update `calculateAll`**

Add `recalcMacrosFromTarget` to `src/lib/calc/tdee.ts`:

```typescript
export function recalcMacrosFromTarget(
  currentMacros: { proteinG: number; fatG: number; carbsG: number },
  oldTarget: number,
  newTarget: number,
): { proteinG: number; fatG: number; carbsG: number } {
  if (oldTarget === 0) {
    return { proteinG: 0, fatG: 0, carbsG: 0 }
  }

  const ratio = newTarget / oldTarget
  return {
    proteinG: Math.round(currentMacros.proteinG * ratio),
    fatG: Math.round(currentMacros.fatG * ratio),
    carbsG: Math.round(currentMacros.carbsG * ratio),
  }
}
```

Update `calculateAll` return type and body:

```typescript
export function calculateAll(params: {
  sex: Sex
  weightKg: number
  heightCm: number
  age: number
  activityLevel: ActivityLevel
  goal: Goal
}): {
  tmb: number
  tdee: number
  dailyTarget: number
  maxWeightKg: number
  proteinG: number
  fatG: number
  carbsG: number
} {
  const tmb = calculateTMB(params.sex, params.weightKg, params.heightCm, params.age)
  const tdee = calculateTDEE(tmb, params.activityLevel)
  const dailyTarget = calculateDailyTarget(tdee, params.goal)
  const maxWeightKg = calculateMaxWeight(params.heightCm)
  const { proteinG, fatG, carbsG } = calculateMacros({
    sex: params.sex,
    maxWeightKg,
    dailyTarget,
  })
  return { tmb, tdee, dailyTarget, maxWeightKg, proteinG, fatG, carbsG }
}
```

- [ ] **Step 5: Run all tdee tests**

Run: `npm run test:unit -- tests/unit/calc/tdee.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/calc/tdee.ts tests/unit/calc/tdee.test.ts
git commit -m "feat: add recalcMacrosFromTarget and macros to calculateAll"
```

---

### Task 4: Database migration and User interface update

**Files:**
- Create: `supabase/migrations/00010_add_macros_and_athlete.sql`
- Modify: `src/lib/db/queries/users.ts:4-25`

- [ ] **Step 1: Create migration file**

Create `supabase/migrations/00010_add_macros_and_athlete.sql`:

```sql
-- Add macro target columns to users
ALTER TABLE users ADD COLUMN max_weight_kg DECIMAL(5,2);
ALTER TABLE users ADD COLUMN daily_protein_g INTEGER;
ALTER TABLE users ADD COLUMN daily_fat_g INTEGER;
ALTER TABLE users ADD COLUMN daily_carbs_g INTEGER;

-- Update activity_level constraint to include 'athlete'
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_activity_level_check;
ALTER TABLE users ADD CONSTRAINT users_activity_level_check
  CHECK (activity_level IN ('sedentary','light','moderate','intense','athlete'));
```

- [ ] **Step 2: Update `User` interface in `users.ts`**

In `src/lib/db/queries/users.ts`, update the `User` interface to add new fields and update `activityLevel` type:

```typescript
export interface User {
  id: string
  authId: string | null
  phone: string
  name: string
  sex: 'male' | 'female' | null
  age: number | null
  weightKg: number | null
  heightCm: number | null
  activityLevel: 'sedentary' | 'light' | 'moderate' | 'intense' | 'athlete' | null
  goal: 'lose' | 'maintain' | 'gain' | null
  calorieMode: 'taco' | 'manual'
  dailyCalorieTarget: number | null
  calorieTargetManual: boolean
  tmb: number | null
  tdee: number | null
  maxWeightKg: number | null
  dailyProteinG: number | null
  dailyFatG: number | null
  dailyCarbsG: number | null
  timezone: string
  onboardingComplete: boolean
  onboardingStep: number
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `npm run test:unit`
Expected: ALL PASS (interface changes are backward-compatible — new fields are nullable)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00010_add_macros_and_athlete.sql src/lib/db/queries/users.ts
git commit -m "feat: add macros columns and athlete level to DB schema"
```

---

### Task 5: Update validator for athlete level

**Files:**
- Modify: `src/lib/utils/validators.ts:129-153`
- Test: `tests/unit/calc/tdee.test.ts` (validators are tested in onboarding tests but let's verify router test)

- [ ] **Step 1: Write failing test for athlete validation**

Create a new test file `tests/unit/utils/validators.test.ts` (or add to existing). Since onboarding tests cover validators indirectly, add a direct test:

```typescript
import { describe, it, expect } from 'vitest'
import { validateActivityLevel } from '@/lib/utils/validators'

describe('validateActivityLevel', () => {
  it('returns athlete for "5"', () => {
    const result = validateActivityLevel('5')
    expect(result).toEqual({ valid: true, value: 'athlete' })
  })

  it('returns athlete for "atleta"', () => {
    const result = validateActivityLevel('atleta')
    expect(result).toEqual({ valid: true, value: 'athlete' })
  })

  it('returns athlete for "athlete"', () => {
    const result = validateActivityLevel('athlete')
    expect(result).toEqual({ valid: true, value: 'athlete' })
  })

  it('still returns sedentary for "1"', () => {
    const result = validateActivityLevel('1')
    expect(result).toEqual({ valid: true, value: 'sedentary' })
  })

  it('returns error for "6"', () => {
    const result = validateActivityLevel('6')
    expect(result.valid).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/utils/validators.test.ts`
Expected: FAIL — `5` and `atleta` return invalid

- [ ] **Step 3: Update `validateActivityLevel` in validators.ts**

In `src/lib/utils/validators.ts`, add athlete case and update error message:

```typescript
export function validateActivityLevel(input: string): ValidationResult<ActivityLevel> {
  const key = normalize(input)

  if (key === '1' || key === 'sedentario') {
    return { valid: true, value: 'sedentary' }
  }

  if (key === '2' || key === 'leve') {
    return { valid: true, value: 'light' }
  }

  if (key === '3' || key === 'moderado') {
    return { valid: true, value: 'moderate' }
  }

  if (key === '4' || key === 'intenso') {
    return { valid: true, value: 'intense' }
  }

  if (key === '5' || key === 'atleta' || key === 'athlete') {
    return { valid: true, value: 'athlete' }
  }

  return {
    valid: false,
    error:
      'Opção inválida. Digite 1 (sedentário), 2 (leve), 3 (moderado), 4 (intenso) ou 5 (atleta).',
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/utils/validators.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/validators.ts tests/unit/utils/validators.test.ts
git commit -m "feat: add athlete validation to activity level"
```

---

### Task 6: Update onboarding to include macros

**Files:**
- Modify: `src/lib/bot/flows/onboarding.ts:39,175-217`
- Modify: `src/lib/utils/formatters.ts:210-213`
- Test: `tests/unit/bot/onboarding.test.ts`

- [ ] **Step 1: Update `formatOnboardingComplete` to accept macros**

In `src/lib/utils/formatters.ts`, update the function signature and body:

```typescript
export function formatOnboardingComplete(
  name: string,
  target: number,
  macros?: { proteinG: number; fatG: number; carbsG: number },
): string {
  const macroLine = macros
    ? `\nProteína: ${macros.proteinG}g | Gordura: ${macros.fatG}g | Carbs: ${macros.carbsG}g`
    : ''

  return `Tudo pronto, ${name}! 🎉\nSua meta diária é de ${target} kcal.${macroLine}\n\nAgora é só me mandar o que comeu! Exemplos:\n• 'almocei arroz, feijão e frango'\n• 'comi um pão com ovo no café'\n• 'lanche: 1 banana e granola'\n\nDica: manda 'menu' a qualquer momento pra ver o que posso fazer.`
}
```

- [ ] **Step 2: Update onboarding activity message to include athlete**

In `src/lib/bot/flows/onboarding.ts`, update `MSG_ASK_ACTIVITY`:

```typescript
const MSG_ASK_ACTIVITY = `Qual seu nível de atividade física?\n1️⃣ Sedentário (pouco ou nenhum exercício)\n2️⃣ Leve (1-3 dias/semana)\n3️⃣ Moderado (3-5 dias/semana)\n4️⃣ Intenso (6-7 dias/semana)\n5️⃣ Atleta (treino intenso 2x/dia)`
```

- [ ] **Step 3: Update onboarding step 8 to persist macros**

In `src/lib/bot/flows/onboarding.ts`, update step 8 finalization (around line 188-214):

```typescript
  if (currentStep === 8) {
    const result = validateCalorieMode(message)
    if (!result.valid) {
      return { response: result.error, completed: false }
    }
    const calorieMode = result.value

    // Save calorie mode first
    await updateUser(supabase, userId, { calorieMode })

    // Fetch full user data from DB for TMB/TDEE calculation
    const { user } = await getUserWithSettings(supabase, userId)

    // Calculate TMB, TDEE, daily target, and macros
    const calcResult = calculateAll({
      sex: user.sex!,
      weightKg: user.weightKg!,
      heightCm: user.heightCm!,
      age: user.age!,
      activityLevel: user.activityLevel!,
      goal: user.goal!,
    })

    // Persist calculations and mark onboarding complete
    await updateUser(supabase, userId, {
      tmb: calcResult.tmb,
      tdee: calcResult.tdee,
      dailyCalorieTarget: Math.round(calcResult.dailyTarget),
      maxWeightKg: calcResult.maxWeightKg,
      dailyProteinG: calcResult.proteinG,
      dailyFatG: calcResult.fatG,
      dailyCarbsG: calcResult.carbsG,
      onboardingComplete: true,
      onboardingStep: 8,
    })

    // Create default settings for the new user
    await createDefaultSettings(supabase, userId)

    // Clear the onboarding context
    await clearState(userId)

    return {
      response: formatOnboardingComplete(user.name, calcResult.dailyTarget, {
        proteinG: calcResult.proteinG,
        fatG: calcResult.fatG,
        carbsG: calcResult.carbsG,
      }),
      completed: true,
    }
  }
```

- [ ] **Step 4: Update onboarding tests**

In `tests/unit/bot/onboarding.test.ts`:

1. Update the step 6 invalid test — `'5'` is now valid (athlete), so change the invalid input to `'6'`:

```typescript
  it('invalid activity: returns error, completed false', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '6', 6)

    expect(result.completed).toBe(false)
    expect(result.response).toContain('sedentário')
  })
```

2. Add a test for athlete in step 6:

```typescript
  it('valid activity "5" (athlete): calls updateUser with activityLevel: "athlete"', async () => {
    await handleOnboarding(supabase, USER_ID, '5', 6)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({ activityLevel: 'athlete', onboardingStep: 7 }),
    )
  })
```

3. Update the `calculateAll` integration test to use the new factor values:

```typescript
  it('tmb/tdee values are calculated correctly from mock user data', async () => {
    // For João: male, 72.5kg, 175cm, age 28, moderate, lose
    // TMB = 10*72.5 + 6.25*175 - 5*28 + 5 = 725 + 1093.75 - 140 + 5 = 1683.75
    // TDEE = 1683.75 * 1.6 = 2694
    // dailyTarget = 2694 - 500 = 2194
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({
        tmb: 1683.75,
        tdee: 2694,
        dailyCalorieTarget: 2194,
      }),
    )
  })
```

4. Add a test that macros are persisted:

```typescript
  it('valid mode: updateUser called with macros', async () => {
    await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(mockUpdateUser).toHaveBeenCalledWith(
      supabase,
      USER_ID,
      expect.objectContaining({
        maxWeightKg: expect.any(Number),
        dailyProteinG: expect.any(Number),
        dailyFatG: expect.any(Number),
        dailyCarbsG: expect.any(Number),
      }),
    )
  })
```

5. Update the completion message test to check for macros:

```typescript
  it('valid mode "1": response contains macros breakdown', async () => {
    const result = await handleOnboarding(supabase, USER_ID, '1', 8)

    expect(result.response).toContain('Proteína:')
    expect(result.response).toContain('Gordura:')
    expect(result.response).toContain('Carbs:')
  })
```

- [ ] **Step 5: Run onboarding tests**

Run: `npm run test:unit -- tests/unit/bot/onboarding.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/flows/onboarding.ts src/lib/utils/formatters.ts tests/unit/bot/onboarding.test.ts
git commit -m "feat: include macros in onboarding finalization message"
```

---

### Task 7: Add `/recalcular` command

**Files:**
- Modify: `src/lib/bot/router.ts`
- Create: `src/lib/bot/flows/recalculate.ts`
- Modify: `src/lib/bot/handler.ts`
- Test: `tests/unit/bot/router.test.ts`

- [ ] **Step 1: Add `recalculate` intent to router**

In `src/lib/bot/router.ts`:

1. Add `'recalculate'` to the `IntentType` union:

```typescript
export type IntentType =
  | 'meal_log'
  | 'summary'
  | 'edit'
  | 'query'
  | 'weight'
  | 'help'
  | 'settings'
  | 'user_data'
  | 'recalculate'
  | 'out_of_scope'
```

2. Add recalculate keywords (before user_data check, after weight):

```typescript
const RECALCULATE_KEYWORDS: readonly string[] = [
  'recalcular',
  '/recalcular',
  'recalcula',
]
```

3. Add the check in `classifyByRules` between weight (5) and query (6):

```typescript
  // 5.5. recalculate
  for (const kw of RECALCULATE_KEYWORDS) {
    if (normalized.includes(kw)) return 'recalculate'
  }
```

- [ ] **Step 2: Write router tests for recalculate**

Add to `tests/unit/bot/router.test.ts`:

```typescript
  describe('recalculate intent', () => {
    it('returns recalculate for "recalcular"', () => {
      expect(classifyByRules('recalcular')).toBe<IntentType>('recalculate')
    })

    it('returns recalculate for "/recalcular"', () => {
      expect(classifyByRules('/recalcular')).toBe<IntentType>('recalculate')
    })

    it('returns recalculate for "recalcula"', () => {
      expect(classifyByRules('recalcula')).toBe<IntentType>('recalculate')
    })

    it('returns recalculate for "Recalcular" (case insensitive)', () => {
      expect(classifyByRules('Recalcular')).toBe<IntentType>('recalculate')
    })
  })
```

- [ ] **Step 3: Run router tests**

Run: `npm run test:unit -- tests/unit/bot/router.test.ts`
Expected: PASS

- [ ] **Step 4: Create `recalculate.ts` flow**

Create `src/lib/bot/flows/recalculate.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import { getUserWithSettings, updateUser } from '@/lib/db/queries/users'
import { calculateAll } from '@/lib/calc/tdee'
import type { Sex, ActivityLevel, Goal } from '@/lib/calc/tdee'

export async function handleRecalculate(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { user } = await getUserWithSettings(supabase, userId)

  if (!user.onboardingComplete) {
    return 'Você precisa completar o cadastro primeiro! Me manda "oi" pra começar.'
  }

  if (!user.sex || !user.weightKg || !user.heightCm || !user.age || !user.activityLevel || !user.goal) {
    return 'Seus dados de perfil estão incompletos. Atualize pelo site ou entre em contato.'
  }

  const result = calculateAll({
    sex: user.sex as Sex,
    weightKg: user.weightKg,
    heightCm: user.heightCm,
    age: user.age,
    activityLevel: user.activityLevel as ActivityLevel,
    goal: user.goal as Goal,
  })

  await updateUser(supabase, userId, {
    tmb: result.tmb,
    tdee: result.tdee,
    dailyCalorieTarget: Math.round(result.dailyTarget),
    maxWeightKg: result.maxWeightKg,
    dailyProteinG: result.proteinG,
    dailyFatG: result.fatG,
    dailyCarbsG: result.carbsG,
  })

  return [
    'Recalculado! ✅',
    `Meta: ${Math.round(result.dailyTarget)} kcal`,
    `Proteína: ${result.proteinG}g | Gordura: ${result.fatG}g | Carbs: ${result.carbsG}g`,
  ].join('\n')
}
```

- [ ] **Step 5: Wire recalculate into handler.ts**

In `src/lib/bot/handler.ts`:

1. Add import at the top (after other flow imports):

```typescript
import { handleRecalculate } from '@/lib/bot/flows/recalculate'
```

2. Add case in the intent switch (around line 122, after `weight` case):

```typescript
      case 'recalculate':
        response = await handleRecalculate(supabase, user.id)
        break
```

- [ ] **Step 6: Run full test suite**

Run: `npm run test:unit`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/router.ts src/lib/bot/flows/recalculate.ts src/lib/bot/handler.ts tests/unit/bot/router.test.ts
git commit -m "feat: add /recalcular command for recalculating macros"
```

---

### Task 8: Update meal-log progress to show macros

**Files:**
- Modify: `src/lib/utils/formatters.ts:197-206`
- Modify: `src/lib/db/queries/meals.ts`
- Modify: `src/lib/bot/flows/meal-log.ts`
- Modify: `src/lib/bot/handler.ts`

- [ ] **Step 1: Add `getDailyMacros` query**

In `src/lib/db/queries/meals.ts`, add a new function after `getDailyCalories`:

```typescript
export interface DailyMacros {
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

/**
 * Returns the total calories and macros consumed by a user on the given date.
 * Sums from meal_items via a join on meals.
 */
export async function getDailyMacros(
  supabase: SupabaseClient,
  userId: string,
  date?: Date,
): Promise<DailyMacros> {
  const targetDate = date ?? new Date()

  const startOfDay = new Date(targetDate)
  startOfDay.setUTCHours(0, 0, 0, 0)

  const endOfDay = new Date(targetDate)
  endOfDay.setUTCHours(23, 59, 59, 999)

  const { data, error } = await supabase
    .from('meal_items')
    .select('calories, protein_g, carbs_g, fat_g, meal:meals!inner(user_id, registered_at)')
    .eq('meal.user_id', userId)
    .gte('meal.registered_at', startOfDay.toISOString())
    .lte('meal.registered_at', endOfDay.toISOString())

  if (error) {
    throw new Error(`Failed to get daily macros: ${error.message}`)
  }

  if (!data || data.length === 0) {
    return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  }

  const rows = data as Array<Record<string, unknown>>
  return {
    calories: Math.round(rows.reduce((sum, r) => sum + (r.calories as number || 0), 0)),
    proteinG: Math.round(rows.reduce((sum, r) => sum + (r.protein_g as number || 0), 0)),
    carbsG: Math.round(rows.reduce((sum, r) => sum + (r.carbs_g as number || 0), 0)),
    fatG: Math.round(rows.reduce((sum, r) => sum + (r.fat_g as number || 0), 0)),
  }
}
```

- [ ] **Step 2: Update `formatProgress` to optionally include macros**

In `src/lib/utils/formatters.ts`, update `formatProgress`:

```typescript
export function formatProgress(
  consumed: number,
  target: number,
  macros?: {
    consumed: { proteinG: number; fatG: number; carbsG: number }
    target: { proteinG: number; fatG: number; carbsG: number }
  },
): string {
  const remaining = target - consumed

  let calorieLine: string
  if (remaining < 0) {
    const over = Math.abs(remaining)
    calorieLine = `📊 Hoje: ${consumed} / ${target} kcal (excedeu ${over} ⚠️)`
  } else {
    calorieLine = `📊 Hoje: ${consumed} / ${target} kcal (restam ${remaining})`
  }

  if (!macros) {
    return calorieLine
  }

  const macroLine = `P: ${macros.consumed.proteinG}/${macros.target.proteinG}g | G: ${macros.consumed.fatG}/${macros.target.fatG}g | C: ${macros.consumed.carbsG}/${macros.target.carbsG}g`
  return `${calorieLine}\n${macroLine}`
}
```

- [ ] **Step 3: Update meal-log to pass macros to formatProgress**

In `src/lib/bot/flows/meal-log.ts`:

1. Update the import to include `getDailyMacros`:

```typescript
import { createMeal, getDailyCalories, getDailyMacros } from '@/lib/db/queries/meals'
```

2. Update the `handleMealLog` function signature to accept macro targets:

```typescript
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
  },
  context: ConversationContext | null,
): Promise<MealLogResult> {
```

3. Update `handleConfirmation` — after the meal is saved, fetch daily macros and pass to `formatProgress`:

```typescript
async function handleConfirmation(
  supabase: SupabaseClient,
  userId: string,
  context: ConversationContext,
  user: {
    calorieMode: string
    dailyCalorieTarget: number | null
    dailyProteinG?: number | null
    dailyFatG?: number | null
    dailyCarbsG?: number | null
  },
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

  const target = user.dailyCalorieTarget ?? 2000
  const hasMacroTargets = user.dailyProteinG && user.dailyFatG && user.dailyCarbsG

  let progressLine: string
  if (hasMacroTargets) {
    const dailyMacros = await getDailyMacros(supabase, userId)
    progressLine = formatProgress(dailyMacros.calories, target, {
      consumed: { proteinG: dailyMacros.proteinG, fatG: dailyMacros.fatG, carbsG: dailyMacros.carbsG },
      target: { proteinG: user.dailyProteinG!, fatG: user.dailyFatG!, carbsG: user.dailyCarbsG! },
    })
  } else {
    const dailyConsumed = await getDailyCalories(supabase, userId)
    progressLine = formatProgress(dailyConsumed, target)
  }

  const label = meals.length > 1 ? 'Refeições registradas' : 'Refeição registrada'
  return { response: `${label}! ✅\n\n${progressLine}`, completed: true }
}
```

- [ ] **Step 4: Update handler.ts to pass macro targets to meal-log**

In `src/lib/bot/handler.ts`, update `userSettings` (around line 61):

```typescript
    const userSettings = {
      calorieMode: user.calorieMode,
      dailyCalorieTarget: user.dailyCalorieTarget,
      dailyProteinG: user.dailyProteinG,
      dailyFatG: user.dailyFatG,
      dailyCarbsG: user.dailyCarbsG,
      phone: from,
    }
```

- [ ] **Step 5: Run full test suite**

Run: `npm run test:unit`
Expected: ALL PASS (meal-log tests use mocked users without macros, so `formatProgress` uses the calorie-only path)

- [ ] **Step 6: Commit**

```bash
git add src/lib/utils/formatters.ts src/lib/db/queries/meals.ts src/lib/bot/flows/meal-log.ts src/lib/bot/handler.ts
git commit -m "feat: show macro progress in meal-log confirmation"
```

---

### Task 9: Update ProfileForm to show and edit macros

**Files:**
- Modify: `src/components/settings/ProfileForm.tsx`
- Modify: `src/app/api/user/profile/route.ts`

- [ ] **Step 1: Update the profile API to handle macros**

In `src/app/api/user/profile/route.ts`, update to persist macros and return them:

```typescript
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { updateUser } from '@/lib/db/queries/users'
import { calculateAll, recalcMacrosFromTarget } from '@/lib/calc/tdee'
import type { Sex, ActivityLevel, Goal } from '@/lib/calc/tdee'

export async function PUT(request: Request): Promise<NextResponse> {
  const cookieStore = await cookies()
  const userId = cookieStore.get('caloriebot-user-id')?.value

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const {
    name, age, sex, weightKg, heightCm, activityLevel, goal,
    dailyProteinG, dailyFatG, dailyCarbsG,
  } = body

  try {
    const supabase = createServiceRoleClient()

    const updateData: Record<string, unknown> = {}
    if (name !== undefined) updateData.name = name
    if (age !== undefined) updateData.age = age
    if (sex !== undefined) updateData.sex = sex
    if (weightKg !== undefined) updateData.weightKg = weightKg
    if (heightCm !== undefined) updateData.heightCm = heightCm
    if (activityLevel !== undefined) updateData.activityLevel = activityLevel
    if (goal !== undefined) updateData.goal = goal

    // Handle manual macro overrides
    if (dailyProteinG !== undefined) updateData.dailyProteinG = dailyProteinG
    if (dailyFatG !== undefined) updateData.dailyFatG = dailyFatG
    if (dailyCarbsG !== undefined) updateData.dailyCarbsG = dailyCarbsG

    // Recalculate TDEE if enough data
    let calcResult: ReturnType<typeof calculateAll> | null = null
    const effectiveSex = (sex as Sex | null) ?? null
    const effectiveWeight = (weightKg as number | null) ?? null
    const effectiveHeight = (heightCm as number | null) ?? null
    const effectiveAge = (age as number | null) ?? null
    const effectiveActivity = (activityLevel as ActivityLevel | null) ?? null
    const effectiveGoal = (goal as Goal | null) ?? null

    if (
      effectiveSex &&
      effectiveWeight &&
      effectiveHeight &&
      effectiveAge &&
      effectiveActivity &&
      effectiveGoal
    ) {
      calcResult = calculateAll({
        sex: effectiveSex,
        weightKg: effectiveWeight,
        heightCm: effectiveHeight,
        age: effectiveAge,
        activityLevel: effectiveActivity,
        goal: effectiveGoal,
      })
      updateData.tmb = calcResult.tmb
      updateData.tdee = calcResult.tdee
      updateData.dailyCalorieTarget = Math.round(calcResult.dailyTarget)
      updateData.maxWeightKg = calcResult.maxWeightKg

      // Only set calculated macros if not manually overriding
      if (dailyProteinG === undefined && dailyFatG === undefined && dailyCarbsG === undefined) {
        updateData.dailyProteinG = calcResult.proteinG
        updateData.dailyFatG = calcResult.fatG
        updateData.dailyCarbsG = calcResult.carbsG
      }
    }

    await updateUser(supabase, userId, updateData as Parameters<typeof updateUser>[2])

    return NextResponse.json({
      success: true,
      tmb: calcResult?.tmb,
      tdee: calcResult?.tdee,
      dailyTarget: calcResult ? Math.round(calcResult.dailyTarget) : undefined,
      maxWeightKg: calcResult?.maxWeightKg,
      proteinG: (updateData.dailyProteinG as number | undefined) ?? calcResult?.proteinG,
      fatG: (updateData.dailyFatG as number | undefined) ?? calcResult?.fatG,
      carbsG: (updateData.dailyCarbsG as number | undefined) ?? calcResult?.carbsG,
    })
  } catch (err) {
    console.error('[profile update] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Update ProfileForm to show athlete option and display/edit macros**

In `src/components/settings/ProfileForm.tsx`, make these changes:

1. Update `ProfileSaveResult` interface:

```typescript
interface ProfileSaveResult {
  success: boolean
  tmb?: number
  tdee?: number
  dailyTarget?: number
  maxWeightKg?: number
  proteinG?: number
  fatG?: number
  carbsG?: number
  error?: string
}
```

2. Add state for macros (after existing useState declarations):

```typescript
  const [proteinG, setProteinG] = useState<number | null>(user.dailyProteinG ?? null)
  const [fatG, setFatG] = useState<number | null>(user.dailyFatG ?? null)
  const [carbsG, setCarbsG] = useState<number | null>(user.dailyCarbsG ?? null)
  const [editingMacros, setEditingMacros] = useState(false)
```

3. Add athlete option to activity level Select:

```typescript
<SelectItem value="athlete">Atleta (treino intenso 2x/dia)</SelectItem>
```

4. Update result state setter in `handleSubmit`:

```typescript
      if (data.tmb) {
        setResult({
          tmb: data.tmb,
          tdee: data.tdee,
          dailyTarget: data.dailyTarget,
        })
      }
      if (data.proteinG !== undefined) {
        setProteinG(data.proteinG ?? null)
        setFatG(data.fatG ?? null)
        setCarbsG(data.carbsG ?? null)
      }
```

5. Add macro rebalance functions:

```typescript
  function rebalanceCarbsFromProteinFat(newProtein: number, newFat: number) {
    const target = result?.dailyTarget ?? user.dailyCalorieTarget ?? 2000
    const remaining = target - newProtein * 4 - newFat * 9
    setCarbsG(Math.max(0, Math.round(remaining / 4)))
  }

  function rebalanceProteinFatFromCarbs(newCarbs: number) {
    const target = result?.dailyTarget ?? user.dailyCalorieTarget ?? 2000
    const currentProtein = proteinG ?? 0
    const currentFat = fatG ?? 0
    const oldPFKcal = currentProtein * 4 + currentFat * 9
    if (oldPFKcal === 0) return
    const newPFKcal = target - newCarbs * 4
    if (newPFKcal <= 0) return
    const ratio = newPFKcal / oldPFKcal
    setProteinG(Math.round(currentProtein * ratio))
    setFatG(Math.round(currentFat * ratio))
  }

  async function saveMacros() {
    setLoading(true)
    try {
      const res = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyProteinG: proteinG,
          dailyFatG: fatG,
          dailyCarbsG: carbsG,
        }),
      })
      const data = (await res.json()) as ProfileSaveResult
      if (!res.ok || !data.success) {
        setMessage({ type: "error", text: data.error ?? "Erro ao salvar macros." })
        return
      }
      setMessage({ type: "success", text: "Macros salvos com sucesso!" })
      setEditingMacros(false)
    } catch {
      setMessage({ type: "error", text: "Erro de conexão." })
    } finally {
      setLoading(false)
    }
  }
```

6. Add macros display/edit section (after the TDEE result block, before the submit button):

```tsx
      {/* Macros Display / Edit */}
      {(proteinG !== null || fatG !== null || carbsG !== null) && (
        <div className="bg-accent/50 rounded-lg p-4 space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <p className="font-medium text-accent-foreground">Macros diários:</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditingMacros(!editingMacros)}
            >
              {editingMacros ? "Cancelar" : "Editar"}
            </Button>
          </div>

          {editingMacros ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="protein" className="text-xs">Proteína (g)</Label>
                  <Input
                    id="protein"
                    type="number"
                    min={0}
                    value={String(proteinG ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setProteinG(v)
                      rebalanceCarbsFromProteinFat(v, fatG ?? 0)
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fat" className="text-xs">Gordura (g)</Label>
                  <Input
                    id="fat"
                    type="number"
                    min={0}
                    value={String(fatG ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setFatG(v)
                      rebalanceCarbsFromProteinFat(proteinG ?? 0, v)
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="carbs" className="text-xs">Carbs (g)</Label>
                  <Input
                    id="carbs"
                    type="number"
                    min={0}
                    value={String(carbsG ?? 0)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setCarbsG(v)
                      rebalanceProteinFatFromCarbs(v)
                    }}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Total: {((proteinG ?? 0) * 4 + (fatG ?? 0) * 9 + (carbsG ?? 0) * 4).toLocaleString("pt-BR")} kcal
              </p>
              <Button type="button" size="sm" onClick={saveMacros} disabled={loading}>
                {loading ? "Salvando..." : "Salvar macros"}
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-muted-foreground">Proteína: <span className="font-semibold text-foreground">{proteinG}g</span></p>
              <p className="text-muted-foreground">Gordura: <span className="font-semibold text-foreground">{fatG}g</span></p>
              <p className="text-muted-foreground">Carbs: <span className="font-semibold text-foreground">{carbsG}g</span></p>
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/ProfileForm.tsx src/app/api/user/profile/route.ts
git commit -m "feat: add macro display and manual editing to ProfileForm"
```

---

### Task 10: Final integration test and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `npm run test:unit`
Expected: ALL PASS

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Check for any remaining references to old activity factors**

Search for old factor values (1.2, 1.375, 1.55, 1.725) in the codebase:

Run: `grep -rn "1\.375\|1\.725" src/`
Expected: No matches (all updated to new factors)

- [ ] **Step 4: Commit any cleanup needed**

```bash
git add -A
git commit -m "chore: final cleanup for macros calculation feature"
```
