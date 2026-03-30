# Migração USDA → Open Food Facts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a integração USDA (que exige API key + tradução LLM) pelo Open Food Facts (sem auth, busca em português nativo).

**Architecture:** Criar `src/lib/off/client.ts` com a mesma interface pública do `src/lib/usda/client.ts`, atualizar o import em `meal-log.ts`, migrar os testes e remover os artefatos USDA.

**Tech Stack:** TypeScript, Vitest, fetch nativo, Open Food Facts CGI Search API.

---

### Task 1: Criar o cliente Open Food Facts com testes

**Files:**
- Create: `src/lib/off/client.ts`
- Create: `tests/unit/off/client.test.ts`

- [ ] **Step 1: Criar o arquivo de testes com os casos de uso**

Criar `tests/unit/off/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { searchOFFFood } from '@/lib/off/client'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const offValidResponse = {
  products: [
    {
      id: 'abc123',
      product_name: 'Whey Protein Baunilha',
      completeness: 0.8,
      nutriments: {
        'energy-kcal_100g': 400,
        proteins_100g: 80,
        carbohydrates_100g: 10,
        fat_100g: 5,
      },
    },
  ],
}

const offMissingFatResponse = {
  products: [
    {
      id: 'def456',
      product_name: 'Produto Incompleto',
      completeness: 0.7,
      nutriments: {
        'energy-kcal_100g': 200,
        proteins_100g: 10,
        carbohydrates_100g: 30,
        // fat_100g ausente
      },
    },
  ],
}

const offLowCompletenessResponse = {
  products: [
    {
      id: 'ghi789',
      product_name: 'Produto Raso',
      completeness: 0.3,
      nutriments: {
        'energy-kcal_100g': 300,
        proteins_100g: 15,
        carbohydrates_100g: 40,
        fat_100g: 8,
      },
    },
  ],
}

const offEmptyResponse = { products: [] }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('searchOFFFood', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retorna OFFResult corretamente escalado para a quantidade informada', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offValidResponse,
    })

    const result = await searchOFFFood('Whey protein', 30)

    expect(result).not.toBeNull()
    expect(result!.food).toBe('Whey protein')
    expect(result!.offFoodName).toBe('Whey Protein Baunilha')
    expect(result!.offId).toBe('abc123')
    expect(result!.calories).toBe(120)   // 400 * 30/100 = 120
    expect(result!.protein).toBe(24)     // 80 * 0.3 = 24
    expect(result!.carbs).toBe(3)        // 10 * 0.3 = 3
    expect(result!.fat).toBe(1.5)        // 5 * 0.3 = 1.5
  })

  it('envia o User-Agent obrigatório na requisição', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offValidResponse,
    })

    await searchOFFFood('Arroz branco', 100)

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers['User-Agent']).toContain('CalorieBot')
  })

  it('ignora resultado sem fat_100g e retorna null quando nenhum válido', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offMissingFatResponse,
    })

    const result = await searchOFFFood('Produto incompleto', 100)

    expect(result).toBeNull()
  })

  it('ignora resultado com completeness < 0.5 e retorna null', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offLowCompletenessResponse,
    })

    const result = await searchOFFFood('Produto raso', 100)

    expect(result).toBeNull()
  })

  it('retorna null quando a lista de produtos está vazia', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => offEmptyResponse,
    })

    const result = await searchOFFFood('Comida inexistente', 100)

    expect(result).toBeNull()
  })

  it('retorna null quando a API retorna status HTTP não-2xx', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 })

    const result = await searchOFFFood('whey', 30)

    expect(result).toBeNull()
  })

  it('retorna null quando fetch lança exceção (timeout, rede)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const result = await searchOFFFood('whey', 30)

    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Rodar os testes — confirmar que FALHAM (arquivo não existe)**

```bash
npm run test:unit -- tests/unit/off/client.test.ts
```

Esperado: erro `Cannot find module '@/lib/off/client'`

- [ ] **Step 3: Criar `src/lib/off/client.ts`**

```typescript
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OFFResult {
  food: string        // nome original PT-BR passado pelo caller
  offFoodName: string // nome retornado pelo OFF
  offId: string       // id do produto no OFF
  calories: number    // kcal escaladas para quantityGrams
  protein: number     // gramas escaladas
  carbs: number       // gramas escaladas
  fat: number         // gramas escaladas
}

