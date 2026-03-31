# Meal Flow Redesign — Smart Portions, TACO Turbinado e Correção Real

**Data:** 2026-03-31
**Status:** Draft
**Contexto:** Usuários reais reportaram estimativas absurdas (leite semi desnatado com 37.8g de gordura), itens fantasma aparecendo na re-análise, e impossibilidade de corrigir porções — só apagar. Este redesign ataca os 3 problemas: estimativa de porções, match nutricional, e fluxo de correção.

**Specs relacionadas:**
- `2026-03-29-taco-matching-redesign.md` — food_base/food_variant, is_default (integrar)
- `2026-03-30-usda-fallback-design.md` — USDA entre TACO e decomposição (integrar)

---

## 1. Problema

### 1.1 Estimativas de porção sem base

O bot registra "arroz" sem saber a quantidade. A LLM chuta um valor (ex: 150g) que pode estar completamente errado. O usuário não tem como saber o que foi assumido.

### 1.2 Match TACO falha para nomes comuns

"Leite semi desnatado" existe na TACO mas o match por nome falha por diferenças de formatação ("semi desnatado" vs "semidesnatado"). Quando falha, a LLM inventa macros absurdos (37.8g de gordura para leite).

### 1.3 Correção é só "apagar"

O fluxo de edição atual (`edit.ts`) só permite deletar refeições inteiras. Não existe forma de corrigir a quantidade de um item específico.

---

## 2. Classificação de Porções

### 2.1 Categorias

Cada alimento identificado pela LLM recebe uma classificação:

| Categoria | Descrição | Exemplos | Ação |
|-----------|-----------|----------|------|
| `unit` | Unidade natural com peso médio conhecido | banana, ovo, pão francês, coxinha, pão de queijo | Registra direto |
| `bulk` | A granel, quantidade variável | arroz, feijão, leite, macarrão, carne, azeite | Pergunta quantidade se não informada |
| `packaged` | Produto industrializado/marca | Magic Toast, Yakult, Danone, whey | Pergunta quantidade se não informada |

### 2.2 Prompt atualizado

A LLM recebe instrução adicional no prompt de análise para retornar `portion_type` por item:

```json
{
  "items": [
    {
      "food": "Banana",
      "portion_type": "unit",
      "quantity_grams": 120,
      "quantity_display": "1 unidade",
      "has_user_quantity": false
    },
    {
      "food": "Arroz branco",
      "portion_type": "bulk",
      "quantity_grams": null,
      "quantity_display": null,
      "has_user_quantity": false
    }
  ]
}
```

**Regras para a LLM:**
- Se o usuário informou quantidade explícita (ex: "200ml de leite"), `has_user_quantity: true` e preenche `quantity_grams` + `quantity_display`
- Se `portion_type: "unit"` e sem quantidade explícita, usa peso médio da tabela de porções
- Se `portion_type: "bulk"` ou `"packaged"` e sem quantidade explícita, `quantity_grams: null`

### 2.3 Cache de classificação

Expandir a tabela `food_cache` para armazenar a classificação:

```sql
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS portion_type TEXT; -- 'unit' | 'bulk' | 'packaged'
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS default_grams NUMERIC; -- peso médio (unit) ou porção padrão
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS default_display TEXT; -- "1 unidade", "1 fatia", etc.
```

**Fluxo com cache:**
1. Primeira vez: LLM classifica → salva no `food_cache`
2. Próximas vezes: `food_cache` hit → pula LLM para classificação

---

## 3. Match TACO Turbinado

Integra e expande o design de `2026-03-29-taco-matching-redesign.md`.

### 3.1 Normalização de nomes

Função `normalizeFoodName(name: string): string` que aplica:

1. Lowercase
2. Remover acentos (`café` → `cafe`)
3. Normalizar espaços múltiplos
4. Aplicar sinônimos comuns

### 3.2 Tabela de sinônimos

Mapeamento hardcoded (sem LLM, sem custo):

```typescript
const SYNONYMS: Record<string, string> = {
  'semi desnatado': 'semidesnatado',
  'semi-desnatado': 'semidesnatado',
  'peito de frango': 'frango, peito',
  'batata frita': 'batata, frita',
  'queijo minas': 'queijo, minas',
  'ovo cozido': 'ovo, de galinha, inteiro, cozido',
  'ovo frito': 'ovo, de galinha, inteiro, frito',
  'pao frances': 'pao, trigo, frances',
  'pao de forma': 'pao, de forma, tradicional',
  'arroz branco': 'arroz, tipo 1, cozido',
  'feijao preto': 'feijao, preto, cozido',
  'feijao carioca': 'feijao, carioca, cozido',
  'leite integral': 'leite, de vaca, integral',
  'leite desnatado': 'leite, de vaca, desnatado',
  'leite semidesnatado': 'leite, de vaca, semidesnatado',
};
```

### 3.3 Busca por tokens

Quando a busca normalizada falha, quebrar em tokens e buscar por intersecção:

