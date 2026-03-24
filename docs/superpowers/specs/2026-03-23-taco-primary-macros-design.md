# Design: TACO como Fonte Primaria de Macronutrientes

**Data:** 2026-03-23
**Status:** Aprovado

## Principio Central

A Tabela TACO (581 alimentos, 4a edicao completa) e a fonte de verdade para macronutrientes. A LLM identifica alimentos e estima porcoes. O backend faz o lookup dos macros na TACO.

## Fluxo Principal

```
Mensagem -> LLM (identifica alimentos + gramas) -> Fuzzy match TACO
  -> Match: usa macros TACO (proporcional aos gramas)
  -> Sem match: decomposicao em ingredientes (com feedback ao usuario)
    -> Match TACO por ingrediente -> soma macros
    -> Decomposicao falha: estimativa LLM marcada como "approximate"
```

### Detalhamento

1. Usuario manda mensagem descrevendo refeicao
2. LLM analisa e retorna JSON com alimentos identificados e gramas estimadas (nao calcula macros)
3. Para cada item, backend faz fuzzy match na tabela `taco_foods` usando `pg_trgm` + `similarity()`
4. Se match com confianca alta (similarity >= 0.4, ajustavel): substitui macros pelos valores da TACO, proporcionais aos gramas
5. Se sem match: aciona fluxo de decomposicao (Secao 2)
6. Cada `meal_item` salvo indica a origem via campo `source`

## Decomposicao de Alimentos Compostos

Quando o fuzzy match nao encontra o alimento na TACO (ex: "coxinha", "Big Mac", "yakisoba"):

1. Backend detecta que nao houve match TACO para o item
2. Bot envia feedback intermediario ao usuario:
   > "Nao encontrei 'coxinha' na Tabela TACO. Vou decompor nos ingredientes para calcular os macros certinho, um momento... 🔍"
3. Faz segunda chamada a LLM pedindo decomposicao em ingredientes basicos com gramas
4. Para cada ingrediente retornado, faz fuzzy match na TACO
5. Soma os macros dos ingredientes encontrados
6. Se algum ingrediente ainda nao tiver match TACO, usa estimativa da LLM so para aquele ingrediente

### Exemplo

- Usuario: "comi uma coxinha"
- LLM inicial: `{food: "Coxinha", quantity_grams: 120}`
- Sem match TACO -> feedback ao usuario -> chama decomposicao
- LLM retorna: `[{food: "Farinha de trigo", g: 40}, {food: "Frango", g: 50}, {food: "Oleo", g: 15}, {food: "Batata", g: 15}]`
- Backend busca cada um na TACO -> calcula macros proporcionais -> soma
- `meal_item` salvo com `source: 'taco_decomposed'`

### Regras de feedback

- Mensagem intermediaria so aparece quando decomposicao e acionada
- Se mensagem do usuario tem multiplos itens e so um precisa de decomposicao, feedback menciona apenas aquele item
- Custo: uma chamada extra a LLM so quando necessario

## Excecoes Temporarias

Dois cenarios onde os macros nao vem da TACO. Sao one-off — o registro seguinte volta ao padrao TACO.

### Tabela nutricional (foto/texto)

- Usuario manda foto de rotulo ou tabela nutricional
- LLM extrai os dados da imagem (fluxo existente com `analyzeImage`)
- Macros da imagem usados somente naquele registro
- `source: 'manual'` no `meal_item`

### Macros explicitos do usuario

- Ex: "registra 200g de frango com 180kcal e 35g de proteina"
- Quando o usuario fornece valores explicitos, respeita os valores dele
- `source: 'user_provided'` no `meal_item`
- LLM detecta via `quantity_source: 'user_provided'` — expandir para detectar macros explicitos tambem

## Reutilizacao de Dados do Historico

Quando o usuario referencia um registro anterior (ex: "usa os macros daquela pizza", "igual aquele acai de ontem"):

### Fluxo

