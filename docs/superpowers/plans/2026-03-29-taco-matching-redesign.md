# TACO Matching Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the TACO food matching pipeline to use base-name matching with intelligent defaults, replacing the fuzzy-only approach that fails for short/generic food names.

**Architecture:** Split food names into `food_base` + `food_variant`, add `is_default` flag for common foods, create `taco_food_usage` table for learning defaults from user confirmations, and implement a 4-step matching pipeline (exact → base+default → decomposition → LLM fallback).

**Tech Stack:** PostgreSQL (Supabase), TypeScript, Vitest, Python (conversion script)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `scripts/convert-taco-xlsx.py` | Add `food_base`, `food_variant` to JSON output |
| Regenerate | `docs/taco_foods_extracted.json` | Clean JSON with new fields |
| Create | `supabase/migrations/00011_taco_base_variant_defaults.sql` | Schema changes: new columns, new table, new RPC functions |
| Modify | `scripts/seed-taco.ts` | Map `food_base`, `food_variant`, `is_default` to DB |
| Modify | `src/lib/db/queries/taco.ts` | New interfaces, base matching, usage tracking functions |
| Modify | `src/lib/bot/flows/meal-log.ts` | New 4-step matching pipeline, `usedDefault` flag, usage recording |
| Modify | `src/lib/utils/formatters.ts` | Default notice in confirmation message |
| Modify | `tests/unit/db/taco.test.ts` | Tests for new matching functions |
| Modify | `tests/unit/bot/meal-log.test.ts` | Tests for new pipeline behavior |

---

### Task 1: Update conversion script and regenerate JSON

**Files:**
- Modify: `scripts/convert-taco-xlsx.py`
- Regenerate: `docs/taco_foods_extracted.json`

- [ ] **Step 1: Add `food_base` and `food_variant` to the conversion script**

In `scripts/convert-taco-xlsx.py`, update the `main()` function to split the name on the first comma:

```python
def main():
    wb = openpyxl.load_workbook(INPUT, read_only=True)
    ws = wb["CMVCol taco3"]
    rows = list(ws.iter_rows(values_only=True))

    # Skip header rows (0, 1, 2)
    data_rows = rows[3:]

    foods = []
    number = 0

    for row in data_rows:
        cols = list(row)
        name = cols[1]

        # Skip empty rows
        if not name or str(name).strip() == "":
            continue

        number += 1
        full_name = str(name).strip()

        # Split on first comma: "Banana, prata, crua" → base="Banana", variant="prata, crua"
        parts = full_name.split(",", 1)
        food_base = parts[0].strip()
        food_variant = parts[1].strip() if len(parts) > 1 else ""

        food = {
            "number": number,
            "name": full_name,
            "food_base": food_base,
            "food_variant": food_variant,
        }

        for col_idx, field in COLUMNS.items():
            if field == "name":
                continue
            food[field] = parse_value(cols[col_idx] if col_idx < len(cols) else None)

        foods.append(food)

    # Write JSON
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(foods, f, ensure_ascii=False, indent=2)

    print(f"Extracted {len(foods)} foods to {OUTPUT}")

    # Quick validation
    zero_energy = [f for f in foods if f["energy_kcal"] == 0 or f["energy_kcal"] is None]
    zero_sodium = [f for f in foods if f["sodium_per_100g"] == 0 or f["sodium_per_100g"] is None]
    print(f"  Zero/null energy: {len(zero_energy)}")
    print(f"  Zero/null sodium: {len(zero_sodium)}")

    # Validate base/variant split
    from collections import Counter
    base_counts = Counter(f["food_base"] for f in foods)
    multi_variant = [(b, c) for b, c in base_counts.most_common() if c > 1]
    print(f"  Bases with multiple variants: {len(multi_variant)}")

    # Spot check
    for f in foods:
        if f["name"] == "Arroz, integral, cozido":
            print(f"\n  Spot check — {f['name']}:")
            print(f"    base={f['food_base']}, variant={f['food_variant']}")
            print(f"    energy={f['energy_kcal']} kcal, sodium={f['sodium_per_100g']}mg")
            break
```

- [ ] **Step 2: Run the conversion script and validate**

Run: `python3 scripts/convert-taco-xlsx.py`

Expected output:
```
Extracted 597 foods to docs/taco_foods_extracted.json
  Zero/null energy: 6
  Zero/null sodium: 75
  Bases with multiple variants: 107

  Spot check — Arroz, integral, cozido:
    base=Arroz, variant=integral, cozido
    energy=123.53 kcal, sodium=1.24mg
```