```
Input: ["leite", "semidesnatado"]
TACO:  ["leite", "de", "vaca", "semidesnatado"]
Score: tokens_encontrados / tokens_input = 2/2 = 1.0 → match forte
```

Threshold mínimo: 0.6 (pelo menos 60% dos tokens do input encontrados).

### 3.4 Cascata de enriquecimento atualizada

```
1. food_cache hit → usa direto (portion_type + taco_id + macros)
2. TACO food_base match (já implementado no redesign)
3. TACO nome normalizado + sinônimos
4. TACO busca por tokens
5. TACO fuzzy (pg_trgm, já existe)
6. USDA FoodData Central (spec 2026-03-30)
7. LLM decomposição (só para pratos compostos: yakisoba, feijoada, etc.)
8. LLM estimativa direta → marca confiança BAIXA
```

Passos 1-5 usam dados verificados. Passo 6 usa USDA verificado. Passos 7-8 são fallback com sinalização.

---

## 4. Fluxo de Registro (novo pipeline)

### 4.1 Diagrama

```
Mensagem do usuário
        ↓
1. IDENTIFICAÇÃO (LLM)
   - Identifica alimentos + portion_type + has_user_quantity
   - Cache check: food_cache hit para alimentos conhecidos
        ↓
2. TRIAGEM
   - Items resolvidos (unit OU has_user_quantity): → passo 4
   - Items sem quantidade (bulk/packaged): → passo 3
        ↓
3. PERGUNTA
   Se há items resolvidos, registra-os imediatamente.
   Pergunta os que faltam em uma mensagem:

   Se tem resolvidos + pendentes:
   "🍌 Banana registrada! Pra completar:
    • Arroz — quanto? (ex: 2 colheres, 1 escumadeira)
    • Leite — quanto? (ex: 200ml, 1 copo)"

   Se TODOS são pendentes (nenhum resolvido):
   "Pra registrar, me diz as quantidades:
    • Arroz — quanto? (ex: 2 colheres, 1 escumadeira)
    • Leite — quanto? (ex: 200ml, 1 copo)"

   Estado: awaiting_bulk_quantities
   Dados pendentes salvos em conversation_context

   Usuário responde → parse resposta → volta pro passo 4
        ↓
4. ENRIQUECIMENTO (cascata §3.4)
   Para cada item, buscar macros na cascata.
   Salvar no food_cache se for primeira vez.
        ↓
5. REGISTRO + RECIBO
   Salvar no banco (meals + meal_items).
   Mostrar recibo com porções assumidas (§4.2).
   Items com confiança baixa ficam sinalizados com ⚠️.
```

### 4.2 Formato do recibo

**Padrão (tudo com confiança alta):**
```
🍽️ Almoço registrado!

• Arroz (1 escumadeira) — 117 kcal
• Feijão (1 concha) — 58 kcal
• Frango grelhado (1 filé) — 195 kcal

Total: 370 kcal
📊 Hoje: 890 / 1760 kcal (restam 870)

Algo errado? Manda "corrigir"
```

**Com estimativa (confiança baixa):**
```
🍽️ Lanche registrado!

• Açaí com granola (300ml) — ~480 kcal ⚠️

Total: 480 kcal
📊 Hoje: 1370 / 1760 kcal (restam 390)

⚠️ Não achei "açaí com granola" na tabela nutricional, estimei o valor.
Se souber as calorias exatas, manda "corrigir"
```

**Mudanças em relação ao recibo atual:**
- Mostra porção legível entre parênteses (não gramas brutas)
- Não mostra macros detalhados (fica no dashboard web / resumo)
- CTA de correção sempre presente
- Sinaliza estimativas com ⚠️

### 4.3 Estado `awaiting_bulk_quantities`

Novo estado em `conversation_context`:

```typescript
type AwaitingBulkQuantities = {
  type: 'awaiting_bulk_quantities';
  pending_items: Array<{
    food: string;
    portion_type: 'bulk' | 'packaged';
    examples: string; // "ex: 200ml, 1 copo"
  }>;
  resolved_items: Array<MealItem>; // items já registrados (unit)
  meal_type: string;
};
```

Quando o usuário responde, a LLM parseia a resposta e preenche as quantidades. Se ainda faltar algo, pergunta de novo. TTL: 10 minutos.

---

## 5. Fluxo de Correção

### 5.1 Ativação

Duas formas de ativar:

1. **Comando "corrigir"** — entra no fluxo guiado por números
2. **Linguagem natural** — "o arroz era 2 escumadeiras", "tira o queijo", "faltou o suco"

O classificador de intenção (`router.ts`) já categoriza como `edit`. A LLM precisa extrair informação adicional: qual alimento, qual refeição, qual correção.

### 5.2 Fluxo guiado (comando "corrigir")