1. LLM detecta referencia a item anterior via campo `references_previous: true` e `reference_query: string`
2. Backend busca nos `meal_items` do usuario por nome do alimento (fuzzy match)
3. Se nao encontrar por item, busca na `original_message` da tabela `meals`
4. Se multiplos resultados, mostra os mais recentes (ate 3) para o usuario escolher:
   > "Encontrei esses registros de pizza:\n1. Pizza calabresa — 350kcal (2 fatias, 12/03)\n2. Pizza margherita — 280kcal (1 fatia, 08/03)\nQual deles?"
5. Usuario confirma -> registra com os mesmos macros, ajustando proporcionalmente se quantidade mudar
6. `source: 'user_history'` no `meal_item`

### Deteccao de referencia

- Campo `references_previous: boolean` no schema de resposta da LLM
- Campo `reference_query: string` com o termo de busca
- Evita regex fragil — LLM e melhor para entender intencao

## Mudancas no Banco de Dados

### `taco_foods` — atualizar seed

- Substituir os ~100 alimentos atuais pelos 581 extraidos do PDF (TACO 4a edicao)
- Manter colunas existentes: `food_name`, `category`, `calories_per_100g`, `protein_per_100g`, `carbs_per_100g`, `fat_per_100g`, `fiber_per_100g`, `sodium_per_100g`

### Extensao `pg_trgm` para fuzzy matching

- Habilitar extensao `pg_trgm` via migration
- Criar indice GIN na coluna `food_name` para performance
- Usar operador `%` com `ORDER BY similarity() DESC LIMIT 1` para melhor uso do indice GIN
- Threshold inicial de 0.4 (ajustavel via constante), tunar com dados reais

### `meal_items` — expandir `source` enum

- Atual: `approximate`, `taco`, `manual`
- Novo: `taco`, `taco_decomposed`, `approximate`, `manual`, `user_provided`, `user_history`
- Manter `approximate` como valor valido no CHECK constraint (usado como fallback quando TACO e decomposicao falham)
- Dados existentes com `source = 'approximate'` permanecem inalterados

### `calorie_mode` — simplificar

- Manter campo com 2 valores: `taco` (padrao) e `manual`
- Remover opcao `approximate`
- Migrar usuarios existentes com `approximate` para `taco`

## Mudancas nos Prompts da LLM

### Prompt de analise de refeicao

- Unificar `approximate.ts` e `taco.ts` em um unico prompt
- Simplificar: LLM nao precisa mais calcular macros
- Foco: identificar alimentos, estimar gramas, classificar refeicao, detectar referencias ao historico
- Remover instrucoes sobre TACO no prompt (backend cuida disso)
- Prompt menor = resposta mais rapida e mais barata

### Schema `MealItemSchema` — ajustar

- Manter: `food`, `quantity_grams`, `quantity_source`, `confidence`
- `calories`, `protein`, `carbs`, `fat` tornam-se opcionais (backend calcula via TACO)
- Adicionar: `references_previous: boolean`, `reference_query: string`

### Novo prompt de decomposicao

- Prompt dedicado para decompor alimentos compostos em ingredientes basicos
- Input: nome do alimento + gramas totais
- Output: lista de ingredientes com gramas estimadas
- Usado somente quando fuzzy match TACO falha

### `food_cache` — redefinir papel

- `food_cache` passa a armazenar resultados de decomposicao (alimento composto -> ingredientes TACO)
- Evita chamadas repetidas a LLM para mesmos alimentos compostos (ex: "coxinha" ja decomposta uma vez)
- Itens com match direto na TACO nao precisam de cache (TACO ja e o cache)

### Novo estado de conversa

- Adicionar `awaiting_history_selection` ao `conversation_context` para quando o usuario precisa escolher entre multiplos registros anteriores
- Atualizar `src/lib/db/queries/context.ts`: adicionar ao tipo `ContextType` e ao `CONTEXT_TTLS` (TTL: 5 minutos, mesmo de `awaiting_confirmation`)

## Mudancas no Codigo