Then validate the JSON:
```bash
python3 -c "
import json
with open('docs/taco_foods_extracted.json') as f:
    data = json.load(f)
# Check first entry has new fields
assert 'food_base' in data[0], 'Missing food_base'
assert 'food_variant' in data[0], 'Missing food_variant'
assert data[0]['food_base'] == 'Arroz', f'Expected Arroz, got {data[0][\"food_base\"]}'
assert data[0]['food_variant'] == 'integral, cozido'
print('JSON validated OK')
"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/convert-taco-xlsx.py docs/taco_foods_extracted.json
git commit -m "feat: add food_base and food_variant to TACO JSON extraction"
```

---

### Task 2: Database migration — new columns, table, and RPC functions

**Files:**
- Create: `supabase/migrations/00011_taco_base_variant_defaults.sql`

- [ ] **Step 1: Create the migration file**

Create `supabase/migrations/00011_taco_base_variant_defaults.sql`:

```sql
-- =============================================
-- TACO Matching Redesign: base/variant split,
-- defaults, usage tracking
-- =============================================

-- 1. Add food_base, food_variant, is_default to taco_foods
ALTER TABLE taco_foods ADD COLUMN IF NOT EXISTS food_base VARCHAR(200);
ALTER TABLE taco_foods ADD COLUMN IF NOT EXISTS food_variant VARCHAR(200) DEFAULT '';
ALTER TABLE taco_foods ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;

-- 2. Index for base-name lookups
CREATE INDEX IF NOT EXISTS idx_taco_foods_food_base
  ON taco_foods (lower(food_base));

-- 3. Unique partial index: max 1 default per food_base
CREATE UNIQUE INDEX IF NOT EXISTS idx_taco_foods_default_per_base
  ON taco_foods (lower(food_base)) WHERE is_default = TRUE;

-- 4. Usage tracking table
CREATE TABLE IF NOT EXISTS taco_food_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_base VARCHAR(200) NOT NULL,
    taco_id INTEGER REFERENCES taco_foods(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    confirmed_count INTEGER DEFAULT 1,
    last_confirmed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(food_base, taco_id, user_id)
);

-- 5. RLS for taco_food_usage (service role writes, public reads for aggregation)
ALTER TABLE taco_food_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on taco_food_usage"
  ON taco_food_usage FOR ALL
  USING (true) WITH CHECK (true);

-- 6. RPC: match by food_base (returns all variants for a base)
CREATE OR REPLACE FUNCTION match_taco_by_base(query_base TEXT)
RETURNS TABLE (
  id INT,
  food_name VARCHAR,
  food_base VARCHAR,
  food_variant VARCHAR,
  is_default BOOLEAN,
  calories_per_100g DECIMAL,
  protein_per_100g DECIMAL,
  carbs_per_100g DECIMAL,
  fat_per_100g DECIMAL,
  fiber_per_100g DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.food_name, t.food_base, t.food_variant, t.is_default,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g
  FROM taco_foods t
  WHERE lower(t.food_base) = lower(query_base)
  ORDER BY t.is_default DESC, t.food_name ASC;
END;
$$ LANGUAGE plpgsql;

-- 7. RPC: get learned default (most confirmed by distinct users)
CREATE OR REPLACE FUNCTION get_learned_default(query_base TEXT)
RETURNS TABLE (
  taco_id INT,
  user_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT u.taco_id, COUNT(DISTINCT u.user_id) AS user_count
  FROM taco_food_usage u
  WHERE lower(u.food_base) = lower(query_base)
  GROUP BY u.taco_id
  ORDER BY user_count DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- 8. RPC: record usage (upsert — increment if exists)
CREATE OR REPLACE FUNCTION record_taco_usage(
  p_food_base TEXT,
  p_taco_id INT,
  p_user_id UUID
) RETURNS VOID AS $$
BEGIN
  INSERT INTO taco_food_usage (food_base, taco_id, user_id, confirmed_count, last_confirmed_at)
  VALUES (lower(p_food_base), p_taco_id, p_user_id, 1, NOW())
  ON CONFLICT (food_base, taco_id, user_id)
  DO UPDATE SET
    confirmed_count = taco_food_usage.confirmed_count + 1,
    last_confirmed_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- 9. Update existing match functions to also return new columns
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
  food_base VARCHAR,
  food_variant VARCHAR,
  is_default BOOLEAN,
  similarity REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.food_name, t.category,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g,
    t.food_base, t.food_variant, t.is_default,
    similarity(lower(t.food_name), query_name) AS similarity
  FROM taco_foods t
  WHERE similarity(lower(t.food_name), query_name) >= threshold
  ORDER BY similarity(lower(t.food_name), query_name) DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

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
  food_base VARCHAR,
  food_variant VARCHAR,
  is_default BOOLEAN,
  similarity REAL,
  query_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (q.name)
    t.id, t.food_name, t.category,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g,
    t.food_base, t.food_variant, t.is_default,
    similarity(lower(t.food_name), q.name) AS similarity,
    q.name AS query_name
  FROM unnest(query_names) AS q(name)
  JOIN taco_foods t ON similarity(lower(t.food_name), q.name) >= threshold
  ORDER BY q.name, similarity(lower(t.food_name), q.name) DESC;
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 2: Apply the migration to production**

Run via Supabase MCP or SQL editor:
```sql
-- Execute the migration SQL above against the production database
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00011_taco_base_variant_defaults.sql
git commit -m "feat: add taco food_base, food_variant, is_default columns and usage tracking"
```

---

### Task 3: Update seed script with new fields and defaults

**Files:**
- Modify: `scripts/seed-taco.ts`

- [ ] **Step 1: Update the seed script**

Replace the full content of `scripts/seed-taco.ts`:

```typescript
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseServiceKey)

