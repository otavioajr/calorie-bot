# Products DECIMAL Coercion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir o bug de DECIMAL-como-string (mesmo do WS1) no fluxo de products, onde NUMERIC do PostgREST chega como string e quebra a promoção por consenso (median de cluster PAR → NaN → produto nunca promovido) e o mapper de `queries.ts` (latente).

**Architecture:** Reusar o helper `decToNum(value): number | null` já adicionado pelo WS1 em `src/lib/db/utils.ts`. Coagir no boundary de leitura: (1) `rowToProduct` em `src/lib/products/queries.ts` e (2) `evaluateCluster` em `src/lib/products/consensus.ts`, montando os arrays de macros já como `number[]` antes de chamar `median`. Endurecer `median` para coagir defensivamente. Preservar `null` nos campos nullable (`fiber_per_100g`, `sodium_per_100g`, `serving_size_g`).

**Tech Stack:** TypeScript strict, Next.js, Supabase (PostgREST), Vitest (`vitest run`), alias `@/*` → `src/*`.

---

## Decisões de produto (defaults escolhidos)

- **Onde coagir:** no boundary de leitura (mapper de `queries.ts` + `evaluateCluster` em `consensus.ts`), reusando `decToNum` do WS1. Alternativa descartada: coagir só dentro de `median`.
- **median:** garantir `number[]` na origem E endurecer `median` (defense-in-depth). Alternativa: só endurecer `median`.
- **Macros NOT NULL em consensus:** `decToNum(x) ?? 0` (colunas obrigatórias; cluster só promove com tolerância respeitada). Alternativa: descartar linha com macro null.
- **Campos nullable no mapper:** `fiberPer100g`/`sodiumPer100g`/`servingSizeG` preservam `null` (`decToNum(x)` sem `?? 0`), como `food-cache.ts`. Alternativa: forçar 0.

## File Structure

```
src/lib/db/utils.ts                         # JÁ EXISTE (WS1): decToNum — apenas importar
src/lib/products/queries.ts                 # MODIFY: rowToProduct (linhas 81-106) coage DECIMAL
src/lib/products/consensus.ts               # MODIFY: median (57-64) + evaluateCluster (85-88)
tests/unit/products/queries.test.ts         # MODIFY: regressão NUMERIC-como-string no mapper
tests/unit/products/consensus.test.ts       # MODIFY: regressão cluster PAR(4) e ÍMPAR(3) string
```

Tipos/funções referenciados:
- `decToNum(value: unknown): number | null` — definido em `src/lib/db/utils.ts:30` (WS1). Não criar.
- `rowToProduct(row: ProductRow): Product` — existe em `src/lib/products/queries.ts:81`.
- `median(values: number[]): number` — existe em `src/lib/products/consensus.ts:57`.
- `evaluateCluster(rows: ProductConsensusRow[]): ConsensusCandidate | null` — existe em `src/lib/products/consensus.ts:72`.

---

### Task 1: Coagir DECIMAL no median de consensus (cluster PAR e ÍMPAR)

**Files:**
- Modify: `src/lib/products/consensus.ts` (median: linhas 57-64; evaluateCluster mapeia macros: linhas 85-88)
- Test: `tests/unit/products/consensus.test.ts` (interface `ProductRow` linhas 5-17, helper `row` 19-37, novos `it` no fim do describe linha 88-179)

- [ ] **Step 1: Write the failing test** — adicionar dois casos ao `tests/unit/products/consensus.test.ts`. Primeiro, alargar a interface `ProductRow` e o helper `row` para aceitar macros como `string` (NUMERIC-como-string do PostgREST). Trocar a assinatura da interface (linhas 11-14) e os defaults do helper (linhas 30-33):

```ts
// interface ProductRow (substituir linhas 11-14):
  calories_per_100g: number | string
  protein_per_100g: number | string
  carbs_per_100g: number | string
  fat_per_100g: number | string
```

Adicionar antes do fechamento do `describe('runConsensusPromotion', ...)` (após o último `it`, antes da linha 179 `})`):