### `src/lib/db/queries/taco.ts` (novo arquivo)

- Criar modulo de queries TACO no DB layer
- Mover/re-exportar tipo `TacoFood` de `src/lib/llm/prompts/taco.ts` para ca
- Nova funcao `fuzzyMatchTaco(foodName: string): Promise<TacoFood | null>` usando `pg_trgm`
- Nova funcao `fuzzyMatchTacoMultiple(foodNames: string[]): Promise<Map<string, TacoFood | null>>` para batch

### `src/lib/bot/flows/meal-log.ts`

- Ajustar orquestracao: LLM -> TACO lookup -> decomposicao se necessario -> feedback -> confirmacao
- Adicionar logica de feedback intermediario quando decomposicao e necessaria
- Adicionar logica de busca no historico quando `references_previous: true`

### `src/lib/bot/flows/query.ts`

- Atualizar para usar pipeline TACO (hoje hardcoda `approximate`)
- Consultas avulsas tambem devem retornar macros da TACO

### `src/lib/llm/prompts/`

- Unificar `approximate.ts` e `taco.ts` em um unico prompt (`analyze.ts`), deletar os dois arquivos antigos
- Novo `decompose.ts` para prompt de decomposicao
- `vision.ts` e `manual.ts` permanecem inalterados

### `src/lib/llm/schemas/`

- Novo `decomposition.ts` com schema Zod: `DecomposedItemSchema = z.object({ food: z.string(), quantity_grams: z.number() })`
- `DecompositionResultSchema = z.object({ ingredients: z.array(DecomposedItemSchema) })`

### `src/lib/llm/provider.ts` e providers

- Novo metodo `decomposeMeal(foodName: string, grams: number): Promise<DecomposedItem[]>`
- Ajustar `analyzeMeal`: remover parametros `context?: TacoFood[]` e `mode`, manter `history?: ChatMessage[]`. Macros opcionais na resposta
- `analyzeImage`: remover parametro `mode` (sempre opera como excecao manual), remover `context` (nao usa TACO)
- Atualizar fallback proxy em `src/lib/llm/index.ts` para incluir `decomposeMeal`

### Arquivos afetados pela remocao de `approximate` como calorie_mode

- `src/lib/llm/schemas/common.ts` — `CalorieModeSchema`: remover `approximate`, manter `taco` e `manual`
- `src/lib/utils/validators.ts` — `validateCalorieMode()`: ajustar opcoes
- `src/lib/bot/flows/settings.ts` — `MODE_LABELS`, `buildCalorieModeSubMenu`, `applyCalorieModeChange`: remover approximate
- `src/lib/bot/flows/onboarding.ts` — etapa de calorie mode: oferecer apenas 2 opcoes
- `src/lib/llm/providers/openrouter.ts` e `ollama.ts` — remover branching por modo no prompt selection

### `scripts/seed-taco.ts`

- Atualizar com 581 alimentos extraidos do PDF
- Dados fonte: `docs/taco_foods_extracted.json` (ja extraido)

## Testes

### Novos testes

- `tests/unit/db/taco.test.ts` — fuzzy matching (match exato, match parcial, sem match, batch)
- `tests/unit/llm/decomposition.test.ts` — decomposicao de alimentos compostos
- `tests/unit/bot/history-reuse.test.ts` — busca e reutilizacao de dados do historico

### Testes a atualizar

- `tests/unit/bot/meal-log.test.ts` — novo fluxo com TACO lookup + decomposicao
- `tests/unit/llm/openrouter.test.ts` e `ollama.test.ts` — novo metodo `decomposeMeal`, schema ajustado
- `tests/unit/llm/schemas.test.ts` — `MealItemSchema` com macros opcionais, novo `DecompositionResultSchema`

## O que Nao Muda

- Onboarding (exceto opcoes de calorie_mode: 2 em vez de 3)
- Webhook
- Classificacao de intencao
- Fluxos sem LLM (summary, weight, help)
- Estrutura geral de tabelas