interface TacoEntry {
  number: number
  name: string
  food_base: string
  food_variant: string
  energy_kcal: number | null
  protein_per_100g: number | null
  lipids_per_100g: number | null
  carbs_per_100g: number | null
  fiber_per_100g: number | null
  sodium_per_100g: number | null
}

// Default food for each base — the most commonly consumed variant in Brazil
const DEFAULTS: Record<string, string> = {
  'Arroz': 'tipo 1, cozido',
  'Feijão': 'carioca, cozido',
  'Banana': 'prata, crua',
  'Ovo': 'de galinha, inteiro, cozido/10minutos',
  'Pão': 'trigo, francês',
  'Leite': 'de vaca, integral',
  'Café': 'infusão 10%',
  'Frango': 'peito, sem pele, grelhado',
  'Carne': 'bovina, patinho, sem gordura, grelhado',
  'Queijo': 'mozarela',
  'Chocolate': 'ao leite',
  'Batata': 'inglesa, cozida',
  'Iogurte': 'natural',
  'Macarrão': 'trigo, cru',
  'Bolo': 'pronto, chocolate',
  'Laranja': 'pêra, crua',
  'Mandioca': 'cozida',
  'Lingüiça': 'porco, grelhada',
  'Porco': 'lombo, assado',
  'Óleo': 'de soja',
  'Tomate': 'com semente, cru',
  'Alface': 'crespa, crua',
  'Biscoito': 'salgado, cream cracker',
  'Margarina': 'com óleo hidrogenado, com sal (65% de lipídeos)',
  'Refrigerante': 'tipo cola',
  'Goiaba': 'vermelha, com casca, crua',
  'Manga': 'Tommy Atkins, crua',
  'Farinha': 'de trigo',
}

function isDefault(food: TacoEntry): boolean {
  const defaultVariant = DEFAULTS[food.food_base]
  if (!defaultVariant) return false
  return food.food_variant.toLowerCase() === defaultVariant.toLowerCase()
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
  let defaultCount = 0

  for (let i = 0; i < foods.length; i += batchSize) {
    const batch = foods.slice(i, i + batchSize).map(f => {
      const def = isDefault(f)
      if (def) defaultCount++
      return {
        id: f.number,
        food_name: f.name,
        food_base: f.food_base,
        food_variant: f.food_variant,
        is_default: def,
        category: null,
        calories_per_100g: f.energy_kcal,
        protein_per_100g: f.protein_per_100g,
        carbs_per_100g: f.carbs_per_100g,
        fat_per_100g: f.lipids_per_100g,
        fiber_per_100g: f.fiber_per_100g,
        sodium_per_100g: f.sodium_per_100g,
      }
    })

    const { error } = await supabase.from('taco_foods').upsert(batch, { onConflict: 'id' })
    if (error) {
      console.error(`Error inserting batch at ${i}:`, error.message)
    } else {
      inserted += batch.length
    }
  }

  console.log(`Done! Inserted ${inserted} of ${foods.length} foods (${defaultCount} defaults).`)
}

seed().catch(console.error)
```

- [ ] **Step 2: Run the seed and validate**

Run: `set -a && source .env.local && set +a && npx tsx scripts/seed-taco.ts`

Expected output:
```
Seeding 597 TACO foods...
Done! Inserted 597 of 597 foods (28 defaults).
```

Then validate defaults in the database:
```sql
SELECT food_base, food_variant, is_default
FROM taco_foods
WHERE is_default = TRUE
ORDER BY food_base;
```

Expected: 28 rows, one per base in the DEFAULTS map.

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-taco.ts
git commit -m "feat: seed taco foods with food_base, food_variant, and is_default"
```

