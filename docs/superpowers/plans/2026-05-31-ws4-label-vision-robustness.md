# WS4 — Robustez do rótulo/visão (números certos) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar o overscale e os números errados na leitura de rótulos/fotos: tornar a escala do rótulo defensiva (base obrigatória + sanity-check kcal/g), endurecer o parser de gramas/porções da legenda, e parar de colapsar macro desconhecido em 0.

**Architecture:** As correções concentram-se em três funções puras já existentes — `scaleNutritionLabelItem` (escala defensiva), `extractLabelGramsFromCaption` (parser de gramas) e `extractLabelPortionsFromCaption`/`PORTION_KEYWORDS` (parser de porções) — porque são triviais de testar em isolamento (TDD direto). O `handler.ts` apenas consome os novos contratos: deixa de stringificar porções (passa `number`), restringe `nutrition_label` a 1 item, e propaga `null` (desconhecido) em vez de `0` ao montar os itens. O prompt de visão (`vision.ts`) é reforçado para 1 item por rótulo e base obrigatória. Nada toca DB/migração (fibra fica fora de escopo).

**Tech Stack:** TypeScript strict, Vitest (`npx vitest run <arquivo>`), Zod (schemas de LLM), Next.js. Alias `@/*` → `src/*`. Sem novas dependências.

---

## Decisões de produto (defaults escolhidos)

| # | Decisão | Default best-practice adotado | Alternativa (ajustável) |
|---|---------|-------------------------------|--------------------------|
| 1 | Overscale do rótulo | `nutrition_basis_grams` efetivamente obrigatório: se null/≤0, NÃO escalar por gramas (ratio neutro por porção) **e** sanity-check kcal/g (>9 kcal/g da porção → recusa/clarifica via flag `needsLabelClarification`). | Só o sanity-check >9 kcal/g. |
| 2 | Rótulo multi-item | Restringir `nutrition_label` a 1 item; se vision devolver >1, pedir esclarecimento. | Escalar por item. |
| 3 | Parser de gramas | Preferir número ancorado por verbo de consumo (comi/consumi/ingeri/tomei); suportar kg(×1000)/mg(÷1000); `N×Yg`/`N fatias de Yg` = N·Y; ≥2 ocorrências ambíguas sem âncora → ambíguo. | Só kg/mg + heurística do 1º match. |
| 4 | PORTION_KEYWORDS | Adicionar bola(s), colher(es), fatia(s), concha(s), xicara(s), copo(s), lata(s). | Manter conjunto atual. |
| 5 | Macro ausente | Persistir `null` (desconhecido ≠ 0g); coalescer só nas somas. | Fallback TACO por nome. |
| 6 | Fibra | Fora de escopo — documentar que o rótulo descarta fibra. | Adicionar campo+coluna+agregação. |
| 7 | Float de porções | Passar `number` direto; `handleLabelPortions` aceita `string \| number`. | Manter string. |

## File Structure

```
src/lib/bot/nutrition-label.ts        # MODIFY: sanity-check + base obrigatória; novo MAX_KCAL_PER_GRAM e shouldRejectLabelScale
src/lib/bot/label-portions.ts         # MODIFY: PORTION_KEYWORDS (Task 4) + extractLabelGramsFromCaption robusto (Task 3)
src/lib/bot/handler.ts                # MODIFY: number direto (Task 6); restringe nutrition_label a 1 item (Task 5); null em vez de 0 nas somas (Task 7)
src/lib/llm/prompts/vision.ts         # MODIFY: 1 item/rótulo + base obrigatória (Task 5/Task 1)
tests/unit/bot/nutrition-label.test.ts  # MODIFY: testes de overscale/recusa
tests/unit/bot/label-portions.test.ts   # MODIFY: testes de gramas/porções
```

---

### Task 1: Sanity-check de densidade calórica e base obrigatória em `scaleNutritionLabelItem`

Hoje `scaleNutritionLabelItem` (src/lib/bot/nutrition-label.ts:23-45) faz `basisGrams = nutrition_basis_grams>0 ? : servingGrams` e `baseCalories = nutrition_basis_calories ?? calories`. Se o LLM mandar `calories=120` (por 100g) e omitir `nutrition_basis_grams`, ele usa `basisGrams = servingGrams` e a porção infla. Vamos: (a) quando `nutrition_basis_grams` for null/≤0, NÃO usar `servingGrams` como base de gramas (ratio = `portions`, sem reescalar por grama); (b) expor `MAX_KCAL_PER_GRAM = 9` e uma função pura `shouldRejectLabelScale(item)` que sinaliza overscale implausível (kcal/g da PORÇÃO resultante > 9). O handler usa essa flag depois (Task 5).

