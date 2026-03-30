# TACO Matching Redesign — Spec

**Data:** 2026-03-29
**Status:** Draft
**Contexto:** O fuzzy matching atual (pg_trgm) falha para alimentos genéricos ("banana", "ovo", "café") e gera falsos positivos ("chocolate" → "Caqui, chocolate"). Redesenhar o pipeline de matching e a estrutura de dados da TACO.

---

## 1. Problema

O matching atual usa apenas similaridade de trigramas (`pg_trgm`). Problemas identificados:

- **Palavras curtas** ("ovo", "pão", "café") ficam abaixo do threshold 0.4
- **Falsos positivos** ("chocolate" matcha "Caqui, chocolate, cru" por ter a substring)
- **Alimentos genéricos** ("banana") não matcham porque o TACO tem "Banana, prata, crua", "Banana, nanica, crua", etc.
- **Sem default inteligente** — quando tem múltiplas variantes, não sabe qual escolher

---

## 2. Solução

### 2.1 Separar nome em `food_base` + `food_variant`

Dividir o nome do alimento na primeira vírgula:

| Nome original | food_base | food_variant |
|---|---|---|
| Banana, prata, crua | Banana | prata, crua |
| Arroz, tipo 1, cozido | Arroz | tipo 1, cozido |
| Caqui, chocolate, cru | Caqui | chocolate, cru |
| Açaí | Açaí | *(vazio)* |

**Onde:** Campos `food_base` e `food_variant` no JSON (`taco_foods_extracted.json`) e colunas na tabela `taco_foods`.

### 2.2 Flag `is_default`

Coluna `is_default BOOLEAN DEFAULT FALSE` na tabela `taco_foods`. Apenas um alimento por `food_base` pode ter `is_default = true`.

**Defaults manuais iniciais (~28 alimentos):**

| food_base | Default (food_variant) | ID |
|---|---|---|
| Arroz | tipo 1, cozido | 3 |
| Feijão | carioca, cozido | 561 |
| Banana | prata, crua | 182 |
| Ovo | de galinha, inteiro, cozido/10minutos | 488 |
| Pão | trigo, francês | 53 |
| Leite | de vaca, integral | 458 |
| Café | infusão 10% | 448* |
| Frango | peito, sem pele, grelhado | 410 |
| Carne | bovina, patinho, sem gordura, grelhado | 377 |
| Queijo | mozarela | 463 |
| Chocolate | ao leite | 495 |
| Batata | inglesa, cozida | 91 |
| Iogurte | natural | 448 |
| Macarrão | trigo, cru | 40 |
| Bolo | pronto, chocolate | 16 |
| Laranja | pêra, crua | 214 |
| Mandioca | cozida | 129 |
| Lingüiça | porco, grelhada | 423 |
| Porco | lombo, assado | 432 |
| Óleo | de soja | 272 |
| Tomate | com semente, cru | 157 |
| Alface | crespa, crua | 78 |
| Biscoito | salgado, cream cracker | 13 |
| Margarina | com óleo hidrogenado, com sal (65% de lipídeos) | 263 |
| Refrigerante | tipo cola | 480 |
| Goiaba | vermelha, com casca, crua | 200 |
| Manga | Tommy Atkins, crua | 231 |
| Farinha | de trigo | 35 |

*Nota: IDs serão confirmados no momento da implementação contra os dados reais.*

### 2.3 Tabela `taco_food_usage` — defaults aprendidos

```sql
CREATE TABLE taco_food_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_base VARCHAR(200) NOT NULL,
    taco_id INTEGER REFERENCES taco_foods(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    confirmed_count INTEGER DEFAULT 1,
    last_confirmed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(food_base, taco_id, user_id)
);
```

**Lógica de default aprendido:**
- Cada vez que um usuário confirma uma refeição com match por default, registra em `taco_food_usage`
- Para determinar o default aprendido de uma `food_base`:
  - Conta quantos **usuários distintos** confirmaram cada `taco_id` para aquela base
  - O `taco_id` com mais usuários distintos vira o default aprendido
  - Default aprendido tem prioridade sobre o default manual (`is_default`)
- Exemplo: se 6 de 10 usuários confirmaram "banana, nanica", ela supera "banana, prata" como default

### 2.4 Novo pipeline de matching