```ts
  it('promotes an EVEN-sized cluster (4 contributors) whose NUMERIC values arrive as strings', async () => {
    // Regression: PostgREST serializes NUMERIC as string. With an even count,
    // median did (sorted[mid-1] + sorted[mid]) / 2 → "110.00" + "120.00" → NaN,
    // so isWithinDeviation failed and the product was NEVER promoted.
    const { supabase, inserted } = makeSupabase([
      row({ id: 'p-a', created_by: 'user-a', calories_per_100g: '110.00', protein_per_100g: '8.00', carbs_per_100g: '70.00', fat_per_100g: '9.00' }),
      row({ id: 'p-b', created_by: 'user-b', calories_per_100g: '115.00', protein_per_100g: '8.50', carbs_per_100g: '72.00', fat_per_100g: '9.50' }),
      row({ id: 'p-c', created_by: 'user-c', calories_per_100g: '120.00', protein_per_100g: '9.00', carbs_per_100g: '73.00', fat_per_100g: '10.00' }),
      row({ id: 'p-d', created_by: 'user-d', calories_per_100g: '118.00', protein_per_100g: '8.80', carbs_per_100g: '71.00', fat_per_100g: '9.80' }),
    ])

    const report = await runConsensusPromotion(supabase)

    expect(report).toEqual({ promoted: 1, clusters: 1 })
    expect(inserted).toHaveLength(1)
    const payload = inserted[0] as Record<string, number>
    // median of 4 sorted [110,115,118,120] = (115+118)/2 = 116.5, NOT NaN
    expect(payload.calories_per_100g).toBe(116.5)
    expect(Number.isNaN(payload.calories_per_100g)).toBe(false)
    expect(typeof payload.protein_per_100g).toBe('number')
  })

  it('returns a number (not a string) for ODD-sized clusters with string NUMERIC values', async () => {
    const { supabase, inserted } = makeSupabase([
      row({ id: 'p-a', created_by: 'user-a', calories_per_100g: '100.00' }),
      row({ id: 'p-b', created_by: 'user-b', calories_per_100g: '105.00' }),
      row({ id: 'p-c', created_by: 'user-c', calories_per_100g: '110.00' }),
    ])

    const report = await runConsensusPromotion(supabase)

    expect(report).toEqual({ promoted: 1, clusters: 1 })
    const payload = inserted[0] as Record<string, unknown>
    // odd median picks the middle element "105.00" → must be number 105, not string
    expect(payload.calories_per_100g).toBe(105)
    expect(typeof payload.calories_per_100g).toBe('number')
  })
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/products/consensus.test.ts`. Expected: FAIL. O caso PAR falha porque `median` faz `"115.00" + "118.00"` → `"115.00118.00"` → `/2` → `NaN`; `isWithinDeviation` retorna false (NaN comparison) → `promoted: 0` em vez de `1`. O caso ÍMPAR falha porque `median` retorna a string `"105.00"` (não coage) → `typeof` é `'string'` e `payload.calories_per_100g` é `"105.00"`, não `105`.

- [ ] **Step 3: Write minimal implementation** — em `src/lib/products/consensus.ts`. Importar `decToNum` no topo (após a linha 1 `import type { SupabaseClient }`):

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { decToNum } from '@/lib/db/utils'
```

Endurecer `median` (substituir linhas 57-64) para coagir defensivamente a entrada:

```ts
function median(values: number[]): number {
  const sorted = values.map((v) => decToNum(v) ?? 0).sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 1) return sorted[middle]

  return (sorted[middle - 1] + sorted[middle]) / 2
}
```

Garantir `number[]` na origem em `evaluateCluster` (substituir linhas 85-88):

```ts
  const calories = deduplicatedRows.map((row) => decToNum(row.calories_per_100g) ?? 0)
  const protein = deduplicatedRows.map((row) => decToNum(row.protein_per_100g) ?? 0)
  const carbs = deduplicatedRows.map((row) => decToNum(row.carbs_per_100g) ?? 0)
  const fat = deduplicatedRows.map((row) => decToNum(row.fat_per_100g) ?? 0)
```

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/products/consensus.test.ts`. Expected: PASS (todos os casos, incluindo os 5 antigos e os 2 novos). O PAR agora promove com `calories_per_100g: 116.5`; o ÍMPAR retorna `105` como number.

- [ ] **Step 5: Commit** — Run:

```bash
git add src/lib/products/consensus.ts tests/unit/products/consensus.test.ts
git commit -m "fix(products): coage DECIMAL-como-string no consenso (cluster PAR não vira NaN)"
```

---

### Task 2: Coagir DECIMAL no mapper rowToProduct de queries.ts

**Files:**
- Modify: `src/lib/products/queries.ts` (mapper `rowToProduct`: linhas 81-106; import topo linha 1-3)
- Test: `tests/unit/products/queries.test.ts` (novo `it` dentro de `describe('findApprovedProduct', ...)` ou novo describe no fim, antes da linha 314 `})`)