**Files:**
- Modify: `src/lib/bot/nutrition-label.ts:23-45`
- Test: `tests/unit/bot/nutrition-label.test.ts`

- [ ] **Step 1: Write the failing test**

Adicionar ao fim de `tests/unit/bot/nutrition-label.test.ts` (importar a nova API no topo):

```ts
import {
  roundLabelCalories,
  scaleNutritionLabelItem,
  shouldRejectLabelScale,
  MAX_KCAL_PER_GRAM,
} from '@/lib/bot/nutrition-label'

describe('scaleNutritionLabelItem — base de gramas ausente (overscale)', () => {
  it('não reescala por grama quando nutrition_basis_grams é null (usa só porções)', () => {
    // Rótulo: 120 kcal por 100g; LLM esqueceu nutrition_basis_grams; porção 60g.
    // ANTES: basisGrams caía pra servingGrams=60, ratio=60/60=1 → 120 kcal (errado, era pra ser 72).
    // Sem base confiável, NÃO inferimos por grama: aplicamos só o fator de porções (1) → 120 fica como veio.
    const scaled = scaleNutritionLabelItem({
      quantity_grams: 60,
      nutrition_basis_grams: null,
      calories: 120,
      protein: 6,
      carbs: 10,
      fat: 4,
    })
    expect(scaled.quantity_grams).toBe(60)
    expect(scaled.calories).toBe(120)
    expect(scaled.protein).toBe(6)
  })

  it('escala corretamente quando a base existe: 120kcal/100g, porção 60g => 72 kcal', () => {
    const scaled = scaleNutritionLabelItem({
      quantity_grams: 60,
      nutrition_basis_grams: 100,
      nutrition_basis_calories: 120,
      nutrition_basis_protein: 6,
      nutrition_basis_carbs: 10,
      nutrition_basis_fat: 4,
    })
    expect(scaled.quantity_grams).toBe(60)
    expect(scaled.calories).toBe(72) // 120 * 60/100
    expect(scaled.carbs).toBe(6)     // 10 * 0.6
  })
})

describe('shouldRejectLabelScale — sanity-check kcal/g', () => {
  it('MAX_KCAL_PER_GRAM é 9', () => {
    expect(MAX_KCAL_PER_GRAM).toBe(9)
  })

  it('recusa quando a porção resultante excede 9 kcal/g', () => {
    // 700 kcal em 60g = 11.67 kcal/g → implausível (gordura pura ~9 kcal/g)
    const scaled = scaleNutritionLabelItem({
      quantity_grams: 60,
      nutrition_basis_grams: 100,
      nutrition_basis_calories: 1167,
    })
    expect(shouldRejectLabelScale(scaled)).toBe(true)
  })

  it('aceita densidades plausíveis (<=9 kcal/g)', () => {
    const scaled = scaleNutritionLabelItem({
      quantity_grams: 60,
      nutrition_basis_grams: 100,
      nutrition_basis_calories: 120,
    })
    expect(shouldRejectLabelScale(scaled)).toBe(false)
  })

  it('não recusa quando calorias ou gramas são desconhecidas', () => {
    expect(shouldRejectLabelScale({ quantity_grams: 60, calories: null })).toBe(false)
    expect(shouldRejectLabelScale({ quantity_grams: 0, calories: 100 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/nutrition-label.test.ts`
Expected: FAIL — `shouldRejectLabelScale` e `MAX_KCAL_PER_GRAM` não existem (erro de import/undefined) e o teste de "base ausente" falha porque hoje `scaled.calories` vira o overscale em vez de manter 120.

- [ ] **Step 3: Write minimal implementation**

Reescrever o corpo de `src/lib/bot/nutrition-label.ts` a partir da linha 23 (mantendo `roundToSingleDecimal` e `roundLabelCalories` intactos acima):