```
Usuário: "corrigir"

Bot: "Qual refeição quer corrigir?
 1️⃣ Café da manhã — 520 kcal (3 itens)
 2️⃣ Almoço — 890 kcal (5 itens)"

Usuário: "1"

Bot: "Café da manhã:
 1️⃣ Arroz (1 escumadeira, 90g) — 117 kcal
 2️⃣ Feijão (1 concha, 80g) — 58 kcal
 3️⃣ Frango (1 filé, 120g) — 195 kcal

Qual item? (número ou descreve a correção)"

Usuário: "1"

Bot: "Arroz — qual a quantidade certa? (ex: 2 escumadeiras, 200g)"

Usuário: "2 escumadeiras"

Bot: "✅ Arroz atualizado: 90g → 180g (117 → 234 kcal)
📊 Hoje: 637 / 1760 kcal"
```

**Estados:**
- `awaiting_correction` — aguardando seleção de refeição
- `awaiting_correction_item` — aguardando seleção de item (novo)
- `awaiting_correction_value` — aguardando novo valor (novo)

### 5.3 Fluxo por linguagem natural

```
Usuário: "o arroz do almoço era 2 escumadeiras"
                    ↓
Intent: edit
LLM extrai: { food: "arroz", meal: "almoço", new_quantity: "2 escumadeiras" }
                    ↓
Busca: meals de hoje → tipo "lunch" → item com food contendo "arroz"
                    ↓
Recalcula macros com nova quantidade (cascata §3.4)
                    ↓
Atualiza meal_items no banco
                    ↓
Mostra: "✅ Arroz atualizado: 90g → 180g (117 → 234 kcal)"
```

### 5.4 Ações de correção suportadas

| Ação | Exemplo | Comportamento |
|------|---------|---------------|
| Mudar quantidade | "era 200ml, não 100ml" | Recalcula macros proporcionalmente |
| Remover item | "tira o queijo" | Remove meal_item, recalcula total |
| Adicionar item | "faltou o suco" | Adiciona meal_item, recalcula total |
| Trocar alimento | "era queijo cottage, não minas" | Remove item antigo, adiciona novo |
| Apagar refeição | "apaga o almoço" | Remove meal + meal_items (já existe) |

### 5.5 Schema da LLM para extração de correção

```json
{
  "action": "update_quantity" | "remove_item" | "add_item" | "replace_item" | "delete_meal",
  "target_meal_type": "breakfast" | "lunch" | "snack" | "dinner" | null,
  "target_food": "arroz",
  "new_quantity": "2 escumadeiras",
  "new_food": null,
  "confidence": "high" | "medium" | "low"
}
```

Se `confidence: "low"`, o bot confirma antes de aplicar: "Quer atualizar o arroz do almoço pra 2 escumadeiras?"

---

## 6. Alterações no Banco de Dados

### 6.1 food_cache (expandir)

```sql
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS portion_type TEXT;
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS default_grams NUMERIC;
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS default_display TEXT;
```

### 6.2 meal_items (adicionar campo de confiança)

```sql
ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT 'high';
ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS quantity_display TEXT;
```

- `confidence`: 'high' (TACO/USDA), 'medium' (fuzzy match), 'low' (LLM estimate)
- `quantity_display`: "1 escumadeira", "200ml", "1 unidade" — como mostrar pro usuário

### 6.3 conversation_context (novos estados)

Novos valores para `context_type`:
- `awaiting_bulk_quantities` — aguardando quantidades de alimentos a granel
- `awaiting_correction_item` — aguardando seleção de item para corrigir
- `awaiting_correction_value` — aguardando novo valor de correção

---

## 7. Arquivos Impactados

| Arquivo | Mudança |
|---------|---------|
| `src/lib/llm/prompts/analyze.ts` | Adicionar `portion_type`, `has_user_quantity` no prompt e formato de resposta |
| `src/lib/llm/schemas/meal-analysis.ts` | Adicionar campos no schema Zod |
| `src/lib/bot/flows/meal-log.ts` | Novo pipeline: triagem → pergunta → enriquecimento → registro |
| `src/lib/bot/flows/edit.ts` | Reescrever: suportar correção real (não só apagar) |
| `src/lib/bot/handler.ts` | Tratar novos estados (awaiting_bulk_quantities, awaiting_correction_*) |
| `src/lib/bot/state.ts` | Novos tipos de estado |
| `src/lib/db/queries/meals.ts` | Funções para update de meal_items individuais |
| `src/lib/db/queries/food-cache.ts` | Expandir para salvar/buscar portion_type |
| `src/lib/llm/prompts/correction.ts` | **Novo:** prompt para extrair intenção de correção |
| `src/lib/llm/schemas/correction.ts` | **Novo:** schema Zod para resposta de correção |
| `src/lib/utils/food-normalize.ts` | **Novo:** normalização de nomes + sinônimos |
| `src/lib/utils/token-match.ts` | **Novo:** busca por tokens para TACO |
| `supabase/migrations/` | Migration para ALTER TABLE food_cache e meal_items |

---

## 8. Fora de Escopo

- Fluxo de imagem (foto de comida) — mantém comportamento atual
- Fluxo de tabela nutricional — mantém comportamento atual
- Bug de registro duplicado — provavelmente usuário ansioso, monitorar
- Onboarding, resumo, peso, settings — sem mudanças
- Dashboard web — sem mudanças nesta spec
