# Base de Produtos Industrializados Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma base de produtos industrializados que cresce com uso (Open Food Facts + cadastro manual) entre TACO e o fallback de LLM, com guardrail triple-gate pra não pegar genéricos.

**Architecture:** Nova camada no pipeline `enrichItemsWithTaco`. Tabelas `products`/`product_usage` no Supabase. Cliente OFF via Search-A-Licious v2. Guardrail reutiliza `portion_type='packaged'` existente. Fluxo conversacional usando `conversation_context`. Job de consenso noturno via Vercel Cron.

**Tech Stack:** Next.js (App Router), Supabase Postgres + RLS, Zod, Vitest + MSW, Playwright (e2e opcional), Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-04-26-base-produtos-industrializados-design.md`

---

## File Structure

**Novos arquivos:**
- `supabase/migrations/<timestamp>_create_products.sql` — schema + RLS + `meal_items.source` extension.
- `src/lib/products/types.ts` — tipos compartilhados (`Product`, `ProductUsage`, `OffProduct`, `ProductLookupOutcome`).
- `src/lib/products/normalize.ts` — `normalizeProductName`, `normalizeBrand`, `convertLabelToPer100g`.
- `src/lib/products/off-client.ts` — cliente OFF (`searchByName`, `getByBarcode`).
- `src/lib/products/queries.ts` — queries Supabase.
- `src/lib/products/classify.ts` — `shouldUseProductFlow` + `GENERIC_FOOD_TOKENS`.
- `src/lib/products/lookup.ts` — orquestrador `tryProductLookup`.
- `src/lib/products/consensus.ts` — `runConsensusPromotion`.
- `src/lib/bot/flows/product-confirm.ts` — handlers dos 5 estados conversacionais.
- `src/app/api/cron/products-consensus/route.ts` — endpoint do cron.
- Testes:
  - `tests/unit/products/normalize.test.ts`
  - `tests/unit/products/off-client.test.ts` (MSW)
  - `tests/unit/products/queries.test.ts`
  - `tests/unit/products/classify.test.ts`
  - `tests/unit/products/lookup.test.ts`
  - `tests/unit/products/consensus.test.ts`
  - `tests/unit/bot/flows/product-confirm.test.ts`
  - `tests/integration/products/meal-log-product.test.ts`

**Arquivos modificados:**
- `src/lib/bot/flows/meal-log.ts` — call `tryProductLookup` antes da decomposição LLM (~linha 296 stillNeedsFuzzy).
- `src/lib/db/queries/context.ts` — 5 novos `ContextType` + TTLs.
- `src/lib/bot/router.ts` — roteamento dos novos contextos pro `product-confirm`.
- `vercel.ts` — entry de cron.

---

## Phases

- **Phase 1 — Foundation** (sequential): DB migration. Tasks 1.
- **Phase 2 — Utilities** (parallelizable): types, normalize, OFF client, queries, classify. Tasks 2-6.
- **Phase 3 — Orchestration** (depends on Phase 2): lookup. Task 7.
- **Phase 4 — Conversation flow** (parallelizable with consensus): contextos + product-confirm. Tasks 8-9.
- **Phase 5 — Consensus** (parallelizable with flow): job + cron. Tasks 10-11.
- **Phase 6 — Integration** (sequential, depends on Phase 3 + 4): meal-log + router. Tasks 12-13.
- **Phase 7 — Verification**: e2e + manual scenarios. Tasks 14-15.

---

## Task 1: Migração — tabelas `products` / `product_usage` + extensão `meal_items.source`

**Files:**
- Create: `supabase/migrations/20260426170000_create_products.sql`
- Verify: `supabase db reset` aplica sem erro local

- [ ] **Step 1: Criar migration SQL**

Conteúdo do arquivo (ajustar timestamp se necessário):

```sql
-- Extensão pra fuzzy match (pode já existir; CREATE IF NOT EXISTS é idempotente)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- products: catálogo de produtos industrializados
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  brand TEXT,
  brand_normalized TEXT,
  barcode TEXT,
  serving_size_g NUMERIC,
  serving_display TEXT,
  calories_per_100g NUMERIC NOT NULL,
  protein_per_100g NUMERIC NOT NULL,
  carbs_per_100g NUMERIC NOT NULL,
  fat_per_100g NUMERIC NOT NULL,
  fiber_per_100g NUMERIC,
  sodium_per_100g NUMERIC,
  source TEXT NOT NULL CHECK (source IN ('open_food_facts', 'user_label', 'consenso_usuarios')),
  source_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('aprovado', 'privado')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  promoted_at TIMESTAMPTZ,
  contributor_ids UUID[]
);

CREATE UNIQUE INDEX products_barcode_unique ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_name_norm_trgm ON products USING gin (name_normalized gin_trgm_ops);
CREATE INDEX idx_products_brand_name_norm ON products (brand_normalized, name_normalized) WHERE status = 'aprovado';
CREATE INDEX idx_products_private_owner ON products (created_by, name_normalized) WHERE status = 'privado';

-- product_usage: rastreia consumo
CREATE TABLE product_usage (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, user_id, used_at)
);
CREATE INDEX idx_product_usage_user ON product_usage (user_id, used_at DESC);

-- meal_items: novo source 'product' + product_id
ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
  CHECK (source IN ('approximate', 'taco', 'manual', 'taco_decomposed',
                    'user_provided', 'user_history', 'off', 'recipe', 'product'));
ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id);
CREATE INDEX IF NOT EXISTS idx_meal_items_product ON meal_items (product_id) WHERE product_id IS NOT NULL;

-- updated_at trigger (replicar padrão das outras tabelas)
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- RLS: aprovados são públicos; privados só pro autor
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_select_approved ON products
  FOR SELECT USING (status = 'aprovado');

CREATE POLICY products_select_own_private ON products
  FOR SELECT USING (status = 'privado' AND created_by = auth.uid());