```ts
export const MAX_KCAL_PER_GRAM = 9

export function scaleNutritionLabelItem<T extends NutritionLabelItem>(item: T, portions: number = 1): T {
  const servingGrams = item.quantity_grams ?? 0
  // Base de gramas confiável SÓ quando o LLM informou nutrition_basis_grams (>0).
  // Sem ela, NÃO inferimos servingGrams como base (causava overscale); aplicamos só o fator de porções.
  const hasReliableBasis = item.nutrition_basis_grams != null && item.nutrition_basis_grams > 0
  const baseCalories = item.nutrition_basis_calories ?? item.calories
  const baseProtein = item.nutrition_basis_protein ?? item.protein
  const baseCarbs = item.nutrition_basis_carbs ?? item.carbs
  const baseFat = item.nutrition_basis_fat ?? item.fat

  const ratio = hasReliableBasis && servingGrams > 0
    ? (servingGrams / (item.nutrition_basis_grams as number)) * portions
    : portions

  return {
    ...item,
    quantity_grams: roundToSingleDecimal(servingGrams * portions),
    calories: baseCalories == null ? null : roundLabelCalories(baseCalories * ratio),
    protein: baseProtein == null ? null : roundToSingleDecimal(baseProtein * ratio),
    carbs: baseCarbs == null ? null : roundToSingleDecimal(baseCarbs * ratio),
    fat: baseFat == null ? null : roundToSingleDecimal(baseFat * ratio),
  }
}

/**
 * Sanity-check: densidade calórica de uma porção já escalada não pode passar de
 * MAX_KCAL_PER_GRAM (gordura pura ~9 kcal/g). Acima disso, a leitura do rótulo
 * provavelmente está errada (overscale) e o handler deve pedir esclarecimento.
 * Retorna false quando calorias ou gramas são desconhecidas (não dá pra julgar).
 */
export function shouldRejectLabelScale(item: NutritionLabelItem): boolean {
  const grams = item.quantity_grams ?? 0
  const calories = item.calories
  if (calories == null || grams <= 0) return false
  return calories / grams > MAX_KCAL_PER_GRAM
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bot/nutrition-label.test.ts`
Expected: PASS (todos os describes, incluindo os pré-existentes 7,5g/5g).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/nutrition-label.ts tests/unit/bot/nutrition-label.test.ts
git commit -m "fix(nutrition-label): base de gramas obrigatória + sanity-check kcal/g contra overscale"
```

---

### Task 2: Documentar que fibra fica fora de escopo

Decisão 6: rótulo descarta fibra. Não há mudança de código — só um comentário JSDoc no topo de `nutrition-label.ts` para que o próximo dev não assuma que fibra é agregada. Sem teste (apenas comentário).

**Files:**
- Modify: `src/lib/bot/nutrition-label.ts:1` (acima do `type NutritionLabelItem`)

- [ ] **Step 1: Write minimal implementation**

Inserir no topo do arquivo, antes da linha 1:

```ts
/**
 * Escala de rótulos nutricionais.
 *
 * ESCOPO: calorias, proteína, carboidrato e gordura. FIBRA é deliberadamente
 * descartada — não há campo de fibra no schema de visão nem coluna no DB.
 * Adicionar fibra é uma WS própria (schema image-analysis + prompt + coluna +
 * agregação dos somatórios). Ver WS4 decisão 6.
 */
```

- [ ] **Step 2: Run test to verify nothing broke**

Run: `npx vitest run tests/unit/bot/nutrition-label.test.ts`
Expected: PASS (comentário não altera comportamento).

- [ ] **Step 3: Commit**

```bash
git add src/lib/bot/nutrition-label.ts
git commit -m "docs(nutrition-label): registrar que fibra fica fora de escopo (WS4 decisão 6)"
```

---

### Task 3: `extractLabelGramsFromCaption` robusto (verbo de consumo, kg/mg, N×Yg, ambiguidade)

Hoje (src/lib/bot/label-portions.ts:79-91) pega o **1º** `\d+g`, ignora kg/mg e multiplicadores, e não distingue "porção 60g" (rótulo) de "comi 30g" (consumo). Vamos retornar a melhor estimativa de gramas CONSUMIDAS: âncora por verbo > multiplicador `N×Yg` > único match. Se houver ≥2 ocorrências ambíguas sem âncora de verbo, sinalizar ambiguidade. Para manter a assinatura pública compatível com os call sites e testes existentes, `extractLabelGramsFromCaption` continua retornando `number | null`; adicionamos uma função irmã `extractLabelGramsDetailed` que retorna `{ grams: number | null; ambiguous: boolean }` para o handler decidir perguntar.

**Files:**
- Modify: `src/lib/bot/label-portions.ts:79-91`
- Test: `tests/unit/bot/label-portions.test.ts`

- [ ] **Step 1: Write the failing test**

Atualizar o import no topo e adicionar describes em `tests/unit/bot/label-portions.test.ts`:

```ts
import {
  extractLabelGramsFromCaption,
  extractLabelGramsDetailed,
  extractLabelPortionsFromCaption,
} from '@/lib/bot/label-portions'

describe('extractLabelGramsFromCaption — unidades kg/mg', () => {
  it('converte kg para gramas (×1000)', () => {
    expect(extractLabelGramsFromCaption('comi 1,2 kg de arroz')).toBe(1200)
    expect(extractLabelGramsFromCaption('comi 1kg')).toBe(1000)
  })

  it('converte mg para gramas (÷1000)', () => {
    expect(extractLabelGramsFromCaption('tomei 500 mg de creatina')).toBe(0.5)
  })
})

