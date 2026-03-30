# Spec: Migração USDA → Open Food Facts

**Data:** 2026-03-30
**Status:** Aprovado

---

## Contexto

O CalorieBot usa um pipeline de enriquecimento nutricional para calcular calorias de itens não encontrados na tabela TACO local. Atualmente o segundo passo do pipeline chama a API do USDA FoodData Central, que exige:

1. Uma API key (`USDA_API_KEY`) — que já causou falha em produção por problema de newline na env var
2. Uma chamada LLM de tradução PT→EN antes de cada busca — custo extra de tokens
3. Um banco de dados americano com cobertura ruim para alimentos brasileiros

A substituição pelo Open Food Facts (OFF) elimina esses problemas.

---

## Pipeline atual vs. novo

**Atual:**
```
TACO (local) → USDA (tradução LLM + API key) → LLM estimate
```

**Novo:**
```
TACO (local) → Open Food Facts (busca em PT direto, sem auth) → LLM estimate
```

---

## Arquivos afetados

| Ação | Arquivo |
|---|---|
| Substituído | `src/lib/usda/client.ts` → `src/lib/off/client.ts` |
| Atualizado | `src/lib/bot/flows/meal-log.ts` (import + referências) |
| Migrado | `tests/unit/usda/client.test.ts` → `tests/unit/off/client.test.ts` |
| Atualizado | `tests/unit/bot/meal-log.test.ts` (mocks) |
| Removida | Env var `USDA_API_KEY` (não é mais necessária) |

---

## Interface pública

```typescript
// src/lib/off/client.ts

export interface OFFResult {
  food: string        // nome original em PT-BR passado pelo caller
  offFoodName: string // nome retornado pelo OFF
  offId: string       // barcode ou ID do produto no OFF
  calories: number    // kcal escaladas para quantityGrams
  protein: number     // gramas escaladas
  carbs: number       // gramas escaladas
  fat: number         // gramas escaladas
}

export async function searchOFFFood(
  foodNamePtBr: string,
  quantityGrams: number,
): Promise<OFFResult | null>
```

O contrato externo é idêntico ao atual `searchUSDAFood` — apenas nomes mudam.

---

## Lógica de busca

### Endpoint

```
GET https://world.openfoodfacts.org/cgi/search.pl
  ?search_terms={foodName}
  &search_simple=1
  &action=process
  &json=1
  &fields=product_name,nutriments,completeness,id
  &page_size=5
  &cc=br
  &lc=pt
```

O parâmetro `cc=br` prioriza produtos cadastrados no Brasil. O `lc=pt` prioriza nomes em português.

### Seleção do resultado

Iterar pelos resultados e retornar o primeiro que satisfaça **todos** os critérios:
- `completeness >= 0.5`
- `nutriments.energy-kcal_100g` presente e > 0
- `nutriments.proteins_100g` presente
- `nutriments.carbohydrates_100g` presente
- `nutriments.fat_100g` presente

Se nenhum resultado válido, retornar `null` (pipeline cai para LLM estimate).

### Scaling

Todos os valores do OFF são por 100g. Aplicar o mesmo padrão atual:

```typescript
const scale = quantityGrams / 100
calories = Math.round(energy_kcal_100g * scale)
protein  = Math.round(proteins_100g * scale * 10) / 10
carbs    = Math.round(carbohydrates_100g * scale * 10) / 10
fat      = Math.round(fat_100g * scale * 10) / 10
```

### Timeout e headers

- Timeout: 5000ms (igual ao atual)
- Header obrigatório: `User-Agent: CalorieBot/1.0 (contato@caloriebot.app)` — exigido pelo OFF para não ser bloqueado

---

## O que é removido

- `translateFoodName()` — função eliminada completamente
- `NUTRIENT_IDS` — constantes do USDA, não se aplicam ao OFF
- `USDA_API_KEY` — remover das env vars e do `.env.example`
- Diretório `src/lib/usda/` — pode ser deletado após migração

---

## Tratamento de erros

- HTTP não-2xx → retornar `null` silenciosamente
- Timeout → retornar `null` silenciosamente
- JSON malformado → retornar `null` silenciosamente
- Nenhum resultado com macros completos → retornar `null`

Comportamento idêntico ao atual — o pipeline de meal-log já trata `null` corretamente.

---

## Testes

### `tests/unit/off/client.test.ts`

Cobrir com mocks MSW ou fetch mock:
1. Resultado válido com todos os macros → retorna `OFFResult` corretamente escalado
2. Resultado sem `fat_100g` → ignora e tenta próximo; se nenhum válido, retorna `null`
3. `completeness < 0.5` → ignora resultado
4. Lista vazia → retorna `null`
5. HTTP 503 → retorna `null`
6. Timeout → retorna `null`

### `tests/unit/bot/meal-log.test.ts`

Substituir mock de `searchUSDAFood` por `searchOFFFood`. Comportamento dos testes permanece idêntico.

---

## Impacto em produção

- Remover `USDA_API_KEY` do Vercel env vars após deploy
- Sem downtime — mudança transparente para o usuário
- Economia imediata de ~1 chamada LLM por item não encontrado no TACO