---

### Task 4: Update TypeScript query layer with new matching functions

**Files:**
- Modify: `src/lib/db/queries/taco.ts`
- Test: `tests/unit/db/taco.test.ts`

- [ ] **Step 1: Write failing tests for new functions**

Add to `tests/unit/db/taco.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import {
  fuzzyMatchTaco,
  fuzzyMatchTacoMultiple,
  calculateMacros,
  matchTacoByBase,
  getLearnedDefault,
  recordTacoUsage,
} from '@/lib/db/queries/taco'

function createMockSupabase(returnData: unknown[] | null, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: returnData, error })
  return { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('fuzzyMatchTaco', () => {
  it('returns best match when similarity >= threshold', async () => {
    const supabase = createMockSupabase([
      { id: 3, food_name: 'Arroz, tipo 1, cozido', category: null, calories_per_100g: 128, protein_per_100g: 2.5, carbs_per_100g: 28.1, fat_per_100g: 0.2, fiber_per_100g: 1.6, food_base: 'Arroz', food_variant: 'tipo 1, cozido', is_default: true, similarity: 0.8 }
    ])

    const result = await fuzzyMatchTaco(supabase, 'arroz branco cozido')
    expect(result).not.toBeNull()
    expect(result!.foodName).toBe('Arroz, tipo 1, cozido')
    expect(result!.foodBase).toBe('Arroz')
    expect(result!.isDefault).toBe(true)
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
  it('returns map of matched foods with base/variant', async () => {
    const supabase = createMockSupabase([
      { id: 3, food_name: 'Arroz, tipo 1, cozido', category: null, calories_per_100g: 128, protein_per_100g: 2.5, carbs_per_100g: 28.1, fat_per_100g: 0.2, fiber_per_100g: 1.6, food_base: 'Arroz', food_variant: 'tipo 1, cozido', is_default: true, similarity: 0.8, query_name: 'arroz' },
      { id: 100, food_name: 'Feijão, carioca, cozido', category: null, calories_per_100g: 76, protein_per_100g: 4.8, carbs_per_100g: 13.6, fat_per_100g: 0.5, fiber_per_100g: 8.5, food_base: 'Feijão', food_variant: 'carioca, cozido', is_default: true, similarity: 0.7, query_name: 'feijão' },
    ])

    const result = await fuzzyMatchTacoMultiple(supabase, ['arroz', 'feijão'])
    expect(result.get('arroz')!.foodBase).toBe('Arroz')
    expect(result.get('feijão')!.foodBase).toBe('Feijão')
  })

  it('returns empty map for empty input', async () => {
    const supabase = createMockSupabase([])
    const result = await fuzzyMatchTacoMultiple(supabase, [])
    expect(result.size).toBe(0)
  })
})

describe('matchTacoByBase', () => {
  it('returns all variants for a base, default first', async () => {
    const supabase = createMockSupabase([
      { id: 182, food_name: 'Banana, prata, crua', food_base: 'Banana', food_variant: 'prata, crua', is_default: true, calories_per_100g: 98, protein_per_100g: 1.3, carbs_per_100g: 26, fat_per_100g: 0.1, fiber_per_100g: 2 },
      { id: 175, food_name: 'Banana, da terra, crua', food_base: 'Banana', food_variant: 'da terra, crua', is_default: false, calories_per_100g: 128, protein_per_100g: 1.4, carbs_per_100g: 33.7, fat_per_100g: 0.1, fiber_per_100g: 1.5 },
    ])

    const result = await matchTacoByBase(supabase, 'Banana')
    expect(result).toHaveLength(2)
    expect(result[0].isDefault).toBe(true)
    expect(result[0].foodVariant).toBe('prata, crua')
  })

  it('returns empty array when no match', async () => {
    const supabase = createMockSupabase([])
    const result = await matchTacoByBase(supabase, 'BigMac')
    expect(result).toEqual([])
  })
})

describe('getLearnedDefault', () => {
  it('returns taco_id with most distinct users', async () => {
    const supabase = createMockSupabase([
      { taco_id: 179, user_count: 6 },
    ])
    const result = await getLearnedDefault(supabase, 'Banana')
    expect(result).toEqual({ tacoId: 179, userCount: 6 })
  })

  it('returns null when no usage data', async () => {
    const supabase = createMockSupabase([])
    const result = await getLearnedDefault(supabase, 'Banana')
    expect(result).toBeNull()
  })
})

describe('recordTacoUsage', () => {
  it('calls the RPC with correct params', async () => {
    const supabase = createMockSupabase(null)
    await recordTacoUsage(supabase, 'Banana', 182, 'user-123')
    expect(supabase.rpc).toHaveBeenCalledWith('record_taco_usage', {
      p_food_base: 'Banana',
      p_taco_id: 182,
      p_user_id: 'user-123',
    })
  })
})

describe('calculateMacros', () => {
  it('calculates proportional macros based on grams', () => {
    const tacoFood = {
      id: 3, foodName: 'Arroz, tipo 1, cozido', category: null as string | null,
      caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2, fiberPer100g: 1.6,
      foodBase: 'Arroz', foodVariant: 'tipo 1, cozido', isDefault: true,
    }
    const result = calculateMacros(tacoFood, 200)
    expect(result.calories).toBe(256)
    expect(result.protein).toBeCloseTo(5.0)
    expect(result.carbs).toBeCloseTo(56.2)
    expect(result.fat).toBeCloseTo(0.4)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- tests/unit/db/taco.test.ts`