- [ ] **Step 1: Write the failing test** — adicionar ao `tests/unit/products/queries.test.ts` um caso que entrega NUMERIC como string (como o PostgREST faz) e assere number na saída. Adicionar dentro de `describe('product queries', ...)`, logo após `describe('findApprovedProduct', ...)` (após a linha 124 `})` que fecha o findApprovedProduct describe, antes de `describe('findPrivateProduct', ...)`):

```ts
  describe('rowToProduct DECIMAL coercion', () => {
    it('coerces NUMERIC-as-string columns to numbers and preserves null on nullable fields', async () => {
      // PostgREST serializes DECIMAL/NUMERIC as string to preserve precision.
      const stringNumericRow = {
        ...productRow,
        serving_size_g: '25.00',
        calories_per_100g: '420.00',
        protein_per_100g: '9.50',
        carbs_per_100g: '72.00',
        fat_per_100g: '10.25',
        fiber_per_100g: null,
        sodium_per_100g: null,
      }

      const { supabase } = makeSupabase({
        maybeSingle: { data: stringNumericRow, error: null },
      })

      const result = await findApprovedProduct(supabase, 'Magic Toast', 'Marilan')

      expect(result?.servingSizeG).toBe(25)
      expect(result?.caloriesPer100g).toBe(420)
      expect(result?.proteinPer100g).toBe(9.5)
      expect(result?.carbsPer100g).toBe(72)
      expect(result?.fatPer100g).toBe(10.25)
      expect(typeof result?.caloriesPer100g).toBe('number')
      expect(typeof result?.proteinPer100g).toBe('number')
      // nullable fields stay null, not coerced to 0
      expect(result?.fiberPer100g).toBeNull()
      expect(result?.sodiumPer100g).toBeNull()
    })
  })
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run tests/unit/products/queries.test.ts`. Expected: FAIL. O mapper atual faz `caloriesPer100g: row.calories_per_100g` (cast `as number`, sem conversão runtime), então `result.caloriesPer100g` é a string `"420.00"`; `expect(...).toBe(420)` falha (string !== number) e `typeof` é `'string'`.

- [ ] **Step 3: Write minimal implementation** — em `src/lib/products/queries.ts`. Importar `decToNum` (substituir o import da linha 2, mantendo os outros imports):

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { decToNum } from '@/lib/db/utils'
import { normalizeBrand, normalizeProductName, scoreProductTokenMatch } from './normalize'
import type { Product, ProductSource, ProductStatus } from './types'
```

Coagir os campos numéricos em `rowToProduct` (substituir as linhas 89-96 dentro do return, mantendo os demais campos):

```ts
    servingSizeG: decToNum(row.serving_size_g),
    servingDisplay: row.serving_display,
    caloriesPer100g: decToNum(row.calories_per_100g) ?? 0,
    proteinPer100g: decToNum(row.protein_per_100g) ?? 0,
    carbsPer100g: decToNum(row.carbs_per_100g) ?? 0,
    fatPer100g: decToNum(row.fat_per_100g) ?? 0,
    fiberPer100g: decToNum(row.fiber_per_100g),
    sodiumPer100g: decToNum(row.sodium_per_100g),
```

Nota: `servingSizeG`, `fiberPer100g`, `sodiumPer100g` são `number | null` no tipo `Product` (ver `src/lib/products/types.ts:21,26,27`) — preservar null. Os quatro macros `per_100g` são `number` não-nullable → `?? 0`.

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run tests/unit/products/queries.test.ts`. Expected: PASS (o novo caso + todos os antigos, incluindo o de `findApprovedProduct` na linha 81 que passa números reais e continua batendo `caloriesPer100g: 420` etc., pois `decToNum(420) === 420`).

- [ ] **Step 5: Commit** — Run:

```bash
git add src/lib/products/queries.ts tests/unit/products/queries.test.ts
git commit -m "fix(products): coage DECIMAL-como-string no mapper rowToProduct"
```

---

## Verificação final

- [ ] Run: `npm test` — Expected: PASS (toda a suíte). Em particular `tests/unit/products/consensus.test.ts` e `tests/unit/products/queries.test.ts` verdes.
- [ ] Run: `npm run lint` — Expected: sem erros. Conferir que o import `@/lib/db/utils` resolve (alias `@/*` → `src/*` em tsconfig) e que não há `decToNum` não-usado em nenhum arquivo.