// ---------------------------------------------------------------------------
// OFF API types
// ---------------------------------------------------------------------------

interface OFFNutriments {
  'energy-kcal_100g'?: number
  proteins_100g?: number
  carbohydrates_100g?: number
  fat_100g?: number
}

interface OFFProduct {
  id: string
  product_name: string
  completeness: number
  nutriments: OFFNutriments
}

interface OFFSearchResponse {
  products: OFFProduct[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OFF_BASE_URL = 'https://world.openfoodfacts.org/cgi/search.pl'
const OFF_TIMEOUT_MS = 5000
const OFF_USER_AGENT = 'CalorieBot/1.0 (contato@caloriebot.app)'
const OFF_MIN_COMPLETENESS = 0.5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidProduct(product: OFFProduct): boolean {
  const n = product.nutriments
  return (
    product.completeness >= OFF_MIN_COMPLETENESS &&
    typeof n['energy-kcal_100g'] === 'number' &&
    n['energy-kcal_100g'] > 0 &&
    typeof n.proteins_100g === 'number' &&
    typeof n.carbohydrates_100g === 'number' &&
    typeof n.fat_100g === 'number'
  )
}

function scaleResult(product: OFFProduct, originalName: string, quantityGrams: number): OFFResult {
  const n = product.nutriments
  const scale = quantityGrams / 100
  return {
    food: originalName,
    offFoodName: product.product_name,
    offId: product.id,
    calories: Math.round(n['energy-kcal_100g']! * scale),
    protein: Math.round(n.proteins_100g! * scale * 10) / 10,
    carbs: Math.round(n.carbohydrates_100g! * scale * 10) / 10,
    fat: Math.round(n.fat_100g! * scale * 10) / 10,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function searchOFFFood(
  foodNamePtBr: string,
  quantityGrams: number,
): Promise<OFFResult | null> {
  const params = new URLSearchParams({
    search_terms: foodNamePtBr,
    search_simple: '1',
    action: 'process',
    json: '1',
    fields: 'product_name,nutriments,completeness,id',
    page_size: '5',
    cc: 'br',
    lc: 'pt',
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OFF_TIMEOUT_MS)

  try {
    const response = await fetch(`${OFF_BASE_URL}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': OFF_USER_AGENT },
    })

    if (!response.ok) return null

    const data: OFFSearchResponse = await response.json()

    if (!data.products || data.products.length === 0) return null

    for (const product of data.products) {
      if (isValidProduct(product)) {
        return scaleResult(product, foodNamePtBr, quantityGrams)
      }
    }

    return null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
```

- [ ] **Step 4: Rodar os testes — confirmar que PASSAM**

```bash
npm run test:unit -- tests/unit/off/client.test.ts
```

Esperado: todos os 7 testes passando.

- [ ] **Step 5: Commit**

```bash
git add src/lib/off/client.ts tests/unit/off/client.test.ts
git commit -m "feat: add Open Food Facts client replacing USDA"
```

---

### Task 2: Atualizar meal-log.ts e seus testes

**Files:**
- Modify: `src/lib/bot/flows/meal-log.ts` (linha 13 — import)
- Modify: `tests/unit/bot/meal-log.test.ts` (mock de `searchUSDAFood` → `searchOFFFood`)

- [ ] **Step 1: Atualizar o import em meal-log.ts**

Em `src/lib/bot/flows/meal-log.ts`, linha 13, substituir:

```typescript
// ANTES
import { searchUSDAFood } from '@/lib/usda/client'
```

por:

```typescript
// DEPOIS
import { searchOFFFood } from '@/lib/off/client'
```

- [ ] **Step 2: Atualizar todas as chamadas de searchUSDAFood no mesmo arquivo**

Buscar todas as ocorrências de `searchUSDAFood` em `meal-log.ts` e renomear para `searchOFFFood`. A assinatura da função é idêntica (`foodNamePtBr: string, quantityGrams: number`), então não há outras mudanças.

Confirmar com:

```bash
grep -n "searchUSDAFood\|searchOFFFood" src/lib/bot/flows/meal-log.ts
```

Esperado: zero ocorrências de `searchUSDAFood`, ao menos uma de `searchOFFFood`.

- [ ] **Step 3: Atualizar os mocks em meal-log.test.ts**

Em `tests/unit/bot/meal-log.test.ts`:

3a. No bloco `vi.hoisted`, renomear `mockSearchUSDAFood` para `mockSearchOFFFood`:

```typescript
// ANTES
mockSearchUSDAFood,
} = vi.hoisted(() => {
  ...
  mockSearchUSDAFood: vi.fn().mockResolvedValue(null),
  ...
})
```

```typescript
// DEPOIS
mockSearchOFFFood,
} = vi.hoisted(() => {
  ...
  mockSearchOFFFood: vi.fn().mockResolvedValue(null),
  ...
})
```

3b. Atualizar o `vi.mock` do módulo:

```typescript
// ANTES
vi.mock('@/lib/usda/client', () => ({
  searchUSDAFood: mockSearchUSDAFood,
}))
```

```typescript
// DEPOIS
vi.mock('@/lib/off/client', () => ({
  searchOFFFood: mockSearchOFFFood,
}))
```

3c. Substituir todas as referências a `mockSearchUSDAFood` no corpo dos testes por `mockSearchOFFFood`.

Confirmar com:

```bash
grep -n "mockSearchUSDAFood\|mockSearchOFFFood\|usda" tests/unit/bot/meal-log.test.ts
```

Esperado: zero ocorrências de `mockSearchUSDAFood` e `usda`.

- [ ] **Step 4: Rodar toda a suite de testes unitários**

```bash
npm run test:unit
```

Esperado: todos os testes passando, zero falhas.

- [ ] **Step 5: Verificar que TypeScript compila sem erros**

```bash
npx tsc --noEmit
```

Esperado: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/flows/meal-log.ts tests/unit/bot/meal-log.test.ts
git commit -m "feat: wire meal-log to use Open Food Facts instead of USDA"
```

---

### Task 3: Remover artefatos USDA e limpar env vars

**Files:**
- Delete: `src/lib/usda/client.ts`
- Delete: `tests/unit/usda/client.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Confirmar que nenhum arquivo importa mais o módulo USDA**

```bash
grep -rn "usda" src/ tests/
```

Esperado: zero resultados (ou apenas o arquivo que vamos deletar).

- [ ] **Step 2: Deletar os arquivos USDA**

```bash
rm src/lib/usda/client.ts
rm tests/unit/usda/client.test.ts
rmdir src/lib/usda
rmdir tests/unit/usda
```

- [ ] **Step 3: Remover USDA_API_KEY do .env.example**

Em `.env.example`, remover as linhas:

```
# USDA FoodData Central (free — get key at https://fdc.nal.usda.gov/api-key-signup/)
USDA_API_KEY=
```

- [ ] **Step 4: Rodar toda a suite de testes para confirmar nada quebrou**

```bash
npm run test:unit
```

Esperado: todos os testes passando.

- [ ] **Step 5: Verificar TypeScript**

```bash
npx tsc --noEmit
```

Esperado: sem erros.

- [ ] **Step 6: Commit e push**

```bash
git add -A
git commit -m "chore: remove USDA client and clean up env vars"
git push
```

---

### Task 4: Remover USDA_API_KEY do Vercel (pós-deploy)

- [ ] **Step 1: Confirmar que o deploy foi bem-sucedido**

Verificar no Vercel dashboard ou via CLI que o novo deploy está ativo e sem erros.

- [ ] **Step 2: Remover a env var do Vercel**

```bash
vercel env rm USDA_API_KEY production
vercel env rm USDA_API_KEY preview
vercel env rm USDA_API_KEY development
```

Confirmar quando solicitado.

- [ ] **Step 3: Testar manualmente via WhatsApp**

Enviar uma refeição com um produto embalado (ex: "30g de whey protein") e confirmar que as calorias são calculadas corretamente.