Expected: FAIL — `matchTacoByBase`, `getLearnedDefault`, `recordTacoUsage` are not exported, and `TacoFood` is missing `foodBase`, `foodVariant`, `isDefault`.

- [ ] **Step 3: Update `src/lib/db/queries/taco.ts` with new interfaces and functions**

Replace the full content of `src/lib/db/queries/taco.ts`:

```typescript
import { SupabaseClient } from '@supabase/supabase-js'

export const SIMILARITY_THRESHOLD = 0.4

export interface TacoFood {
  id: number
  foodName: string
  category: string | null
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g: number
  foodBase: string
  foodVariant: string
  isDefault: boolean
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
  category?: string | null
  calories_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  fiber_per_100g: number
  food_base: string
  food_variant: string
  is_default: boolean
  similarity?: number
  query_name?: string
}

function rowToTacoFood(row: TacoRow): TacoFood {
  return {
    id: row.id,
    foodName: row.food_name,
    category: row.category ?? null,
    caloriesPer100g: row.calories_per_100g,
    proteinPer100g: row.protein_per_100g,
    carbsPer100g: row.carbs_per_100g,
    fatPer100g: row.fat_per_100g,
    fiberPer100g: row.fiber_per_100g,
    foodBase: row.food_base,
    foodVariant: row.food_variant,
    isDefault: row.is_default,
  }
}

// ---------------------------------------------------------------------------
// Fuzzy matching (existing — now returns base/variant/isDefault too)
// ---------------------------------------------------------------------------

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

  for (const name of foodNames) {
    result.set(name.toLowerCase(), null)
  }

  if (error || !data) return result

  for (const row of data as (TacoRow & { query_name: string })[]) {
    result.set(row.query_name, rowToTacoFood(row))
  }

  return result
}

// ---------------------------------------------------------------------------
// Base matching (new)
// ---------------------------------------------------------------------------

export async function matchTacoByBase(
  supabase: SupabaseClient,
  foodBase: string,
): Promise<TacoFood[]> {
  const { data, error } = await supabase.rpc('match_taco_by_base', {
    query_base: foodBase,
  })

  if (error || !data || data.length === 0) {
    return []
  }

  return (data as TacoRow[]).map(rowToTacoFood)
}

// ---------------------------------------------------------------------------
// Learned defaults (new)
// ---------------------------------------------------------------------------

export async function getLearnedDefault(
  supabase: SupabaseClient,
  foodBase: string,
): Promise<{ tacoId: number; userCount: number } | null> {
  const { data, error } = await supabase.rpc('get_learned_default', {
    query_base: foodBase,
  })

  if (error || !data || data.length === 0) {
    return null
  }

  const row = data[0] as { taco_id: number; user_count: number }
  return { tacoId: row.taco_id, userCount: row.user_count }
}

// ---------------------------------------------------------------------------
// Usage tracking (new)
// ---------------------------------------------------------------------------

export async function recordTacoUsage(
  supabase: SupabaseClient,
  foodBase: string,
  tacoId: number,
  userId: string,
): Promise<void> {
  await supabase.rpc('record_taco_usage', {
    p_food_base: foodBase,
    p_taco_id: tacoId,
    p_user_id: userId,
  })
}

// ---------------------------------------------------------------------------
// Macro calculation (unchanged)
// ---------------------------------------------------------------------------

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/db/taco.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/queries/taco.ts tests/unit/db/taco.test.ts
git commit -m "feat: add base matching, learned defaults, and usage tracking to taco queries"
```

---

### Task 5: Update formatters for default notice

**Files:**
- Modify: `src/lib/utils/formatters.ts`

- [ ] **Step 1: Add `formatDefaultNotice` function**