describe('extractLabelGramsFromCaption — âncora por verbo de consumo', () => {
  it('prefere o número ancorado por "comi" mesmo que outro grama apareça antes', () => {
    // "porção 60g" é do rótulo; "comi 30g" é o consumo → queremos 30.
    expect(extractLabelGramsFromCaption('porção 60g, comi 30g')).toBe(30)
  })

  it('reconhece consumi/ingeri/tomei', () => {
    expect(extractLabelGramsFromCaption('base 100g, consumi 25 g')).toBe(25)
    expect(extractLabelGramsFromCaption('ingeri 40g')).toBe(40)
  })
})

describe('extractLabelGramsFromCaption — multiplicador N x Yg', () => {
  it('multiplica "2 fatias de 30g" = 60', () => {
    expect(extractLabelGramsFromCaption('2 fatias de 30g')).toBe(60)
  })

  it('multiplica "3x 25g" = 75', () => {
    expect(extractLabelGramsFromCaption('3x 25g')).toBe(75)
  })
})

describe('extractLabelGramsDetailed — ambiguidade', () => {
  it('marca ambíguo quando há 2+ gramas sem âncora de verbo', () => {
    const r = extractLabelGramsDetailed('uma com 60g e outra com 40g')
    expect(r.ambiguous).toBe(true)
    expect(r.grams).toBeNull()
  })

  it('não é ambíguo com âncora de verbo, retorna o consumido', () => {
    const r = extractLabelGramsDetailed('porção 60g, comi 30g')
    expect(r.ambiguous).toBe(false)
    expect(r.grams).toBe(30)
  })

  it('não é ambíguo com um único grama', () => {
    const r = extractLabelGramsDetailed('comi 100g')
    expect(r.ambiguous).toBe(false)
    expect(r.grams).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/label-portions.test.ts`
Expected: FAIL — `extractLabelGramsDetailed` não existe; kg/mg/verbo/multiplicador não são tratados (ex: `'comi 1,2 kg'` hoje retorna `1.2`, esperado `1200`).

- [ ] **Step 3: Write minimal implementation**

Substituir `extractLabelGramsFromCaption` (linhas 79-91) por:

```ts
const CONSUMPTION_VERBS = ['comi', 'consumi', 'ingeri', 'tomei', 'comer', 'consumir']

type GramMatch = { grams: number; index: number }

function unitToGrams(value: number, unit: string): number {
  if (unit.startsWith('kg')) return value * 1000
  if (unit.startsWith('mg')) return value / 1000
  return value // g / grama(s)
}

// Captura "<num> <unidade>" onde unidade ∈ {g, grama(s), kg, mg}. Também captura
// o multiplicador opcional "<N>x <num><unidade>" e "<N> ... de <num><unidade>".
function collectGramMatches(normalized: string): GramMatch[] {
  const out: GramMatch[] = []
  const re = /(\d+(?:[.,]\d+)?)\s*(kg|mg|gramas?|g)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(normalized)) !== null) {
    const value = parseFloat(m[1].replace(',', '.'))
    if (Number.isNaN(value) || value <= 0) continue
    let grams = unitToGrams(value, m[2])

    // Multiplicador "N x ..." ou "N <palavra> de ..." imediatamente antes (ex: "2 fatias de 30g", "3x 25g").
    const before = normalized.slice(0, m.index)
    const mult = before.match(/(\d+(?:[.,]\d+)?)\s*(?:x|×|\w+\s+de)\s*$/)
    if (mult) {
      const n = parseFloat(mult[1].replace(',', '.'))
      if (!Number.isNaN(n) && n > 0) grams = grams * n
    }
    out.push({ grams: roundToSingleDecimal(grams), index: m.index })
  }
  return out
}

function findVerbAnchoredGrams(normalized: string, matches: GramMatch[]): number | null {
  for (const verb of CONSUMPTION_VERBS) {
    const vIdx = normalized.indexOf(verb)
    if (vIdx === -1) continue
    // Primeiro grama que aparece DEPOIS do verbo (até ~25 chars de distância).
    const anchored = matches.find((g) => g.index >= vIdx && g.index - vIdx <= 25)
    if (anchored) return anchored.grams
  }
  return null
}

export function extractLabelGramsDetailed(
  caption?: string | null,
): { grams: number | null; ambiguous: boolean } {
  if (!caption) return { grams: null, ambiguous: false }
  const normalized = normalize(caption)
  const matches = collectGramMatches(normalized)

  if (matches.length === 0) return { grams: null, ambiguous: false }

  const anchored = findVerbAnchoredGrams(normalized, matches)
  if (anchored !== null) return { grams: anchored, ambiguous: false }

  if (matches.length === 1) return { grams: matches[0].grams, ambiguous: false }

  // ≥2 gramas, nenhuma ancorada por verbo → não dá pra decidir.
  return { grams: null, ambiguous: true }
}

export function extractLabelGramsFromCaption(caption?: string | null): number | null {
  return extractLabelGramsDetailed(caption).grams
}
```

Adicionar `import { roundToSingleDecimal } from '@/lib/bot/nutrition-label'`? Não — `roundToSingleDecimal` não é exportado. Em vez disso, definir um helper local no topo de `label-portions.ts` (logo após `normalize`):

```ts
function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bot/label-portions.test.ts`
Expected: PASS. Conferir que os testes pré-existentes (`'comi 55 g'`→55, `'30,5g'`→30.5, `'100gb'`→null) continuam verdes — `100gb` não casa porque `\b` após `g` exige fronteira de palavra e `b` não é fronteira.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/label-portions.ts tests/unit/bot/label-portions.test.ts
git commit -m "fix(label-portions): parser de gramas com verbo de consumo, kg/mg, multiplicador NxYg e flag de ambiguidade"
```

---

### Task 4: Expandir `PORTION_KEYWORDS`

Decisão 4: adicionar bola(s), colher(es), fatia(s), concha(s), xicara(s), copo(s), lata(s) ao `PORTION_KEYWORDS` (src/lib/bot/label-portions.ts:1-23).

**Files:**
- Modify: `src/lib/bot/label-portions.ts:1-23`
- Test: `tests/unit/bot/label-portions.test.ts`

- [ ] **Step 1: Write the failing test**

Adicionar ao describe `extractLabelPortionsFromCaption`:

```ts
describe('extractLabelPortionsFromCaption — novas keywords', () => {
  it('reconhece bola, colher, fatia, concha, xicara, copo, lata', () => {
    expect(extractLabelPortionsFromCaption('lanche 2 bolas')).toBe(2)
    expect(extractLabelPortionsFromCaption('cafe 1 colher')).toBe(1)
    expect(extractLabelPortionsFromCaption('almoco 3 fatias')).toBe(3)
    expect(extractLabelPortionsFromCaption('jantar 1 concha')).toBe(1)
    expect(extractLabelPortionsFromCaption('lanche meia xicara')).toBe(0.5)
    expect(extractLabelPortionsFromCaption('ceia 1 copo')).toBe(1)
    expect(extractLabelPortionsFromCaption('treino 2 latas')).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/label-portions.test.ts -t "novas keywords"`
Expected: FAIL — keywords ainda não estão em `PORTION_KEYWORDS`, todas retornam `null`.

- [ ] **Step 3: Write minimal implementation**

Adicionar antes do `] as const` na linha 23 (após `'saches',`):

```ts
  'bola',
  'bolas',
  'colher',
  'colheres',
  'fatia',
  'fatias',
  'concha',
  'conchas',
  'xicara',
  'xicaras',
  'copo',
  'copos',
  'lata',
  'latas',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bot/label-portions.test.ts`
Expected: PASS (incluindo os testes pré-existentes de dose/scoop/porção).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/label-portions.ts tests/unit/bot/label-portions.test.ts
git commit -m "feat(label-portions): adicionar bola/colher/fatia/concha/xicara/copo/lata a PORTION_KEYWORDS"
```

---

### Task 5: Restringir `nutrition_label` a 1 item e aplicar sanity-check no handler

No handler (src/lib/bot/handler.ts:855-906) o ramo `nutrition_label` usa `mealAnalysis.items[0]` para o preview/servingGrams mas, no caminho de `handleLabelPortions` (linha 990), faz `items.map(scaleNutritionLabelItem)` — aplicando o mesmo número de porções a TODOS os itens. Vamos: (a) se `imageResult.image_type === 'nutrition_label'` e `imageResult.items.length > 1`, pedir esclarecimento e parar; (b) antes de escalar, rodar `shouldRejectLabelScale` no preview — se reprovar, pedir a base/gramas em vez de registrar número implausível.

Notar: o `previewItem` é montado na linha 856 e usado na mensagem 892-893. O ramo de "perguntar porções" (898-905) seta `awaiting_label_portions`. Vamos inserir os dois guards logo no início do `if (imageResult.image_type === 'nutrition_label')` (linha 855), antes da linha 856.

**Files:**
- Modify: `src/lib/bot/handler.ts:855-857` (inserir guards)
- Modify: `src/lib/bot/handler.ts:39-40` (incluir `shouldRejectLabelScale` no import)
- Modify: `src/lib/llm/prompts/vision.ts:28-33` (reforçar 1 item por rótulo)
- Test: cobertura unitária é feita por Task 1 (`shouldRejectLabelScale`); o guard de handler é integração leve. Adicionamos um teste de unidade do guard como função pura extraída para manter testabilidade.

Para manter testável, extrair a decisão de guard num helper puro em `nutrition-label.ts`:

- [ ] **Step 1: Write the failing test**

Adicionar em `tests/unit/bot/nutrition-label.test.ts`:

```ts
import {
  // ... imports anteriores
  labelClarificationReason,
} from '@/lib/bot/nutrition-label'

describe('labelClarificationReason', () => {
  it('pede esclarecimento quando há mais de 1 item no rótulo', () => {
    expect(labelClarificationReason([{ quantity_grams: 60, calories: 120 }, { quantity_grams: 30, calories: 60 }], 1))
      .toBe('multi_item')
  })

  it('pede esclarecimento quando a escala estoura kcal/g', () => {
    expect(labelClarificationReason([{ quantity_grams: 60, nutrition_basis_grams: 100, nutrition_basis_calories: 1167 }], 1))
      .toBe('implausible_density')
  })

  it('retorna null quando o item único é plausível', () => {
    expect(labelClarificationReason([{ quantity_grams: 60, nutrition_basis_grams: 100, nutrition_basis_calories: 120 }], 1))
      .toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/nutrition-label.test.ts -t labelClarificationReason`
Expected: FAIL — `labelClarificationReason` não existe.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/nutrition-label.ts`, adicionar ao fim:

```ts
/**
 * Decide se um conjunto de itens de rótulo precisa de esclarecimento antes de registrar.
 * - 'multi_item': vision devolveu >1 item para um único rótulo (um número de porções não serve).
 * - 'implausible_density': a porção escalada passa de MAX_KCAL_PER_GRAM (provável overscale).
 * - null: pode registrar.
 */
export function labelClarificationReason<T extends NutritionLabelItem>(
  items: T[],
  portions: number = 1,
): 'multi_item' | 'implausible_density' | null {
  if (items.length > 1) return 'multi_item'
  const item = items[0]
  if (!item) return null
  if (shouldRejectLabelScale(scaleNutritionLabelItem(item, portions))) return 'implausible_density'
  return null
}
```

Em `src/lib/bot/handler.ts`, ajustar o import (linha 40):

```ts
import { scaleNutritionLabelItem, labelClarificationReason } from '@/lib/bot/nutrition-label'
```

Inserir, logo após a linha 855 (`if (imageResult.image_type === 'nutrition_label') {`) e antes da linha 856:

```ts
      const labelReason = labelClarificationReason(mealAnalysis.items, 1)
      if (labelReason !== null) {
        const reasonMsg = labelReason === 'multi_item'
          ? 'Detectei mais de um produto nessa tabela 😅 Me diz qual produto você comeu (e a quantidade) que eu registro.'
          : 'Os números desse rótulo ficaram estranhos pra essa porção 🤔 Me confirma a base da tabela (ex: "por 100g" ou "por 30g") e quanto você comeu?'
        await setState(user.id, 'awaiting_label_portions', {
          mealAnalysis: mealAnalysis as unknown as Record<string, unknown>,
          originalMessage: caption || '[imagem]',
        })
        await sendTextMessage(from, reasonMsg)
        saveHistory(supabase, user.id, caption || '[imagem de alimento]', reasonMsg)
        return
      }
```

Em `src/lib/llm/prompts/vision.ts`, reforçar a seção "SE TABELA NUTRICIONAL" — substituir a linha 33 (`5. Use o nome do produto como nome do item (se visível)`) por:

```ts
5. Use o nome do produto como nome do item (se visível)
6. UM rótulo = UM item. Mesmo que a embalagem liste vários sabores/variações, retorne APENAS o produto principal mostrado. NUNCA retorne mais de um item para image_type="nutrition_label".
7. "nutrition_basis_grams" é OBRIGATÓRIO para rótulos: é a base em gramas da coluna nutricional (ex: 100g). Se você não conseguir lê-la, retorne needs_clarification: true.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bot/nutrition-label.test.ts`
Expected: PASS.

Run (handler não quebrou): `npx vitest run tests/unit/bot/handler.test.ts`
Expected: PASS (nenhum teste existente exercita rótulo multi-item nem overscale; os fluxos de porção única seguem iguais).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/nutrition-label.ts src/lib/bot/handler.ts src/lib/llm/prompts/vision.ts tests/unit/bot/nutrition-label.test.ts
git commit -m "feat(handler): restringir rótulo a 1 item e clarificar overscale; prompt de visão 1-item + base obrigatória"
```

---

### Task 6: Passar porções como `number` (sem round-trip String→parseFloat)

handler.ts:866-885 chama `handleLabelPortions(..., String(resolvedPortions), ...)` e `handleLabelPortions` (972-986) refaz `parseFloat(message.trim()...)`. Como `resolvedPortions` já é `number` (ou null), `String(0.8333333)` reintroduz ruído. Decisão 7: `handleLabelPortions` aceita `string | number`; quando vier `number`, usa direto.

**Files:**
- Modify: `src/lib/bot/handler.ts:972-986` (assinatura + parse) e `:872` (call site)

- [ ] **Step 1: Write the failing test**

Não há teste unitário direto de `handleLabelPortions` (é função interna não exportada e depende de Supabase). A verificação é por tipo/comportamento: garantir que o número não passa por `String()`. Vamos cobrir via um teste de unidade da lógica de parse extraída. Extrair helper puro exportado em `label-portions.ts`:

Adicionar em `tests/unit/bot/label-portions.test.ts`:

```ts
import {
  // ...
  coercePortions,
} from '@/lib/bot/label-portions'

describe('coercePortions', () => {
  it('aceita number direto sem round-trip de string', () => {
    expect(coercePortions(0.8333333333333334)).toBe(0.8333333333333334)
    expect(coercePortions(2)).toBe(2)
  })

  it('faz parse de string com vírgula', () => {
    expect(coercePortions('1,5')).toBe(1.5)
    expect(coercePortions(' 2 ')).toBe(2)
  })

  it('rejeita valores inválidos ou <= 0', () => {
    expect(coercePortions('abc')).toBeNull()
    expect(coercePortions(0)).toBeNull()
    expect(coercePortions(-1)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/label-portions.test.ts -t coercePortions`
Expected: FAIL — `coercePortions` não existe.

- [ ] **Step 3: Write minimal implementation**

Em `src/lib/bot/label-portions.ts`, adicionar:

```ts
export function coercePortions(input: string | number): number | null {
  const n = typeof input === 'number' ? input : parseFloat(input.trim().replace(',', '.'))
  if (Number.isNaN(n) || n <= 0) return null
  return n
}
```

Em `src/lib/bot/handler.ts`, ajustar import (linha 39):

```ts
import { extractLabelGramsFromCaption, extractLabelPortionsFromCaption, coercePortions } from '@/lib/bot/label-portions'
```

Trocar a assinatura de `handleLabelPortions` (linha 977) de `message: string,` para `message: string | number,` e o corpo (linhas 981-986):

```ts
  const portions = coercePortions(message)

  if (portions === null) {
    await sendTextMessage(from, 'Me manda um número de porções (ex: 1, 2, 0.5) 😊')
    return
  }
```

Trocar o call site (linha 872) de `String(resolvedPortions),` para `resolvedPortions,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bot/label-portions.test.ts`
Expected: PASS.

Run: `npx vitest run tests/unit/bot/handler.test.ts`
Expected: PASS (o fluxo de texto que entra em `handleLabelPortions` via estado `awaiting_label_portions` continua passando `string`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/label-portions.ts src/lib/bot/handler.ts tests/unit/bot/label-portions.test.ts
git commit -m "refactor(handler): passar porções como number e centralizar parse em coercePortions"
```

---

### Task 7: Parar de colapsar macro desconhecido em 0 nos itens do rótulo

handler.ts monta `items` para `logFoodToMeal` com `carbsG: item.carbs ?? 0` em vários pontos (ex.: 919-923, 941-946, 1007-1012, 1028-1033). Decisão 5: distinguir desconhecido (`null`) de `0g`. O coalescing `?? 0` deve ficar SÓ nos pontos de soma. Para não alterar contrato de `logFoodToMeal` nesta WS (risco fora de escopo), vamos preservar `null` quando o macro vier `null` apenas nos itens do RÓTULO (caminho `nutrition_label`/`handleLabelPortions`), passando `proteinG/carbsG/fatG/calories` como `?? null` em vez de `?? 0`. Primeiro confirmamos o contrato real de `logFoodToMeal`.

**Files:**
- Read: `src/lib/bot/meal-log.ts` (ou onde `logFoodToMeal` aceita os items) para confirmar se `proteinG` aceita `null`.
- Modify: `src/lib/bot/handler.ts:1007-1012` e `:1028-1033` (caminho do rótulo em `handleLabelPortions`).
- Test: unitário via helper puro `labelItemToLogItem` extraído (testável sem Supabase).

- [ ] **Step 1: Confirmar contrato de logFoodToMeal**

Run: `grep -n "logFoodToMeal\|proteinG\|carbsG\|fatG\|quantityGrams" src/lib/bot/meal-log.ts | head -40`
Expected: ver a assinatura do tipo de item aceito. Se `proteinG` for `number` (não-nullable), NÃO mudar o contrato nesta WS: em vez disso, manter `?? 0` mas registrar TODO. Se for `number | null`, prosseguir com `?? null`.

(Se o tipo for `number` estrito, esta Task vira: extrair `labelItemToLogItem` mantendo `?? 0` e adicionar comentário documentando o ponto de extensão — o teste abaixo passa a asseverar `0` em vez de `null`. O dev escolhe o branch conforme o grep.)

- [ ] **Step 2: Write the failing test** (assumindo contrato `number | null`)

Adicionar em `tests/unit/bot/nutrition-label.test.ts`:

```ts
import {
  // ...
  labelItemToLogItem,
} from '@/lib/bot/nutrition-label'

describe('labelItemToLogItem', () => {
  it('preserva null para macro desconhecido (não vira 0)', () => {
    const out = labelItemToLogItem({
      food: 'Whey',
      quantity_grams: 30,
      calories: 120,
      protein: 24,
      carbs: null,
      fat: null,
    })
    expect(out.proteinG).toBe(24)
    expect(out.carbsG).toBeNull()
    expect(out.fatG).toBeNull()
    expect(out.quantityGrams).toBe(30)
    expect(out.source).toBe('manual')
  })

  it('preserva 0 explícito como 0 (rótulo diz 0g)', () => {
    const out = labelItemToLogItem({
      food: 'Refri zero',
      quantity_grams: 350,
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
    })
    expect(out.carbsG).toBe(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/bot/nutrition-label.test.ts -t labelItemToLogItem`
Expected: FAIL — `labelItemToLogItem` não existe.

- [ ] **Step 4: Write minimal implementation**

Em `src/lib/bot/nutrition-label.ts`, adicionar (o tipo de retorno deve casar com o item aceito por `logFoodToMeal`; ajustar nomes conforme grep do Step 1):

```ts
type LabelLogItem = {
  foodName: string
  quantityGrams: number
  calories: number | null
  proteinG: number | null
  carbsG: number | null
  fatG: number | null
  source: 'manual'
}

export function labelItemToLogItem(
  item: NutritionLabelItem & { food?: string | null },
): LabelLogItem {
  return {
    foodName: item.food ?? 'Alimento',
    quantityGrams: item.quantity_grams ?? 0,
    calories: item.calories ?? null,
    proteinG: item.protein ?? null,
    carbsG: item.carbs ?? null,
    fatG: item.fat ?? null,
    source: 'manual',
  }
}
```

Em `handleLabelPortions` (handler.ts), trocar o mapeamento de itens do `logFoodToMeal` (linhas 1026-1034) por `items: multipliedItems.map(labelItemToLogItem),` e o do `awaiting_meal_type` (linhas 1005-1013) por `items: multipliedItems.map(labelItemToLogItem) as unknown as Record<string, unknown>,`. Incluir `labelItemToLogItem` no import da linha 40.

NOTA: se o Step 1 revelar que `logFoodToMeal` exige `number` (não-nullable) em `proteinG`, então `LabelLogItem` usa `number` e o corpo mantém `?? 0`; o teste do Step 2 passa a esperar `0` em `carbsG`/`fatG` e adiciona-se comentário `// TODO(WS5): propagar null até a soma para distinguir desconhecido de 0g`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/bot/nutrition-label.test.ts tests/unit/bot/handler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/nutrition-label.ts src/lib/bot/handler.ts tests/unit/bot/nutrition-label.test.ts
git commit -m "fix(handler): preservar macro de rótulo desconhecido como null em vez de 0"
```

---

## Verificação final

- [ ] Rodar a suíte de unidade dos domínios tocados:
  - `npx vitest run tests/unit/bot/nutrition-label.test.ts`
  - `npx vitest run tests/unit/bot/label-portions.test.ts`
  - `npx vitest run tests/unit/bot/handler.test.ts`
- [ ] Rodar a suíte completa: `npm test`
- [ ] Lint: `npm run lint`
- [ ] Conferir que os casos-âncora passam: rótulo 120kcal/100g com porção 60g e comi 50g → registro proporcional (50/60 da porção escalada), e o caso de overscale (omissão de base ou >9 kcal/g) vira pedido de esclarecimento em vez de número inflado.