CREATE POLICY products_insert_own ON products
  FOR INSERT WITH CHECK (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY products_update_own ON products
  FOR UPDATE USING (created_by = auth.uid());

ALTER TABLE product_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_usage_own ON product_usage
  FOR ALL USING (user_id = auth.uid());

-- Service-role bypassa RLS automaticamente (usado pelo bot via SUPABASE_SERVICE_ROLE_KEY)
```

- [ ] **Step 2: Verificar `trigger_set_timestamp` existe**

Run: `grep -rn "trigger_set_timestamp\b" supabase/migrations/`
Expected: encontrar a função declarada em alguma migration anterior. Se não existir, copiar o `CREATE FUNCTION` de outra migration que use updated_at.

- [ ] **Step 3: Aplicar migration localmente**

Run: `npx supabase db reset` (ou `npx supabase migration up`).
Expected: migration aplica sem erro.

- [ ] **Step 4: Smoke test — criar e ler um produto**

Run via psql ou Supabase Studio:
```sql
INSERT INTO products (name, name_normalized, brand, brand_normalized,
                      calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
                      source, status)
VALUES ('Magic Toast Tradicional', 'magic toast tradicional', 'Marilan', 'marilan',
        420, 9.5, 72, 10, 'open_food_facts', 'aprovado');
SELECT id, name, status FROM products LIMIT 1;
```
Expected: linha aparece. Em seguida `DELETE FROM products` pra deixar limpo.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260426170000_create_products.sql
git commit -m "feat(products): add products and product_usage tables with RLS"
```

---

## Task 2: Tipos compartilhados em `src/lib/products/types.ts`

**Files:**
- Create: `src/lib/products/types.ts`

- [ ] **Step 1: Definir tipos**

```ts
// src/lib/products/types.ts
import { z } from 'zod'

export const ProductSourceSchema = z.enum(['open_food_facts', 'user_label', 'consenso_usuarios'])
export const ProductStatusSchema = z.enum(['aprovado', 'privado'])
export type ProductSource = z.infer<typeof ProductSourceSchema>
export type ProductStatus = z.infer<typeof ProductStatusSchema>

export interface Product {
  id: string
  name: string
  nameNormalized: string
  brand: string | null
  brandNormalized: string | null
  barcode: string | null
  servingSizeG: number | null
  servingDisplay: string | null
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g: number | null
  sodiumPer100g: number | null
  source: ProductSource
  sourceRef: string | null
  status: ProductStatus
  createdBy: string | null
  createdAt: string
  updatedAt: string
  promotedAt: string | null
  contributorIds: string[] | null
}

export interface OffProduct {
  code: string
  productName: string
  brand: string | null
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g: number | null
  servingSizeG: number | null
  servingDisplay: string | null
  sourceUrl: string
}

export type ProductLookupOutcome =
  | { kind: 'matched'; product: Product; quantityGrams: number }
  | { kind: 'needs_off_choice'; query: string; candidates: OffProduct[] }
  | { kind: 'needs_label'; food: string; quantityGrams: number | null }
  | { kind: 'skip' }
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/products/types.ts
git commit -m "feat(products): add shared types"
```

---

## Task 3: Normalize helpers em `src/lib/products/normalize.ts`

**Files:**
- Create: `src/lib/products/normalize.ts`
- Test: `tests/unit/products/normalize.test.ts`

- [ ] **Step 1: Escrever testes que falham**

```ts
// tests/unit/products/normalize.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeProductName, normalizeBrand, convertLabelToPer100g } from '@/lib/products/normalize'

describe('normalizeProductName', () => {
  it('lowercases, trims and removes accents', () => {
    expect(normalizeProductName('  Magic Tóast  ')).toBe('magic toast')
  })
  it('preserves multi-word names', () => {
    expect(normalizeProductName('Yopro 25g Chocolate')).toBe('yopro 25g chocolate')
  })
  it('collapses internal whitespace', () => {
    expect(normalizeProductName('barra   trio')).toBe('barra trio')
  })
})

describe('normalizeBrand', () => {
  it('lowercases and removes accents', () => {
    expect(normalizeBrand('Nestlé')).toBe('nestle')
  })
  it('returns null for empty/whitespace input', () => {
    expect(normalizeBrand('')).toBeNull()
    expect(normalizeBrand('   ')).toBeNull()
  })
})

describe('convertLabelToPer100g', () => {
  it('returns input unchanged when basis is already 100g', () => {
    const r = convertLabelToPer100g({ basisGrams: 100, calories: 420, protein: 9, carbs: 72, fat: 10 })
    expect(r).toEqual({ caloriesPer100g: 420, proteinPer100g: 9, carbsPer100g: 72, fatPer100g: 10 })
  })
  it('scales values from a 30g serving', () => {
    const r = convertLabelToPer100g({ basisGrams: 30, calories: 126, protein: 2.7, carbs: 21.6, fat: 3 })
    expect(r.caloriesPer100g).toBeCloseTo(420, 1)
    expect(r.proteinPer100g).toBeCloseTo(9, 1)
  })
  it('throws on basisGrams <= 0', () => {
    expect(() => convertLabelToPer100g({ basisGrams: 0, calories: 1, protein: 0, carbs: 0, fat: 0 })).toThrow()
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run tests/unit/products/normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implementar módulo**

```ts
// src/lib/products/normalize.ts
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function normalizeProductName(input: string): string {
  return stripAccents(input).toLowerCase().replace(/\s+/g, ' ').trim()
}

export function normalizeBrand(input: string | null | undefined): string | null {
  if (!input) return null
  const norm = normalizeProductName(input)
  return norm.length > 0 ? norm : null
}

interface LabelInput {
  basisGrams: number
  calories: number
  protein: number
  carbs: number
  fat: number
}

interface Per100g {
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
}

export function convertLabelToPer100g(input: LabelInput): Per100g {
  if (input.basisGrams <= 0) {
    throw new Error('basisGrams must be > 0')
  }
  const factor = 100 / input.basisGrams
  return {
    caloriesPer100g: input.calories * factor,
    proteinPer100g: input.protein * factor,
    carbsPer100g: input.carbs * factor,
    fatPer100g: input.fat * factor,
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/products/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/products/normalize.ts tests/unit/products/normalize.test.ts
git commit -m "feat(products): add normalize helpers (name, brand, per-100g)"
```

---

## Task 4: OFF client em `src/lib/products/off-client.ts`

**Files:**
- Create: `src/lib/products/off-client.ts`
- Test: `tests/unit/products/off-client.test.ts`

- [ ] **Step 1: Escrever testes que falham (com MSW)**

```ts
// tests/unit/products/off-client.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { searchByName, getByBarcode } from '@/lib/products/off-client'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('searchByName', () => {
  it('parses search v2 hits and returns top candidates with brand+macros', async () => {
    server.use(http.get('https://search.openfoodfacts.org/search', () =>
      HttpResponse.json({
        count: 2,
        hits: [
          {
            code: '7891000315507',
            product_name: 'Magic Toast Tradicional',
            brands: 'Marilan',
            nutriments: { 'energy-kcal_100g': 420, proteins_100g: 9, carbohydrates_100g: 72, fat_100g: 10, fiber_100g: 3 },
            quantity: '150 g', serving_size: '30 g (4 unidades)',
          },
          { code: '999', product_name: 'Magic Toast', brands: null,
            nutriments: { 'energy-kcal_100g': 410, proteins_100g: 9, carbohydrates_100g: 70, fat_100g: 10 } },
        ],
      })
    ))
    const r = await searchByName('magic toast')
    expect(r).toHaveLength(2)
    expect(r[0].brand).toBe('Marilan')           // brand-first sort
    expect(r[0].caloriesPer100g).toBe(420)
    expect(r[1].brand).toBeNull()
  })

  it('drops implausible kcal values (<20 or >900)', async () => {
    server.use(http.get('https://search.openfoodfacts.org/search', () =>
      HttpResponse.json({ count: 2, hits: [
        { code: '1', product_name: 'Magic toast bug', brands: 'X',
          nutriments: { 'energy-kcal_100g': 64, proteins_100g: 1.5, carbohydrates_100g: 11, fat_100g: 1.5 } },
        { code: '2', product_name: 'Magic Toast OK', brands: 'Y',
          nutriments: { 'energy-kcal_100g': 420, proteins_100g: 9, carbohydrates_100g: 72, fat_100g: 10 } },
      ] })
    ))
    const r = await searchByName('magic toast')
    expect(r).toHaveLength(1)
    expect(r[0].code).toBe('2')
  })

  it('drops items where macros do not match kcal within 30%', async () => {
    server.use(http.get('https://search.openfoodfacts.org/search', () =>
      HttpResponse.json({ count: 1, hits: [
        { code: '1', product_name: 'Bad', brands: 'X',
          nutriments: { 'energy-kcal_100g': 100, proteins_100g: 50, carbohydrates_100g: 50, fat_100g: 50 } },
      ] })
    ))
    const r = await searchByName('bad')
    expect(r).toHaveLength(0)
  })

  it('returns [] on network error or non-200', async () => {
    server.use(http.get('https://search.openfoodfacts.org/search', () => HttpResponse.error()))
    expect(await searchByName('x')).toEqual([])
  })

  it('returns [] on timeout', async () => {
    server.use(http.get('https://search.openfoodfacts.org/search', async () => {
      await new Promise(r => setTimeout(r, 5000))
      return HttpResponse.json({})
    }))
    const r = await searchByName('x')
    expect(r).toEqual([])
  }, 7000)
})

describe('getByBarcode', () => {
  it('parses /api/v2/product response', async () => {
    server.use(http.get('https://world.openfoodfacts.org/api/v2/product/:code.json', () =>
      HttpResponse.json({ status: 1, product: {
        code: '7891000315507', product_name: 'Magic Toast', brands: 'Marilan',
        nutriments: { 'energy-kcal_100g': 420, proteins_100g: 9, carbohydrates_100g: 72, fat_100g: 10 },
      } })
    ))
    const r = await getByBarcode('7891000315507')
    expect(r?.code).toBe('7891000315507')
    expect(r?.brand).toBe('Marilan')
  })

  it('returns null when status=0', async () => {
    server.use(http.get('https://world.openfoodfacts.org/api/v2/product/:code.json', () =>
      HttpResponse.json({ status: 0 })))
    expect(await getByBarcode('000')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run tests/unit/products/off-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implementar cliente**

```ts
// src/lib/products/off-client.ts
import type { OffProduct } from './types'

const SEARCH_URL = 'https://search.openfoodfacts.org/search'
const PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product'
const USER_AGENT = 'CalorieBot/1.0 (otavioajr@gmail.com)'
const TIMEOUT_MS = 3000
const FIELDS = 'code,product_name,brands,nutriments,quantity,serving_size'

interface RawHit {
  code?: string
  product_name?: string
  brands?: string | string[] | null
  nutriments?: Record<string, number | string | undefined>
  quantity?: string
  serving_size?: string
}

function flattenBrand(raw: RawHit['brands']): string | null {
  if (!raw) return null
  if (Array.isArray(raw)) return raw[0]?.trim() || null
  const s = raw.trim()
  return s.length > 0 ? s.split(',')[0].trim() : null
}

function num(v: number | string | undefined | null): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function parseServingGrams(serving: string | undefined): number | null {
  if (!serving) return null
  const m = serving.match(/(\d+(?:[.,]\d+)?)\s*g/i)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

function isPlausible(kcal: number, p: number, c: number, f: number): boolean {
  if (kcal < 20 || kcal > 900) return false
  if (p < 0 || p > 100 || c < 0 || c > 100 || f < 0 || f > 100) return false
  const computed = p * 4 + c * 4 + f * 9
  if (computed === 0) return kcal < 50
  const ratio = Math.abs(computed - kcal) / kcal
  return ratio <= 0.30
}

function mapHit(hit: RawHit): OffProduct | null {
  const code = hit.code?.toString()
  const name = hit.product_name?.trim()
  if (!code || !name) return null

  const kcal = num(hit.nutriments?.['energy-kcal_100g'])
  const p = num(hit.nutriments?.['proteins_100g'])
  const c = num(hit.nutriments?.['carbohydrates_100g'])
  const f = num(hit.nutriments?.['fat_100g'])
  if (kcal === null || p === null || c === null || f === null) return null
  if (!isPlausible(kcal, p, c, f)) return null

  return {
    code,
    productName: name,
    brand: flattenBrand(hit.brands),
    caloriesPer100g: kcal,
    proteinPer100g: p,
    carbsPer100g: c,
    fatPer100g: f,
    fiberPer100g: num(hit.nutriments?.['fiber_100g']),
    servingSizeG: parseServingGrams(hit.serving_size),
    servingDisplay: hit.serving_size ?? null,
    sourceUrl: `https://world.openfoodfacts.org/product/${code}`,
  }
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return res.ok ? res : null
  } catch {
    return null
  }
}

export async function searchByName(query: string): Promise<OffProduct[]> {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&page_size=10&fields=${FIELDS}`
  const res = await fetchWithTimeout(url)
  if (!res) return []
  const data = await res.json().catch(() => null) as { hits?: RawHit[] } | null
  const hits = data?.hits ?? []
  const mapped = hits.map(mapHit).filter((x): x is OffProduct => x !== null)
  // brand-first ordering, then shorter name (proxy for specificity)
  mapped.sort((a, b) => {
    if ((a.brand !== null) !== (b.brand !== null)) return a.brand !== null ? -1 : 1
    return a.productName.length - b.productName.length
  })
  return mapped.slice(0, 5)
}

export async function getByBarcode(code: string): Promise<OffProduct | null> {
  const url = `${PRODUCT_URL}/${encodeURIComponent(code)}.json?fields=${FIELDS}`
  const res = await fetchWithTimeout(url)
  if (!res) return null
  const data = await res.json().catch(() => null) as { status?: number; product?: RawHit } | null
  if (!data || data.status !== 1 || !data.product) return null
  return mapHit(data.product)
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/products/off-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/products/off-client.ts tests/unit/products/off-client.test.ts
git commit -m "feat(products): add OFF v2 client with plausibility filters"
```

---

## Task 5: Queries Supabase em `src/lib/products/queries.ts`

**Files:**
- Create: `src/lib/products/queries.ts`
- Test: `tests/unit/products/queries.test.ts`

- [ ] **Step 1: Escrever testes (com mock do Supabase client)**

```ts
// tests/unit/products/queries.test.ts
import { describe, it, expect, vi } from 'vitest'
import { findApprovedProduct, findPrivateProduct, findByBarcode, createProduct, recordUsage } from '@/lib/products/queries'

function makeSupabase(behaviors: Record<string, unknown>) {
  const builder: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(behaviors.single ?? { data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue(behaviors.maybeSingle ?? { data: null, error: null }),
  }
  return { from: vi.fn().mockReturnValue(builder) } as unknown as Parameters<typeof findApprovedProduct>[0]
}

describe('findApprovedProduct', () => {
  it('returns mapped product when row exists', async () => {
    const supabase = makeSupabase({ maybeSingle: { data: {
      id: 'p1', name: 'Magic Toast', name_normalized: 'magic toast',
      brand: 'Marilan', brand_normalized: 'marilan',
      calories_per_100g: 420, protein_per_100g: 9, carbs_per_100g: 72, fat_per_100g: 10,
      source: 'open_food_facts', status: 'aprovado', created_by: null,
      created_at: '2026-04-26T00:00:00Z', updated_at: '2026-04-26T00:00:00Z',
    }, error: null } })
    const r = await findApprovedProduct(supabase, 'magic toast')
    expect(r?.id).toBe('p1')
    expect(r?.brand).toBe('Marilan')
  })

  it('returns null when no match', async () => {
    const supabase = makeSupabase({ maybeSingle: { data: null, error: null } })
    expect(await findApprovedProduct(supabase, 'xyz')).toBeNull()
  })
})

describe('createProduct', () => {
  it('inserts and returns mapped product', async () => {
    const supabase = makeSupabase({ single: { data: {
      id: 'new', name: 'X', name_normalized: 'x', brand: null, brand_normalized: null,
      calories_per_100g: 100, protein_per_100g: 1, carbs_per_100g: 1, fat_per_100g: 1,
      source: 'user_label', status: 'privado', created_by: 'u1',
      created_at: 'x', updated_at: 'x',
    }, error: null } })
    const r = await createProduct(supabase, {
      name: 'X', nameNormalized: 'x', brand: null, brandNormalized: null,
      caloriesPer100g: 100, proteinPer100g: 1, carbsPer100g: 1, fatPer100g: 1,
      source: 'user_label', status: 'privado', createdBy: 'u1',
    })
    expect(r.id).toBe('new')
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run tests/unit/products/queries.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implementar queries**

```ts
// src/lib/products/queries.ts
import { SupabaseClient } from '@supabase/supabase-js'
import type { Product, ProductSource, ProductStatus } from './types'

interface ProductRow {
  id: string
  name: string
  name_normalized: string
  brand: string | null
  brand_normalized: string | null
  barcode: string | null
  serving_size_g: number | null
  serving_display: string | null
  calories_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  fiber_per_100g: number | null
  sodium_per_100g: number | null
  source: ProductSource
  source_ref: string | null
  status: ProductStatus
  created_by: string | null
  created_at: string
  updated_at: string
  promoted_at: string | null
  contributor_ids: string[] | null
}

function rowToProduct(r: ProductRow): Product {
  return {
    id: r.id, name: r.name, nameNormalized: r.name_normalized,
    brand: r.brand, brandNormalized: r.brand_normalized,
    barcode: r.barcode, servingSizeG: r.serving_size_g, servingDisplay: r.serving_display,
    caloriesPer100g: r.calories_per_100g, proteinPer100g: r.protein_per_100g,
    carbsPer100g: r.carbs_per_100g, fatPer100g: r.fat_per_100g,
    fiberPer100g: r.fiber_per_100g, sodiumPer100g: r.sodium_per_100g,
    source: r.source, sourceRef: r.source_ref, status: r.status,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    promotedAt: r.promoted_at, contributorIds: r.contributor_ids,
  }
}

const COLUMNS = 'id,name,name_normalized,brand,brand_normalized,barcode,serving_size_g,serving_display,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,fiber_per_100g,sodium_per_100g,source,source_ref,status,created_by,created_at,updated_at,promoted_at,contributor_ids'

export async function findApprovedProduct(
  supabase: SupabaseClient,
  nameNormalized: string,
  brandNormalized?: string | null,
): Promise<Product | null> {
  let query = supabase.from('products').select(COLUMNS).eq('status', 'aprovado').eq('name_normalized', nameNormalized)
  if (brandNormalized) query = query.eq('brand_normalized', brandNormalized)
  const { data, error } = await query.limit(1).maybeSingle()
  if (error || !data) return null
  return rowToProduct(data as ProductRow)
}

export async function findPrivateProduct(
  supabase: SupabaseClient,
  userId: string,
  nameNormalized: string,
): Promise<Product | null> {
  const { data, error } = await supabase
    .from('products').select(COLUMNS)
    .eq('status', 'privado')
    .eq('created_by', userId)
    .eq('name_normalized', nameNormalized)
    .limit(1).maybeSingle()
  if (error || !data) return null
  return rowToProduct(data as ProductRow)
}

export async function findByBarcode(supabase: SupabaseClient, barcode: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from('products').select(COLUMNS).eq('barcode', barcode).limit(1).maybeSingle()
  if (error || !data) return null
  return rowToProduct(data as ProductRow)
}

export interface CreateProductInput {
  name: string
  nameNormalized: string
  brand: string | null
  brandNormalized: string | null
  barcode?: string | null
  servingSizeG?: number | null
  servingDisplay?: string | null
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  fiberPer100g?: number | null
  source: ProductSource
  sourceRef?: string | null
  status: ProductStatus
  createdBy: string | null
}

export async function createProduct(supabase: SupabaseClient, input: CreateProductInput): Promise<Product> {
  const { data, error } = await supabase.from('products').insert({
    name: input.name, name_normalized: input.nameNormalized,
    brand: input.brand, brand_normalized: input.brandNormalized,
    barcode: input.barcode ?? null,
    serving_size_g: input.servingSizeG ?? null, serving_display: input.servingDisplay ?? null,
    calories_per_100g: input.caloriesPer100g, protein_per_100g: input.proteinPer100g,
    carbs_per_100g: input.carbsPer100g, fat_per_100g: input.fatPer100g,
    fiber_per_100g: input.fiberPer100g ?? null,
    source: input.source, source_ref: input.sourceRef ?? null,
    status: input.status, created_by: input.createdBy,
  }).select(COLUMNS).single()
  if (error || !data) throw new Error(`createProduct failed: ${error?.message ?? 'unknown'}`)
  return rowToProduct(data as ProductRow)
}

export async function recordUsage(supabase: SupabaseClient, productId: string, userId: string): Promise<void> {
  await supabase.from('product_usage').insert({ product_id: productId, user_id: userId })
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/products/queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/products/queries.ts tests/unit/products/queries.test.ts
git commit -m "feat(products): add Supabase queries"
```

---

## Task 6: Guardrail `shouldUseProductFlow` em `src/lib/products/classify.ts`

**Files:**
- Create: `src/lib/products/classify.ts`
- Test: `tests/unit/products/classify.test.ts`

- [ ] **Step 1: Escrever testes**

```ts
// tests/unit/products/classify.test.ts
import { describe, it, expect, vi } from 'vitest'
import { shouldUseProductFlow, GENERIC_FOOD_TOKENS } from '@/lib/products/classify'
import type { MealItem } from '@/lib/llm/schemas/meal-analysis'

function item(over: Partial<MealItem>): MealItem {
  return {
    food: 'x', portion_type: 'unit', has_user_quantity: false, quantity_grams: null,
    quantity_display: null, quantity_source: 'estimated',
    nutrition_basis_grams: null, nutrition_basis_calories: null,
    nutrition_basis_protein: null, nutrition_basis_carbs: null, nutrition_basis_fat: null,
    calories: null, protein: null, carbs: null, fat: null, confidence: 'medium',
    ...over,
  } as MealItem
}

const supabase = {
  rpc: vi.fn().mockResolvedValue({ data: 0, error: null }),
} as unknown as Parameters<typeof shouldUseProductFlow>[1]

describe('shouldUseProductFlow', () => {
  it('returns false when portion_type is not packaged', async () => {
    expect(await shouldUseProductFlow(item({ food: 'magic toast', portion_type: 'unit' }), supabase)).toBe(false)
    expect(await shouldUseProductFlow(item({ food: 'arroz', portion_type: 'bulk' }), supabase)).toBe(false)
  })

  it('returns false when food token is in GENERIC_FOOD_TOKENS even with packaged', async () => {
    expect(await shouldUseProductFlow(item({ food: 'leite', portion_type: 'packaged' }), supabase)).toBe(false)
    expect(await shouldUseProductFlow(item({ food: 'arroz integral', portion_type: 'packaged' }), supabase)).toBe(false)
  })

  it('returns false when TACO has high-similarity match', async () => {
    const sb = { rpc: vi.fn().mockResolvedValue({ data: 0.72, error: null }) } as unknown as Parameters<typeof shouldUseProductFlow>[1]
    expect(await shouldUseProductFlow(item({ food: 'arroz blanco', portion_type: 'packaged' }), sb)).toBe(false)
  })

  it('returns true for branded item not in genericist and no TACO neighbor', async () => {
    expect(await shouldUseProductFlow(item({ food: 'magic toast', portion_type: 'packaged' }), supabase)).toBe(true)
    expect(await shouldUseProductFlow(item({ food: 'yopro chocolate', portion_type: 'packaged' }), supabase)).toBe(true)
  })
})

describe('GENERIC_FOOD_TOKENS', () => {
  it('contains common BR generics', () => {
    expect(GENERIC_FOOD_TOKENS).toContain('arroz')
    expect(GENERIC_FOOD_TOKENS).toContain('feijão')
    expect(GENERIC_FOOD_TOKENS).toContain('leite')
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run tests/unit/products/classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implementar guardrail**

```ts
// src/lib/products/classify.ts
import { SupabaseClient } from '@supabase/supabase-js'
import type { MealItem } from '@/lib/llm/schemas/meal-analysis'
import { normalizeProductName } from './normalize'

export const GENERIC_FOOD_TOKENS = new Set([
  'arroz', 'feijão', 'feijao', 'frango', 'carne', 'peixe', 'salmão', 'salmao', 'atum',
  'banana', 'maçã', 'maca', 'laranja', 'mamão', 'mamao', 'manga', 'uva', 'morango',
  'pão', 'pao', 'tapioca', 'cuscuz', 'macarrão', 'macarrao', 'massa',
  'leite', 'iogurte', 'queijo', 'requeijão', 'requeijao', 'manteiga',
  'ovo', 'ovos',
  'batata', 'mandioca', 'aipim', 'inhame',
  'tomate', 'cebola', 'alface', 'couve', 'brócolis', 'brocolis', 'espinafre',
  'cenoura', 'beterraba', 'abobrinha', 'pimentão', 'pimentao',
  'azeite', 'óleo', 'oleo',
  'açúcar', 'acucar', 'sal',
  'café', 'cafe', 'chá', 'cha', 'água', 'agua',
])

function firstToken(food: string): string {
  return normalizeProductName(food).split(/\s+/)[0] ?? ''
}

function isGenericByList(food: string): boolean {
  const tokens = normalizeProductName(food).split(/\s+/)
  return tokens.some(t => GENERIC_FOOD_TOKENS.has(t))
}

async function hasNearbyTacoMatch(supabase: SupabaseClient, food: string): Promise<boolean> {
  const normalized = normalizeProductName(food)
  // RPC `taco_max_similarity` returns the max trigram similarity between input
  // and any taco_foods.food_name. Defined in a follow-up migration if needed,
  // OR fall back to inline query.
  const { data, error } = await supabase.rpc('taco_max_similarity', { input: normalized })
  if (error || data === null || data === undefined) return false
  const sim = Number(data)
  return Number.isFinite(sim) && sim > 0.5
}

export async function shouldUseProductFlow(
  item: MealItem,
  supabase: SupabaseClient,
): Promise<boolean> {
  if (item.portion_type !== 'packaged') return false
  if (isGenericByList(item.food)) return false
  if (await hasNearbyTacoMatch(supabase, item.food)) return false
  return true
}
```

- [ ] **Step 4: Adicionar RPC `taco_max_similarity` na migration da Task 1 (ou nova migration)**

Adicionar ao final da migration de Task 1 (ou criar `supabase/migrations/<timestamp>_taco_max_similarity.sql`):

```sql
CREATE OR REPLACE FUNCTION taco_max_similarity(input TEXT)
RETURNS NUMERIC AS $$
  SELECT COALESCE(MAX(similarity(food_name, input)), 0)::NUMERIC
  FROM taco_foods
  WHERE food_name % input
$$ LANGUAGE SQL STABLE;

GRANT EXECUTE ON FUNCTION taco_max_similarity(TEXT) TO anon, authenticated, service_role;
```

Aplicar com `npx supabase db reset` ou `migration up`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/products/classify.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/products/classify.ts tests/unit/products/classify.test.ts supabase/migrations/*taco_max_similarity*.sql
git commit -m "feat(products): add shouldUseProductFlow guardrail with TACO similarity check"
```

---

## Task 7: Orquestrador `tryProductLookup` em `src/lib/products/lookup.ts`

**Files:**
- Create: `src/lib/products/lookup.ts`
- Test: `tests/unit/products/lookup.test.ts`

- [ ] **Step 1: Escrever testes**

```ts
// tests/unit/products/lookup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tryProductLookup } from '@/lib/products/lookup'

vi.mock('@/lib/products/classify', () => ({ shouldUseProductFlow: vi.fn() }))
vi.mock('@/lib/products/queries', () => ({
  findApprovedProduct: vi.fn(),
  findPrivateProduct: vi.fn(),
}))
vi.mock('@/lib/products/off-client', () => ({ searchByName: vi.fn() }))

import { shouldUseProductFlow } from '@/lib/products/classify'
import { findApprovedProduct, findPrivateProduct } from '@/lib/products/queries'
import { searchByName } from '@/lib/products/off-client'

const supabase = {} as Parameters<typeof tryProductLookup>[0]
const mealItem = (over: Record<string, unknown>) => ({
  food: 'magic toast', portion_type: 'packaged', quantity_grams: 30,
  ...over,
}) as Parameters<typeof tryProductLookup>[1]

beforeEach(() => vi.resetAllMocks())

describe('tryProductLookup', () => {
  it('returns skip when guardrail rejects', async () => {
    vi.mocked(shouldUseProductFlow).mockResolvedValue(false)
    const r = await tryProductLookup(supabase, mealItem({}), 'u1')
    expect(r.kind).toBe('skip')
  })

  it('returns matched when approved catalog has it', async () => {
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue({ id: 'p1', name: 'Magic Toast', brand: 'Marilan' } as never)
    const r = await tryProductLookup(supabase, mealItem({}), 'u1')
    expect(r.kind).toBe('matched')
  })

  it('falls through to private when no public match', async () => {
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(null)
    vi.mocked(findPrivateProduct).mockResolvedValue({ id: 'pp1', name: 'X' } as never)
    const r = await tryProductLookup(supabase, mealItem({}), 'u1')
    expect(r.kind).toBe('matched')
  })

  it('returns needs_off_choice when OFF returns hits', async () => {
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(null)
    vi.mocked(findPrivateProduct).mockResolvedValue(null)
    vi.mocked(searchByName).mockResolvedValue([{ code: '1', productName: 'Magic Toast', brand: 'Marilan' } as never])
    const r = await tryProductLookup(supabase, mealItem({}), 'u1')
    expect(r.kind).toBe('needs_off_choice')
  })

  it('returns needs_label when OFF empty', async () => {
    vi.mocked(shouldUseProductFlow).mockResolvedValue(true)
    vi.mocked(findApprovedProduct).mockResolvedValue(null)
    vi.mocked(findPrivateProduct).mockResolvedValue(null)
    vi.mocked(searchByName).mockResolvedValue([])
    const r = await tryProductLookup(supabase, mealItem({}), 'u1')
    expect(r.kind).toBe('needs_label')
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run tests/unit/products/lookup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar orquestrador**

```ts
// src/lib/products/lookup.ts
import { SupabaseClient } from '@supabase/supabase-js'
import type { MealItem } from '@/lib/llm/schemas/meal-analysis'
import type { ProductLookupOutcome } from './types'
import { shouldUseProductFlow } from './classify'
import { findApprovedProduct, findPrivateProduct } from './queries'
import { searchByName } from './off-client'
import { normalizeProductName } from './normalize'

export async function tryProductLookup(
  supabase: SupabaseClient,
  item: MealItem,
  userId: string,
): Promise<ProductLookupOutcome> {
  const eligible = await shouldUseProductFlow(item, supabase)
  if (!eligible) return { kind: 'skip' }

  const nameNorm = normalizeProductName(item.food)
  const quantityGrams = item.quantity_grams ?? 0

  const approved = await findApprovedProduct(supabase, nameNorm)
  if (approved) return { kind: 'matched', product: approved, quantityGrams }

  const priv = await findPrivateProduct(supabase, userId, nameNorm)
  if (priv) return { kind: 'matched', product: priv, quantityGrams }

  const candidates = await searchByName(item.food)
  if (candidates.length > 0) {
    return { kind: 'needs_off_choice', query: item.food, candidates }
  }

  return { kind: 'needs_label', food: item.food, quantityGrams: item.quantity_grams ?? null }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/products/lookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/products/lookup.ts tests/unit/products/lookup.test.ts
git commit -m "feat(products): add tryProductLookup orchestrator"
```

---

## Task 8: Adicionar context types em `src/lib/db/queries/context.ts`

**Files:**
- Modify: `src/lib/db/queries/context.ts:3-34`

- [ ] **Step 1: Adicionar tipos e TTLs**

Edit `src/lib/db/queries/context.ts`:

Localizar o bloco `CONTEXT_TTLS` e a union `ContextType`. Adicionar os 5 novos contextos.

Trecho final do `CONTEXT_TTLS`:
```ts
export const CONTEXT_TTLS: Record<ContextType, number> = {
  // ... existentes ...
  awaiting_off_choice: 10,
  awaiting_off_brand: 10,
  awaiting_off_confirm: 10,
  awaiting_label_input: 10,
  awaiting_label_confirm: 10,
}
```

Trecho final da `ContextType`:
```ts
export type ContextType =
  | 'onboarding'
  | 'awaiting_confirmation'
  // ... existentes ...
  | 'awaiting_off_choice'
  | 'awaiting_off_brand'
  | 'awaiting_off_confirm'
  | 'awaiting_label_input'
  | 'awaiting_label_confirm'
```

- [ ] **Step 2: Verificar tipo bate via build**

Run: `npm run build -- --no-lint 2>&1 | grep -i "context.ts\|error" | head -5`
Expected: sem erros de TS no arquivo.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/queries/context.ts
git commit -m "feat(products): register product-confirm context types"
```

---

## Task 9: Fluxo conversacional `src/lib/bot/flows/product-confirm.ts`

**Files:**
- Create: `src/lib/bot/flows/product-confirm.ts`
- Test: `tests/unit/bot/flows/product-confirm.test.ts`

- [ ] **Step 1: Estudar padrão de outros flows**

Run: `head -60 src/lib/bot/flows/help.ts && head -100 src/lib/bot/flows/onboarding.ts`
Goal: replicar a assinatura `handleX(ctx, msg)` e o uso de `upsertContext` / `clearContext`.

- [ ] **Step 2: Escrever testes (mínimos, mas cobrindo cada estado)**

```ts
// tests/unit/bot/flows/product-confirm.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  handleAwaitingOffChoice, handleAwaitingOffBrand, handleAwaitingOffConfirm,
  handleAwaitingLabelInput, handleAwaitingLabelConfirm,
  startProductConfirmFromOff, startProductConfirmFromLabel,
} from '@/lib/bot/flows/product-confirm'

vi.mock('@/lib/db/queries/context', () => ({
  upsertContext: vi.fn().mockResolvedValue(undefined),
  clearContext: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/products/queries', () => ({
  createProduct: vi.fn().mockResolvedValue({ id: 'p1', name: 'X', caloriesPer100g: 420 }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}))

const supabase = {} as never
const baseCtx = {
  supabase, userId: 'u1', phoneNumber: '+5511999',
  contextData: {} as Record<string, unknown>,
}

beforeEach(() => vi.resetAllMocks())

describe('handleAwaitingOffChoice', () => {
  it('user picks number 1, has brand → moves to confirm', async () => {
    const ctx = { ...baseCtx, contextData: { candidates: [
      { code: '1', productName: 'Magic Toast', brand: 'Marilan', caloriesPer100g: 420, proteinPer100g: 9, carbsPer100g: 72, fatPer100g: 10 },
    ], quantityGrams: 30 } }
    const r = await handleAwaitingOffChoice(ctx, '1')
    expect(r.nextContext).toBe('awaiting_off_confirm')
    expect(r.message).toContain('Confirma')
  })

  it('user picks number 1, brand null → moves to brand prompt', async () => {
    const ctx = { ...baseCtx, contextData: { candidates: [
      { code: '1', productName: 'Magic Toast', brand: null, caloriesPer100g: 420, proteinPer100g: 9, carbsPer100g: 72, fatPer100g: 10 },
    ], quantityGrams: 30 } }
    const r = await handleAwaitingOffChoice(ctx, '1')
    expect(r.nextContext).toBe('awaiting_off_brand')
    expect(r.message).toMatch(/marca/i)
  })

  it('user replies "nenhum" → moves to label_input', async () => {
    const ctx = { ...baseCtx, contextData: { candidates: [], query: 'magic toast', quantityGrams: 30 } }
    const r = await handleAwaitingOffChoice(ctx, 'nenhum')
    expect(r.nextContext).toBe('awaiting_label_input')
  })
})

describe('handleAwaitingLabelInput', () => {
  it('parses "Marilan, 420 kcal, 9g prot, 72g carbo, 10g gordura" and moves to confirm', async () => {
    const ctx = { ...baseCtx, contextData: { food: 'magic toast', quantityGrams: 30 } }
    const r = await handleAwaitingLabelInput(ctx, 'Marilan, 420 kcal, 9g prot, 72g carbo, 10g gordura')
    expect(r.nextContext).toBe('awaiting_label_confirm')
    expect(r.message).toContain('Marilan')
    expect(r.message).toContain('420')
  })

  it('rejects implausible kcal vs macros', async () => {
    const ctx = { ...baseCtx, contextData: { food: 'x', quantityGrams: 30 } }
    const r = await handleAwaitingLabelInput(ctx, 'Marca X, 100 kcal, 50g prot, 50g carbo, 50g gordura')
    expect(r.nextContext).toBe('awaiting_label_input') // pede de novo
    expect(r.message).toMatch(/não bateu|inconsist/i)
  })
})

describe('handleAwaitingLabelConfirm', () => {
  it('saves as private and registers meal', async () => {
    const ctx = { ...baseCtx, contextData: {
      food: 'magic toast', brand: 'Marilan',
      caloriesPer100g: 420, proteinPer100g: 9, carbsPer100g: 72, fatPer100g: 10,
      quantityGrams: 30,
    } }
    const r = await handleAwaitingLabelConfirm(ctx, 'sim')
    expect(r.nextContext).toBeNull() // limpa contexto
    expect(r.message).toMatch(/registrad|salv/i)
  })
})
```

- [ ] **Step 3: Run tests, expect failure**

Run: `npx vitest run tests/unit/bot/flows/product-confirm.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementar o flow**

```ts
// src/lib/bot/flows/product-confirm.ts
import { SupabaseClient } from '@supabase/supabase-js'
import { upsertContext, clearContext } from '@/lib/db/queries/context'
import { createProduct, recordUsage } from '@/lib/products/queries'
import { normalizeProductName, normalizeBrand, convertLabelToPer100g } from '@/lib/products/normalize'
import type { OffProduct } from '@/lib/products/types'

export interface FlowCtx {
  supabase: SupabaseClient
  userId: string
  phoneNumber: string
  contextData: Record<string, unknown>
}

export interface FlowResult {
  message: string
  nextContext: import('@/lib/db/queries/context').ContextType | null
  nextContextData?: Record<string, unknown>
}

const TTL_MIN = 10
const ttl = () => new Date(Date.now() + TTL_MIN * 60_000)

function macroLine(p: { caloriesPer100g: number; proteinPer100g: number; carbsPer100g: number; fatPer100g: number }) {
  return `${p.caloriesPer100g.toFixed(0)} kcal, ${p.proteinPer100g.toFixed(0)}P / ${p.carbsPer100g.toFixed(0)}C / ${p.fatPer100g.toFixed(0)}G por 100g`
}

export async function startProductConfirmFromOff(ctx: FlowCtx, query: string, candidates: OffProduct[], quantityGrams: number): Promise<FlowResult> {
  const lines = candidates.map((c, i) =>
    `${i + 1}. ${c.productName}${c.brand ? ` (${c.brand})` : ''} — ${c.caloriesPer100g.toFixed(0)} kcal/100g`
  )
  await upsertContext(ctx.supabase, ctx.userId, 'awaiting_off_choice', { candidates, query, quantityGrams }, ttl())
  return {
    message: `Não tenho '${query}' cadastrado ainda. Encontrei essas opções:\n${lines.join('\n')}\n\nResponda com o número, ou 'nenhum' pra cadastrar pelo rótulo.`,
    nextContext: 'awaiting_off_choice',
  }
}

export async function startProductConfirmFromLabel(ctx: FlowCtx, food: string, quantityGrams: number | null): Promise<FlowResult> {
  await upsertContext(ctx.supabase, ctx.userId, 'awaiting_label_input', { food, quantityGrams }, ttl())
  return {
    message: `Não encontrei '${food}' na minha base. Quer cadastrar pelo rótulo?\nMe passa: marca, valores por 100g (kcal, proteína, carbo, gordura).\n\nExemplo: "Marilan, 420 kcal, 9g prot, 72g carbo, 10g gordura"`,
    nextContext: 'awaiting_label_input',
  }
}

export async function handleAwaitingOffChoice(ctx: FlowCtx, text: string): Promise<FlowResult> {
  const candidates = (ctx.contextData.candidates as OffProduct[]) ?? []
  const quantityGrams = (ctx.contextData.quantityGrams as number) ?? 0
  const t = text.trim().toLowerCase()

  if (t === 'nenhum' || t === 'n') {
    const food = (ctx.contextData.query as string) ?? ''
    return startProductConfirmFromLabel(ctx, food, quantityGrams)
  }

  const idx = parseInt(t, 10) - 1
  if (Number.isNaN(idx) || idx < 0 || idx >= candidates.length) {
    return { message: `Não entendi. Responda com um número de 1 a ${candidates.length}, ou 'nenhum' pra cadastro manual.`, nextContext: 'awaiting_off_choice' }
  }

  const chosen = candidates[idx]
  if (!chosen.brand) {
    await upsertContext(ctx.supabase, ctx.userId, 'awaiting_off_brand', { chosen, quantityGrams }, ttl())
    return {
      message: `Encontrei '${chosen.productName}' (${macroLine(chosen)}). Qual a marca desse produto?`,
      nextContext: 'awaiting_off_brand',
    }
  }

  await upsertContext(ctx.supabase, ctx.userId, 'awaiting_off_confirm', { chosen, quantityGrams }, ttl())
  return {
    message: `Confirma? ${chosen.productName} (${chosen.brand}) — ${macroLine(chosen)}.`,
    nextContext: 'awaiting_off_confirm',
  }
}

export async function handleAwaitingOffBrand(ctx: FlowCtx, text: string): Promise<FlowResult> {
  const chosen = ctx.contextData.chosen as OffProduct
  const quantityGrams = ctx.contextData.quantityGrams as number
  const brand = text.trim()
  if (brand.length < 2) {
    return { message: 'Marca muito curta. Pode me dizer a marca completa?', nextContext: 'awaiting_off_brand' }
  }
  const updatedChosen = { ...chosen, brand }
  await upsertContext(ctx.supabase, ctx.userId, 'awaiting_off_confirm', { chosen: updatedChosen, quantityGrams }, ttl())
  return {
    message: `Confirma? ${updatedChosen.productName} (${brand}) — ${macroLine(updatedChosen)}.`,
    nextContext: 'awaiting_off_confirm',
  }
}

export async function handleAwaitingOffConfirm(ctx: FlowCtx, text: string): Promise<FlowResult> {
  const t = text.trim().toLowerCase()
  if (t !== 'sim' && t !== 's' && t !== 'confirma' && t !== 'confirmo') {
    await clearContext(ctx.supabase, ctx.userId)
    return { message: 'Beleza, cancelei o cadastro. Manda como quiser registrar.', nextContext: null }
  }
  const chosen = ctx.contextData.chosen as OffProduct
  const quantityGrams = (ctx.contextData.quantityGrams as number) ?? 0

  const created = await createProduct(ctx.supabase, {
    name: chosen.productName,
    nameNormalized: normalizeProductName(chosen.productName),
    brand: chosen.brand,
    brandNormalized: normalizeBrand(chosen.brand),
    barcode: chosen.code,
    servingSizeG: chosen.servingSizeG,
    servingDisplay: chosen.servingDisplay,
    caloriesPer100g: chosen.caloriesPer100g,
    proteinPer100g: chosen.proteinPer100g,
    carbsPer100g: chosen.carbsPer100g,
    fatPer100g: chosen.fatPer100g,
    fiberPer100g: chosen.fiberPer100g,
    source: 'open_food_facts',
    sourceRef: chosen.sourceUrl,
    status: 'aprovado',
    createdBy: ctx.userId,
  })
  await recordUsage(ctx.supabase, created.id, ctx.userId)
  await clearContext(ctx.supabase, ctx.userId)

  // Note: meal-log integration (Task 12) reads this and posts the meal_items row.
  // For now we surface success and the food name; meal registration happens upstream
  // by re-invoking the meal-log flow with the now-cached product.
  const kcal = (created.caloriesPer100g * quantityGrams) / 100
  return {
    message: `Cadastrado e registrado! ${created.name}${created.brand ? ` (${created.brand})` : ''} — ${kcal.toFixed(0)} kcal.`,
    nextContext: null,
    nextContextData: { productId: created.id, quantityGrams },
  }
}

interface ParsedLabel {
  brand: string | null
  calories: number
  protein: number
  carbs: number
  fat: number
}

function parseLabelInput(text: string): ParsedLabel | null {
  // Heurística: split por vírgulas; primeiro item sem unidade conhecida = marca; demais procuram kcal/prot/carbo/gordura.
  const parts = text.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)
  if (parts.length < 4) return null

  const find = (rx: RegExp): number | null => {
    for (const p of parts) {
      const m = p.match(rx)
      if (m) {
        const n = Number(m[1].replace(',', '.'))
        if (Number.isFinite(n)) return n
      }
    }
    return null
  }

  const calories = find(/(\d+(?:[.,]\d+)?)\s*kcal/i)
  const protein  = find(/(\d+(?:[.,]\d+)?)\s*g?\s*(?:de\s+)?prot/i)
  const carbs    = find(/(\d+(?:[.,]\d+)?)\s*g?\s*(?:de\s+)?carb/i)
  const fat      = find(/(\d+(?:[.,]\d+)?)\s*g?\s*(?:de\s+)?(?:gord|fat|lip)/i)

  if (calories === null || protein === null || carbs === null || fat === null) return null

  // Marca: primeiro segmento que não tenha número (heurística simples)
  const brand = parts.find(p => !/\d/.test(p)) ?? null

  return { brand, calories, protein, carbs, fat }
}

function isPlausibleLabel(p: ParsedLabel): boolean {
  if (p.calories < 0 || p.calories > 900) return false
  if ([p.protein, p.carbs, p.fat].some(v => v < 0 || v > 100)) return false
  const computed = p.protein * 4 + p.carbs * 4 + p.fat * 9
  if (computed === 0) return p.calories < 50
  const ratio = Math.abs(computed - p.calories) / Math.max(p.calories, 1)
  return ratio <= 0.20
}

export async function handleAwaitingLabelInput(ctx: FlowCtx, text: string): Promise<FlowResult> {
  const food = ctx.contextData.food as string
  const quantityGrams = (ctx.contextData.quantityGrams as number) ?? 0

  const parsed = parseLabelInput(text)
  if (!parsed) {
    return {
      message: 'Não consegui ler. Me passa no formato: "Marca, 420 kcal, 9g prot, 72g carbo, 10g gordura".',
      nextContext: 'awaiting_label_input',
    }
  }
  if (!isPlausibleLabel(parsed)) {
    return {
      message: `Os valores não bateram (kcal vs macros divergem mais que 20%). Confere o rótulo e manda de novo.`,
      nextContext: 'awaiting_label_input',
    }
  }

  await upsertContext(ctx.supabase, ctx.userId, 'awaiting_label_confirm', {
    food, brand: parsed.brand, quantityGrams,
    caloriesPer100g: parsed.calories, proteinPer100g: parsed.protein,
    carbsPer100g: parsed.carbs, fatPer100g: parsed.fat,
  }, ttl())

  return {
    message: `Confirma? ${food}${parsed.brand ? ` (${parsed.brand})` : ''} — ${parsed.calories.toFixed(0)} kcal, ${parsed.protein.toFixed(0)}P / ${parsed.carbs.toFixed(0)}C / ${parsed.fat.toFixed(0)}G por 100g.`,
    nextContext: 'awaiting_label_confirm',
  }
}

export async function handleAwaitingLabelConfirm(ctx: FlowCtx, text: string): Promise<FlowResult> {
  const t = text.trim().toLowerCase()
  if (t !== 'sim' && t !== 's' && t !== 'confirma' && t !== 'confirmo') {
    await clearContext(ctx.supabase, ctx.userId)
    return { message: 'Beleza, cancelei o cadastro.', nextContext: null }
  }

  const d = ctx.contextData as {
    food: string; brand: string | null
    caloriesPer100g: number; proteinPer100g: number; carbsPer100g: number; fatPer100g: number
    quantityGrams: number
  }

  const created = await createProduct(ctx.supabase, {
    name: d.food,
    nameNormalized: normalizeProductName(d.food),
    brand: d.brand,
    brandNormalized: normalizeBrand(d.brand),
    caloriesPer100g: d.caloriesPer100g, proteinPer100g: d.proteinPer100g,
    carbsPer100g: d.carbsPer100g, fatPer100g: d.fatPer100g,
    source: 'user_label',
    status: 'privado',
    createdBy: ctx.userId,
  })
  await recordUsage(ctx.supabase, created.id, ctx.userId)
  await clearContext(ctx.supabase, ctx.userId)

  const kcal = (created.caloriesPer100g * d.quantityGrams) / 100
  return {
    message: `Registrado! ${created.name}${created.brand ? ` (${created.brand})` : ''} — ${kcal.toFixed(0)} kcal.`,
    nextContext: null,
    nextContextData: { productId: created.id, quantityGrams: d.quantityGrams },
  }
}
```

- [ ] **Step 5: Verificar `clearContext` existe — se não, adicionar**

Run: `grep -n "export.*clearContext\|export async function clearContext" src/lib/db/queries/context.ts`
Expected: encontra. Se não existir, adicionar:
```ts
export async function clearContext(supabase: SupabaseClient, userId: string): Promise<void> {
  await supabase.from('conversation_context').delete().eq('user_id', userId)
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/bot/flows/product-confirm.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/flows/product-confirm.ts tests/unit/bot/flows/product-confirm.test.ts src/lib/db/queries/context.ts
git commit -m "feat(products): add product-confirm conversational flow"
```

---

## Task 10: Job de consenso `src/lib/products/consensus.ts`

**Files:**
- Create: `src/lib/products/consensus.ts`
- Test: `tests/unit/products/consensus.test.ts`

- [ ] **Step 1: Escrever testes**

```ts
// tests/unit/products/consensus.test.ts
import { describe, it, expect } from 'vitest'
import { evaluateCluster, median } from '@/lib/products/consensus'

describe('median', () => {
  it('returns middle of odd-length array', () => {
    expect(median([1, 5, 3])).toBe(3)
  })
  it('returns mean of two middles for even-length', () => {
    expect(median([1, 5, 3, 9])).toBe(4)
  })
})

describe('evaluateCluster', () => {
  const base = (kcal: number, p: number, c: number, f: number, by: string) => ({
    id: by, createdBy: by, brandNormalized: 'marilan', nameNormalized: 'magic toast',
    caloriesPer100g: kcal, proteinPer100g: p, carbsPer100g: c, fatPer100g: f,
  })

  it('returns null when fewer than 3 distinct authors', () => {
    const r = evaluateCluster([base(420, 9, 72, 10, 'a'), base(425, 9.5, 71, 10.5, 'b')])
    expect(r).toBeNull()
  })

  it('promotes when 3 distinct authors and macros within thresholds', () => {
    const r = evaluateCluster([base(420, 9, 72, 10, 'a'), base(425, 9.5, 71, 10.5, 'b'), base(415, 8.5, 73, 9.5, 'c')])
    expect(r).not.toBeNull()
    expect(r?.caloriesPer100g).toBe(420)
  })

  it('rejects when kcal deviation > 15% of median', () => {
    const r = evaluateCluster([base(420, 9, 72, 10, 'a'), base(420, 9, 72, 10, 'b'), base(600, 9, 72, 10, 'c')])
    expect(r).toBeNull()
  })

  it('rejects when any macro deviation > 20%', () => {
    const r = evaluateCluster([base(420, 9, 72, 10, 'a'), base(420, 9, 72, 10, 'b'), base(420, 14, 72, 10, 'c')])
    expect(r).toBeNull()
  })

  it('does not double-count same author', () => {
    const r = evaluateCluster([base(420, 9, 72, 10, 'a'), base(420, 9, 72, 10, 'a'), base(420, 9, 72, 10, 'a')])
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run tests/unit/products/consensus.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar consenso**

```ts
// src/lib/products/consensus.ts
import { SupabaseClient } from '@supabase/supabase-js'

interface Contribution {
  id: string
  createdBy: string | null
  brandNormalized: string | null
  nameNormalized: string
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

export interface ClusterResult {
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
  contributorIds: string[]
  brandNormalized: string
  nameNormalized: string
}

const KCAL_TOL = 0.15
const MACRO_TOL = 0.20

export function evaluateCluster(items: Contribution[]): ClusterResult | null {
  const validAuthors = items.map(i => i.createdBy).filter((x): x is string => !!x)
  const distinctAuthors = new Set(validAuthors)
  if (distinctAuthors.size < 3) return null

  // Use one row per author (first appearance) to avoid biasing the median
  const seen = new Set<string>()
  const dedup = items.filter(i => {
    if (!i.createdBy || seen.has(i.createdBy)) return false
    seen.add(i.createdBy)
    return true
  })
  if (dedup.length < 3) return null

  const kcalMed = median(dedup.map(i => i.caloriesPer100g))
  const pMed = median(dedup.map(i => i.proteinPer100g))
  const cMed = median(dedup.map(i => i.carbsPer100g))
  const fMed = median(dedup.map(i => i.fatPer100g))

  const within = (vals: number[], med: number, tol: number) => {
    if (med === 0) return vals.every(v => v === 0)
    return vals.every(v => Math.abs(v - med) / med <= tol)
  }

  if (!within(dedup.map(i => i.caloriesPer100g), kcalMed, KCAL_TOL)) return null
  if (!within(dedup.map(i => i.proteinPer100g), pMed, MACRO_TOL)) return null
  if (!within(dedup.map(i => i.carbsPer100g), cMed, MACRO_TOL)) return null
  if (!within(dedup.map(i => i.fatPer100g), fMed, MACRO_TOL)) return null

  const first = dedup[0]
  if (!first.brandNormalized) return null

  return {
    caloriesPer100g: kcalMed, proteinPer100g: pMed, carbsPer100g: cMed, fatPer100g: fMed,
    contributorIds: dedup.map(i => i.createdBy!),
    brandNormalized: first.brandNormalized,
    nameNormalized: first.nameNormalized,
  }
}

export interface ConsensusReport {
  clustersEvaluated: number
  promoted: number
}

export async function runConsensusPromotion(supabase: SupabaseClient): Promise<ConsensusReport> {
  // Fetch all private products with brand_normalized != null
  const { data, error } = await supabase
    .from('products')
    .select('id, name, name_normalized, brand, brand_normalized, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, created_by, status')
    .eq('status', 'privado')
    .not('brand_normalized', 'is', null)
  if (error || !data) return { clustersEvaluated: 0, promoted: 0 }

  const byKey = new Map<string, Contribution[]>()
  for (const row of data) {
    const key = `${row.brand_normalized}::${row.name_normalized}`
    const list = byKey.get(key) ?? []
    list.push({
      id: row.id, createdBy: row.created_by,
      brandNormalized: row.brand_normalized, nameNormalized: row.name_normalized,
      caloriesPer100g: row.calories_per_100g, proteinPer100g: row.protein_per_100g,
      carbsPer100g: row.carbs_per_100g, fatPer100g: row.fat_per_100g,
    })
    byKey.set(key, list)
  }

  let evaluated = 0
  let promoted = 0
  for (const [, list] of byKey) {
    evaluated++
    const cluster = evaluateCluster(list)
    if (!cluster) continue

    // Skip if there is already an approved row with this brand+name
    const { data: existing } = await supabase
      .from('products').select('id').eq('status', 'aprovado')
      .eq('brand_normalized', cluster.brandNormalized).eq('name_normalized', cluster.nameNormalized)
      .limit(1).maybeSingle()
    if (existing) continue

    const sample = list[0]
    const { data: insertedRow } = await supabase
      .from('products').select('id, name, brand').eq('id', sample.id).single()
    const displayName = insertedRow?.name ?? sample.nameNormalized
    const displayBrand = insertedRow?.brand ?? sample.brandNormalized

    await supabase.from('products').insert({
      name: displayName, name_normalized: cluster.nameNormalized,
      brand: displayBrand, brand_normalized: cluster.brandNormalized,
      calories_per_100g: cluster.caloriesPer100g,
      protein_per_100g: cluster.proteinPer100g,
      carbs_per_100g: cluster.carbsPer100g,
      fat_per_100g: cluster.fatPer100g,
      source: 'consenso_usuarios',
      status: 'aprovado',
      created_by: null,
      contributor_ids: cluster.contributorIds,
      promoted_at: new Date().toISOString(),
    })
    promoted++
  }
  return { clustersEvaluated: evaluated, promoted }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/products/consensus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/products/consensus.ts tests/unit/products/consensus.test.ts
git commit -m "feat(products): add consensus promotion job (3 authors, 15/20% thresholds)"
```

---

## Task 11: Cron route + Vercel config

**Files:**
- Create: `src/app/api/cron/products-consensus/route.ts`
- Modify: `vercel.ts` (raiz do repo)

- [ ] **Step 1: Criar route**

```ts
// src/app/api/cron/products-consensus/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runConsensusPromotion } from '@/lib/products/consensus'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const report = await runConsensusPromotion(supabase)
  return NextResponse.json({ ok: true, ...report, ranAt: new Date().toISOString() })
}
```

- [ ] **Step 2: Adicionar entry no `vercel.ts`**

Localizar o arquivo `vercel.ts` na raiz, adicionar (ou criar o array `crons`):

```ts
crons: [
  { path: '/api/cron/products-consensus', schedule: '0 3 * * *' },  // 03:00 UTC daily
],
```

- [ ] **Step 3: Adicionar `CRON_SECRET` em `.env.example`**

Run: `grep -n CRON_SECRET .env.example || echo "CRON_SECRET=change-me  # used by Vercel Cron auth header" >> .env.example`

- [ ] **Step 4: Smoke test local (opcional)**

Run: `curl -sH "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/products-consensus`
Expected: JSON `{ok:true, clustersEvaluated, promoted, ranAt}`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/products-consensus/route.ts vercel.ts .env.example
git commit -m "feat(products): add daily consensus cron route"
```

---

## Task 12: Integrar `tryProductLookup` em `enrichItemsWithTaco`

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts:296` (após Step 1.5 token search, antes de Step 2 fuzzy decomposition)

- [ ] **Step 1: Inspecionar ponto de inserção**

Run: `sed -n '290,330p' src/lib/bot/flows/meal-log.ts`
Goal: confirmar que `stillNeedsFuzzy` é o array de itens que ainda não bateram em TACO.

- [ ] **Step 2: Adicionar passo de produto antes do fuzzy/decomp**

Após o `stillNeedsFuzzy.push({ item, index })` final do Step 1.5 e antes do `if (stillNeedsFuzzy.length > 0)` do Step 2, inserir:

```ts
// Step 1.7: tentar match em produto industrializado (catálogo aprovado / privado / OFF)
const stillNeedsAfterProducts: { item: MealItem; index: number }[] = []
for (const { item, index } of stillNeedsFuzzy) {
  const outcome = await tryProductLookup(supabase, item, userId)
  if (outcome.kind === 'matched') {
    const macros = calculateMacrosFromProduct(outcome.product, outcome.quantityGrams)
    enriched[index] = {
      food: outcome.product.name,
      quantityGrams: outcome.quantityGrams,
      quantityDisplay: item.quantity_display,
      calories: macros.calories,
      protein: macros.protein,
      carbs: macros.carbs,
      fat: macros.fat,
      source: 'product',
      productId: outcome.product.id,
    } as EnrichedItem
    await recordUsage(supabase, outcome.product.id, userId)
    continue
  }
  if (outcome.kind === 'needs_off_choice' || outcome.kind === 'needs_label') {
    // Sinaliza que o flow conversacional precisa assumir.
    productInteractionPending.push({ item, index, outcome })
    continue
  }
  stillNeedsAfterProducts.push({ item, index })
}
// Substituir referência usada no Step 2:
const itemsForStep2 = stillNeedsAfterProducts
```

E ajustar o Step 2 (fuzzy match) e seguintes pra usarem `itemsForStep2` em vez de `stillNeedsFuzzy`.

- [ ] **Step 3: Adicionar helper `calculateMacrosFromProduct`**

No mesmo arquivo, perto de `calculateMacros`:

```ts
function calculateMacrosFromProduct(p: Product, quantityGrams: number) {
  const f = quantityGrams / 100
  return {
    calories: p.caloriesPer100g * f,
    protein: p.proteinPer100g * f,
    carbs: p.carbsPer100g * f,
    fat: p.fatPer100g * f,
  }
}
```

E adicionar imports no topo:
```ts
import { tryProductLookup } from '@/lib/products/lookup'
import { recordUsage } from '@/lib/products/queries'
import type { Product, ProductLookupOutcome } from '@/lib/products/types'
```

- [ ] **Step 4: Modificar a assinatura de retorno de `enrichItemsWithTaco` pra incluir `productInteractionPending`**

Hoje retorna `Promise<EnrichedItem[]>`. Mudar pra:

```ts
export interface EnrichmentResult {
  items: EnrichedItem[]
  productInteractions: { item: MealItem; index: number; outcome: Extract<ProductLookupOutcome, { kind: 'needs_off_choice' | 'needs_label' }> }[]
}
export async function enrichItemsWithTaco(...): Promise<EnrichmentResult>
```

Inicializar `const productInteractionPending: EnrichmentResult['productInteractions'] = []` no início. No retorno final: `return { items: enriched, productInteractions: productInteractionPending }`.

Atualizar TODOS os callers de `enrichItemsWithTaco` no arquivo pra desestruturar `items` e respeitar `productInteractions` (esse é o ponto de interrupção do fluxo padrão).

- [ ] **Step 5: Tratar interrupção no caller principal**

No handler que invoca `enrichItemsWithTaco` (procurar onde a função é chamada — provavelmente em `handleIncomingMessage` via meal-log entry point), antes de continuar pro registro do meal:

```ts
import { startProductConfirmFromOff, startProductConfirmFromLabel } from '@/lib/bot/flows/product-confirm'

// ...
const result = await enrichItemsWithTaco(...)
if (result.productInteractions.length > 0) {
  const first = result.productInteractions[0]  // tratamos um item por vez
  const flowCtx = { supabase, userId, phoneNumber, contextData: {} }
  if (first.outcome.kind === 'needs_off_choice') {
    const r = await startProductConfirmFromOff(flowCtx, first.outcome.query, first.outcome.candidates, first.item.quantity_grams ?? 0)
    await sendTextMessage(phoneNumber, r.message)
    return
  }
  if (first.outcome.kind === 'needs_label') {
    const r = await startProductConfirmFromLabel(flowCtx, first.outcome.food, first.outcome.quantityGrams)
    await sendTextMessage(phoneNumber, r.message)
    return
  }
}
// continua fluxo normal usando result.items
```

- [ ] **Step 6: Run lint + typecheck**

Run: `npm run lint && npm run build`
Expected: sem erros.

- [ ] **Step 7: Run all unit tests pra garantir nenhum quebrou**

Run: `npm run test:unit`
Expected: 100% passa.

- [ ] **Step 8: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts
git commit -m "feat(products): wire tryProductLookup into meal-log enrichment"
```

---

## Task 13: Roteamento dos contextos no router

**Files:**
- Modify: `src/lib/bot/router.ts`

- [ ] **Step 1: Identificar switch atual**

Run: `grep -n "context_type\|contextType\|switch" src/lib/bot/router.ts | head -30`
Goal: encontrar onde os contextos atuais são roteados.

- [ ] **Step 2: Adicionar cases pros 5 novos**

```ts
import {
  handleAwaitingOffChoice, handleAwaitingOffBrand, handleAwaitingOffConfirm,
  handleAwaitingLabelInput, handleAwaitingLabelConfirm,
} from '@/lib/bot/flows/product-confirm'

// dentro do switch (ctx.contextType):
case 'awaiting_off_choice':    return handleAwaitingOffChoice(flowCtx, text)
case 'awaiting_off_brand':     return handleAwaitingOffBrand(flowCtx, text)
case 'awaiting_off_confirm':   return handleAwaitingOffConfirm(flowCtx, text)
case 'awaiting_label_input':   return handleAwaitingLabelInput(flowCtx, text)
case 'awaiting_label_confirm': return handleAwaitingLabelConfirm(flowCtx, text)
```

Adaptar o tipo do `flowCtx` ao que o handler espera (criar um adapter se a interface do router não bater 1:1 com `FlowCtx`).

- [ ] **Step 3: Run lint + build**

Run: `npm run lint && npm run build`
Expected: sem erros.

- [ ] **Step 4: Re-rodar testes**

Run: `npm run test:unit`
Expected: passa.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/router.ts
git commit -m "feat(products): route product-confirm context types in router"
```

---

## Task 14: Teste de integração end-to-end

**Files:**
- Create: `tests/integration/products/meal-log-product.test.ts`

- [ ] **Step 1: Escrever cenários e2e (com Supabase local)**

```ts
// tests/integration/products/meal-log-product.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { createClient } from '@supabase/supabase-js'
import { tryProductLookup } from '@/lib/products/lookup'
import { findApprovedProduct } from '@/lib/products/queries'
import { handleAwaitingOffChoice, handleAwaitingOffConfirm, startProductConfirmFromOff } from '@/lib/bot/flows/product-confirm'

const server = setupServer()
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

beforeEach(async () => {
  server.resetHandlers()
  await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000')
})

describe('meal-log + product e2e', () => {
  it('first user lands on OFF, second user hits cache', async () => {
    server.use(http.get('https://search.openfoodfacts.org/search', () =>
      HttpResponse.json({ count: 1, hits: [{ code: '789', product_name: 'Magic Toast', brands: 'Marilan',
        nutriments: { 'energy-kcal_100g': 420, proteins_100g: 9, carbohydrates_100g: 72, fat_100g: 10 } }] })
    ))

    const userA = '00000000-0000-0000-0000-0000000000a1'
    const userB = '00000000-0000-0000-0000-0000000000b2'
    const item = { food: 'magic toast', portion_type: 'packaged', quantity_grams: 30 } as never

    // User A: cai no OFF
    const outA = await tryProductLookup(supabase, item, userA)
    expect(outA.kind).toBe('needs_off_choice')

    // User A confirma escolha 1 (já tem brand → off_confirm direto)
    const ctxA = { supabase, userId: userA, phoneNumber: '+a', contextData: { candidates: (outA as any).candidates, query: 'magic toast', quantityGrams: 30 } }
    const choice = await handleAwaitingOffChoice(ctxA, '1')
    expect(choice.nextContext).toBe('awaiting_off_confirm')

    const confirmCtx = { ...ctxA, contextData: { chosen: (outA as any).candidates[0], quantityGrams: 30 } }
    const confirmed = await handleAwaitingOffConfirm(confirmCtx, 'sim')
    expect(confirmed.nextContext).toBeNull()

    // User B: bate na camada 6 direto
    const outB = await tryProductLookup(supabase, item, userB)
    expect(outB.kind).toBe('matched')
  })
})
```

- [ ] **Step 2: Run integration**

Run: `npm run test:integration -- meal-log-product`
Expected: PASS contra Supabase local rodando.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/products/meal-log-product.test.ts
git commit -m "test(products): add meal-log + product e2e integration test"
```

---

## Task 15: Verificação manual via ngrok + WhatsApp

**Files:** nenhum.

- [ ] **Step 1: Subir ambiente local**

Run em terminais separados:
```bash
npm run dev
ngrok http 3000
```
Atualizar `WEBHOOK_BASE_URL` em `.env.local` com a URL do ngrok e atualizar o Webhook URL no Meta for Developers.

- [ ] **Step 2: Cenário 1 — produto aprovado seed**

Inserir manualmente um produto aprovado no Supabase Studio:
```sql
INSERT INTO products (name, name_normalized, brand, brand_normalized,
  calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, source, status)
VALUES ('Yopro 25g Chocolate', 'yopro 25g chocolate', 'Yopro', 'yopro',
  86, 10, 6, 1.5, 'open_food_facts', 'aprovado');
```
No WhatsApp, mandar: `comi 1 yopro`. Esperado: registra direto, sem prompts.

- [ ] **Step 3: Cenário 2 — OFF pega**

Mandar: `comi 4 magic toast`. Esperado: bot lista opções OFF; responder `1`; bot pede confirmação; responder `sim`; registra.

Mandar de novo: `comi 4 magic toast`. Esperado: registra direto sem prompts (bate na camada 6).

- [ ] **Step 4: Cenário 3 — cadastro manual**

Mandar: `comi 1 biscoito superx do bairro`. Esperado: bot pede rótulo; responder `Marca XYZ, 480 kcal, 7g prot, 60g carbo, 22g gordura`; bot pede confirmação; responder `sim`; registra como `privado`.

- [ ] **Step 5: Cenário 4 — guardrail anti falso-positivo**

Mandar: `comi arroz blanco`. Esperado: NÃO entra no fluxo de produto. Cai em TACO fuzzy com "arroz, branco" ou pede esclarecimento normal.

Mandar: `comi 200g de leite`. Esperado: NÃO entra no fluxo de produto.

- [ ] **Step 6: Cenário 5 — consenso (manual)**

Como 3 usuários distintos (use `phoneNumber` diferentes em DEV), cadastrar o mesmo produto manual com macros parecidos. Rodar:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/products-consensus
```
Esperado: `{promoted: 1, ...}`. Verificar que aparece nova linha em `products` com `source='consenso_usuarios'`, `status='aprovado'`.

- [ ] **Step 7: Cenário 6 — OFF down**

Bloquear OFF localmente (ex: `sudo` mexer em `/etc/hosts` apontando `world.openfoodfacts.org` pra `127.0.0.1` ou simular timeout via env var temporária). Mandar produto novo. Esperado: bot vai direto pra cadastro manual sem travar.

- [ ] **Step 8: Sem commit (verificação manual)**

---

## Self-Review Checklist

- [x] **Spec coverage:** todos os componentes da spec têm task correspondente.
  - Tabelas products/product_usage → Task 1
  - Cliente OFF v2 → Task 4
  - Queries → Task 5
  - Guardrail → Task 6
  - Lookup → Task 7
  - Context types → Task 8
  - Flow conversacional → Task 9
  - Consenso → Task 10
  - Cron → Task 11
  - Integração meal-log → Task 12
  - Router → Task 13
  - Validação plausibilidade → Tasks 4 (OFF) + 9 (manual)
  - Filtragem brand-vazia + pergunta extra → Task 9 (handleAwaitingOffBrand)

- [x] **Placeholders:** sem TBD/TODO. Todos os steps têm código completo.

- [x] **Type consistency:** `Product`, `OffProduct`, `ProductLookupOutcome`, `FlowResult` definidos uma vez (Tasks 2/9) e reutilizados.

- [x] **Frequent commits:** cada task fecha em 1 commit. Build verde antes do commit (lint + tests).

- [x] **TDD discipline:** tasks 3-7, 9, 10 começam por teste falhando.

---

## Risks & Open Questions

- **OFF instabilidade futura:** se a v2 voltar a 503 em prod, feature flag `PRODUCTS_BASE_ENABLED` permite desligar (não implementada explicitamente neste plano — adicionar em Task 12 se quiser). Alternativa: o fallback já é cadastro manual, então o impacto é "todo cadastro vira manual" em vez de "feature offline".
- **Volume de produtos privados sem consenso:** se a base crescer com muitos produtos privados marca-vazia, a query de consenso pode ficar lenta. Índice `idx_products_private_owner` cobre busca por owner; se necessário, adicionar `idx_products_private_brand` no futuro.
- **RLS x service role:** o bot usa service-role no webhook (anônimo do ponto de vista de auth.uid). RLS policies aceitam service-role bypass por default. Confirmar no smoke test (Task 12 step 7).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-26-base-produtos-industrializados.md`.**

Próximo passo: dispatch dos agentes Sonnet em paralelo seguindo o agrupamento de fases acima (Phase 2 = paralelo, Phase 4+5 = paralelo, restante sequencial).