Add at the end of `src/lib/utils/formatters.ts`, before the last export:

```typescript
// ---------------------------------------------------------------------------
// formatDefaultNotice
// ---------------------------------------------------------------------------
export function formatDefaultNotice(defaults: Array<{ foodBase: string; foodVariant: string }>): string {
  if (defaults.length === 0) return ''
  if (defaults.length === 1) {
    const d = defaults[0]
    return `\nℹ️ Usei ${d.foodBase.toLowerCase()} ${d.foodVariant.split(',')[0]} como padrão. Se for outro tipo, me diz qual!`
  }
  const list = defaults.map(d => `${d.foodBase.toLowerCase()} ${d.foodVariant.split(',')[0]}`).join(', ')
  return `\nℹ️ Usei como padrão: ${list}. Se algum for diferente, me diz qual!`
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/utils/formatters.ts
git commit -m "feat: add formatDefaultNotice for transparent default food display"
```

---

### Task 6: Implement the new 4-step matching pipeline

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts`

- [ ] **Step 1: Update imports and EnrichedItem interface**

In `src/lib/bot/flows/meal-log.ts`, update the imports and interface:

```typescript
import { fuzzyMatchTacoMultiple, calculateMacros, matchTacoByBase, getLearnedDefault, recordTacoUsage } from '@/lib/db/queries/taco'
import type { TacoFood } from '@/lib/db/queries/taco'
import { formatMealBreakdown, formatMultiMealBreakdown, formatProgress, formatDecompositionFeedback, formatDefaultNotice } from '@/lib/utils/formatters'
```

Update the `EnrichedItem` interface to include the default tracking fields:

```typescript
interface EnrichedItem {
  food: string
  quantityGrams: number
  calories: number
  protein: number
  carbs: number
  fat: number
  source: string
  tacoId?: number
  usedDefault?: boolean
  defaultFoodBase?: string
  defaultFoodVariant?: string
}
```

- [ ] **Step 2: Add the base-matching helper**

Add a new helper function after `totalCaloriesFromEnriched`:

```typescript
async function resolveByBase(
  supabase: SupabaseClient,
  foodName: string,
): Promise<{ match: TacoFood; usedDefault: boolean } | null> {
  // Try matching the food name as a base (e.g., "banana" → all banana variants)
  const variants = await matchTacoByBase(supabase, foodName)
  if (variants.length === 0) return null

  // Single variant — no ambiguity
  if (variants.length === 1) {
    return { match: variants[0], usedDefault: false }
  }

  // Check for learned default first (community preference)
  const learned = await getLearnedDefault(supabase, foodName)
  if (learned) {
    const learnedFood = variants.find(v => v.id === learned.tacoId)
    if (learnedFood) {
      return { match: learnedFood, usedDefault: true }
    }
  }

  // Fall back to manual default (is_default = true)
  const manualDefault = variants.find(v => v.isDefault)
  if (manualDefault) {
    return { match: manualDefault, usedDefault: true }
  }

  // No default set — use first result
  return { match: variants[0], usedDefault: true }
}
```

- [ ] **Step 3: Replace `enrichItemsWithTaco` with the new 4-step pipeline**

Replace the `enrichItemsWithTaco` function:

```typescript
async function enrichItemsWithTaco(
  supabase: SupabaseClient,
  items: MealItem[],
  llm: ReturnType<typeof getLLMProvider>,
  userId: string,
  phone?: string,
): Promise<EnrichedItem[]> {
  // Step 1: Batch fuzzy match all items against TACO (exact name matching)
  const foodNames = items.map(i => i.food)
  const tacoMatches = await fuzzyMatchTacoMultiple(supabase, foodNames)

  const enriched: EnrichedItem[] = []
  const needsBaseMatch: { item: MealItem; index: number }[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const tacoMatch = tacoMatches.get(item.food.toLowerCase())

    if (tacoMatch) {
      // Direct fuzzy match found
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
      // User provided explicit macros
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
      needsBaseMatch.push({ item, index: i })
      enriched.push(null as unknown as EnrichedItem) // placeholder
    }
  }

  // Step 2: Try base-name matching for unmatched items
  const needsDecomposition: { item: MealItem; index: number }[] = []

  for (const { item, index } of needsBaseMatch) {
    const baseResult = await resolveByBase(supabase, item.food)
    if (baseResult) {
      const macros = calculateMacros(baseResult.match, item.quantity_grams)
      enriched[index] = {
        food: item.food,
        quantityGrams: item.quantity_grams,
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        source: 'taco',
        tacoId: baseResult.match.id,
        usedDefault: baseResult.usedDefault,
        defaultFoodBase: baseResult.usedDefault ? baseResult.match.foodBase : undefined,
        defaultFoodVariant: baseResult.usedDefault ? baseResult.match.foodVariant : undefined,
      }
    } else {
      needsDecomposition.push({ item, index })
    }
  }

  // Step 3: Decompose composite foods that didn't match
  if (needsDecomposition.length > 0 && phone) {
    const feedbackNames = needsDecomposition.map(d => d.item.food)
    const feedbackMsg = formatDecompositionFeedback(feedbackNames)
    await sendTextMessage(phone, feedbackMsg)
  }

  for (const { item, index } of needsDecomposition) {
    try {
      const ingredients = await llm.decomposeMeal(item.food, item.quantity_grams)

      // Match each ingredient via fuzzy + base pipeline
      const ingredientNames = ingredients.map(ig => ig.food)
      const ingredientMatches = await fuzzyMatchTacoMultiple(supabase, ingredientNames)

      let totalCal = 0, totalProt = 0, totalCarbs = 0, totalFat = 0

      for (const ig of ingredients) {
        let match = ingredientMatches.get(ig.food.toLowerCase())

        // If fuzzy didn't work, try base matching for the ingredient
        if (!match) {
          const baseResult = await resolveByBase(supabase, ig.food)
          if (baseResult) match = baseResult.match
        }

        if (match) {
          const macros = calculateMacros(match, ig.quantity_grams)
          totalCal += macros.calories
          totalProt += macros.protein
          totalCarbs += macros.carbs
          totalFat += macros.fat
        } else {
          // Step 4: LLM fallback for ingredient not in TACO
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
            // Silently skip
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
```

- [ ] **Step 4: Update `buildConfirmationResponse` to include default notices**

Replace the `buildConfirmationResponse` function:

```typescript
function buildConfirmationResponse(
  meals: MealAnalysis[],
  enrichedMeals: EnrichedItem[][],
  dailyConsumedSoFar: number,
  dailyTarget: number,
): string {
  // Collect all items that used a default
  const defaults = enrichedMeals
    .flat()
    .filter(i => i.usedDefault && i.defaultFoodBase && i.defaultFoodVariant)
    .map(i => ({ foodBase: i.defaultFoodBase!, foodVariant: i.defaultFoodVariant! }))

  const defaultNotice = formatDefaultNotice(defaults)

  if (meals.length === 1 && enrichedMeals.length === 1) {
    const analysis = meals[0]
    const items = enrichedMeals[0]
    const total = totalCaloriesFromEnriched(items)

    const breakdown = formatMealBreakdown(
      analysis.meal_type,
      items.map(i => ({ food: i.food, quantityGrams: i.quantityGrams, calories: i.calories })),
      total,
      dailyConsumedSoFar,
      dailyTarget,
    )

    return defaultNotice ? breakdown.replace('Tá certo?', `${defaultNotice}\n\nTá certo?`) : breakdown
  }

  const mealSections = meals.map((analysis, idx) => ({
    mealType: analysis.meal_type,
    items: enrichedMeals[idx].map(i => ({ food: i.food, quantityGrams: i.quantityGrams, calories: i.calories })),
    total: totalCaloriesFromEnriched(enrichedMeals[idx]),
  }))

  const multiBreakdown = formatMultiMealBreakdown(mealSections, dailyConsumedSoFar, dailyTarget)

  return defaultNotice ? multiBreakdown.replace('Tá certo?', `${defaultNotice}\n\nTá certo?`) : multiBreakdown
}
```

- [ ] **Step 5: Record usage on confirmation**

In the `handleConfirmation` function, add usage recording right after the `createMeal` loop and before `clearState`:

```typescript
  // Record TACO usage for default learning
  for (const items of enrichedMeals) {
    for (const item of items) {
      if (item.tacoId && item.source === 'taco') {
        const foodBase = item.defaultFoodBase ?? item.food
        await recordTacoUsage(supabase, foodBase, item.tacoId, userId)
      }
    }
  }
```

Insert this block between the `createMeal` for-loop and the `await clearState(userId)` call in the existing `handleConfirmation` function (around line 292).

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts
git commit -m "feat: implement 4-step TACO matching pipeline with base matching and defaults"
```

---

### Task 7: Update meal-log tests for the new pipeline

**Files:**
- Modify: `tests/unit/bot/meal-log.test.ts`

- [ ] **Step 1: Update mocks and add tests for base matching behavior**

In the `vi.hoisted` block, update `mockFuzzyMatchTacoMultiple` to return TacoFood objects with the new fields, and add mocks for the new functions:

```typescript
// Add to the vi.hoisted block:
mockMatchTacoByBase: vi.fn().mockResolvedValue([]),
mockGetLearnedDefault: vi.fn().mockResolvedValue(null),
mockRecordTacoUsage: vi.fn().mockResolvedValue(undefined),
mockFormatDefaultNotice: vi.fn().mockReturnValue(''),
```

Update the existing `mockFuzzyMatchTacoMultiple` default return to include new fields:

```typescript
mockFuzzyMatchTacoMultiple: vi.fn().mockResolvedValue(new Map([
  ['arroz', { id: 3, foodName: 'Arroz, tipo 1, cozido', category: null, caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2, fiberPer100g: 1.6, foodBase: 'Arroz', foodVariant: 'tipo 1, cozido', isDefault: true }],
  ['feijão', { id: 5, foodName: 'Feijão, carioca, cozido', category: null, caloriesPer100g: 76, proteinPer100g: 4.8, carbsPer100g: 13.6, fatPer100g: 0.5, fiberPer100g: 8.5, foodBase: 'Feijão', foodVariant: 'carioca, cozido', isDefault: true }],
])),
```

Add the new mocks to the `vi.mock('@/lib/db/queries/taco')` block:

```typescript
vi.mock('@/lib/db/queries/taco', () => ({
  fuzzyMatchTacoMultiple: mockFuzzyMatchTacoMultiple,
  calculateMacros: mockCalculateMacros,
  matchTacoByBase: mockMatchTacoByBase,
  getLearnedDefault: mockGetLearnedDefault,
  recordTacoUsage: mockRecordTacoUsage,
}))
```

Add the formatter mock:

```typescript
// In the vi.mock for formatters, add:
formatDefaultNotice: mockFormatDefaultNotice,
```

- [ ] **Step 2: Add test for base matching fallback**

Add a new test in the meal-log test file:

```typescript
describe('base matching fallback', () => {
  it('uses base matching when fuzzy match fails', async () => {
    // Fuzzy returns no match for "banana"
    mockFuzzyMatchTacoMultiple.mockResolvedValueOnce(new Map([
      ['banana', null],
    ]))

    // Base matching returns banana variants
    mockMatchTacoByBase.mockResolvedValueOnce([
      { id: 182, foodName: 'Banana, prata, crua', category: null, caloriesPer100g: 98, proteinPer100g: 1.3, carbsPer100g: 26, fatPer100g: 0.1, fiberPer100g: 2, foodBase: 'Banana', foodVariant: 'prata, crua', isDefault: true },
    ])

    mockAnalyzeMeal.mockResolvedValueOnce([{
      meal_type: 'snack',
      confidence: 'high',
      items: [{ food: 'banana', quantity_grams: 120, calories: null, protein: null, carbs: null, fat: null }],
      unknown_items: [],
      needs_clarification: false,
      references_previous: false,
    }])

    const result = await handleMealLog(
      mockSupabase as unknown as SupabaseClient,
      'user-1', 'comi uma banana',
      { calorieMode: 'taco', dailyCalorieTarget: 2000 },
      null,
    )

    expect(result.completed).toBe(false)
    expect(mockMatchTacoByBase).toHaveBeenCalledWith(mockSupabase, 'banana')
  })
})
```

- [ ] **Step 3: Run tests**

Run: `npm run test:unit -- tests/unit/bot/meal-log.test.ts`

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/bot/meal-log.test.ts
git commit -m "test: update meal-log tests for base matching pipeline"
```

---

### Task 8: Run seed and full test suite, push to deploy

**Files:** none (operational task)

- [ ] **Step 1: Apply migration to production database**

Execute the migration SQL from Task 2 against the production Supabase database.

- [ ] **Step 2: Run the seed script**

```bash
set -a && source .env.local && set +a && npx tsx scripts/seed-taco.ts
```

Expected: `Done! Inserted 597 of 597 foods (28 defaults).`

- [ ] **Step 3: Validate defaults in the database**

```sql
SELECT food_base, food_variant, is_default
FROM taco_foods WHERE is_default = TRUE
ORDER BY food_base;
```

Expected: 28 rows.

- [ ] **Step 4: Test base matching in the database**

```sql
SELECT * FROM match_taco_by_base('Banana');
```

Expected: 8 banana variants, prata first (is_default = true).

```sql
SELECT * FROM match_taco_by_base('Café');
```

Expected: café variants with infusão 10% as default.

- [ ] **Step 5: Run full test suite**

Run: `npm run test:unit`

Expected: all tests PASS.

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 7: Commit all remaining changes and push**

```bash
git add -A
git commit -m "feat: complete TACO matching redesign with base matching and intelligent defaults"
git push
```