```
Mensagem do usuário → LLM extrai itens
         ↓
    Para cada item:
         ↓
    ┌─ 1. Match exato (nome completo, fuzzy threshold 0.4)
    │     → match → usa TACO ✓
    │
    ├─ 2. Match por base (ILIKE no food_base)
    │     → múltiplos resultados:
    │        → usuário especificou tipo? fuzzy match no food_variant
    │        → não especificou? usa default (aprendido > manual > primeiro resultado)
    │        → avisa o usuário qual default foi usado
    │     → match → usa TACO ✓
    │
    ├─ 3. Decomposição (só pratos compostos)
    │     → LLM decompõe em ingredientes
    │     → cada ingrediente passa pelos passos 1-2
    │     → source: 'taco_decomposed'
    │
    └─ 4. LLM estima direto (último recurso)
         → source: 'approximate'
```

### 2.5 Mensagem transparente ao usuário

Quando um match usa o default (passo 2, sem tipo especificado), a mensagem de confirmação inclui aviso:

```
🍌 Banana (prata, crua) — 120g
89 kcal | P: 1.3g | C: 22.8g | G: 0.1g

ℹ️ Usei banana prata como padrão. Se for outro tipo, me diz qual!

Confirma? (sim/não)
```

O aviso **não aparece** quando:
- Match foi exato (nome completo)
- Usuário especificou o tipo ("banana nanica")
- Base tem variante única (não há ambiguidade)

---

## 3. Mudanças no banco de dados

### 3.1 Alterações na tabela `taco_foods`

```sql
ALTER TABLE taco_foods ADD COLUMN food_base VARCHAR(200);
ALTER TABLE taco_foods ADD COLUMN food_variant VARCHAR(200);
ALTER TABLE taco_foods ADD COLUMN is_default BOOLEAN DEFAULT FALSE;

-- Índice para busca por base
CREATE INDEX idx_taco_foods_food_base ON taco_foods (lower(food_base));

-- Constraint: máximo 1 default por food_base
CREATE UNIQUE INDEX idx_taco_foods_default_per_base
  ON taco_foods (food_base) WHERE is_default = TRUE;
```

### 3.2 Nova tabela `taco_food_usage`

Conforme descrito na seção 2.3.

### 3.3 Novas RPC functions

- `match_taco_by_base(query_base TEXT)` — retorna todos os alimentos com `food_base` ILIKE query, ordenados por `is_default DESC, food_name ASC`
- Atualizar `match_taco_food` e `match_taco_foods_batch` para também retornar `food_base`, `food_variant`, `is_default`
- `get_learned_default(query_base TEXT)` — retorna o `taco_id` com mais usuários distintos para aquela base
- `record_taco_usage(p_food_base TEXT, p_taco_id INT, p_user_id UUID)` — insere/incrementa em `taco_food_usage`

---

## 4. Mudanças no código

### 4.1 JSON e seed

- **`scripts/convert-taco-xlsx.py`**: adicionar campos `food_base` e `food_variant` no JSON de saída
- **`docs/taco_foods_extracted.json`**: regenerar com novos campos
- **`scripts/seed-taco.ts`**: mapear `food_base`, `food_variant`, `is_default` no upsert

### 4.2 Queries (`src/lib/db/queries/taco.ts`)

- Atualizar interface `TacoFood` com `foodBase`, `foodVariant`, `isDefault`
- Nova função `matchTacoByBase(supabase, foodBase)` — chama RPC `match_taco_by_base`
- Nova função `getLearnedDefault(supabase, foodBase)` — chama RPC `get_learned_default`
- Nova função `recordTacoUsage(supabase, foodBase, tacoId, userId)` — chama RPC `record_taco_usage`

### 4.3 Pipeline de matching (`src/lib/bot/flows/meal-log.ts`)

- Refatorar `enrichItemsWithTaco()` com o novo pipeline de 4 passos
- Adicionar flag `usedDefault` no `EnrichedItem` para controlar a mensagem de aviso
- Chamar `recordTacoUsage()` quando o usuário confirma a refeição

### 4.4 Formatação (`src/lib/utils/formatters.ts`)

- Atualizar formatação de confirmação para incluir aviso de default quando aplicável

---

## 5. O que NÃO muda

- Modos de cálculo (`taco`, `manual`) — sem alteração
- Schema de `meals` e `meal_items` — sem alteração
- Fluxo de confirmação/rejeição — mesmo comportamento, só adiciona aviso
- RPC functions existentes — atualizadas mas compatíveis com código atual
- Threshold de 0.4 para fuzzy matching — mantido no passo 1
